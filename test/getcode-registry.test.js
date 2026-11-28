// Shared get-code registry (28 Nov 2026, cross-platform sync) — unit
// tests for the registry client in src/getcode.js and the registry flow
// in src/messenger-parity.js. No live network: the Telegram Worker
// endpoints are stubbed through the injected fetchImpl.
import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalGetCodePhone,
  getCodeRegistryKey,
  getCodeRegistryLookup,
  storeCodeRegistryEntry,
  deleteCodeRegistryEntry,
  GETCODE_REGISTRY_BASE_URL,
} from "../src/getcode.js";
import { GET_CODE_EXAMPLE_PHOTO_URL } from "../src/getcode.js";
import { createMessengerParity } from "../src/messenger-parity.js";

const ADMIN_PSID = "123456789012345";
const USER_PSID = "987654321098765";
const REGISTRY_SECRET = "test-registry-secret";
const PHONE_TYPED = "٠١٢٠٧٨٢٩٣٨٨"; // Arabic-Indic 01207829388
const PHONE_FOLDED = "01207829388";
const PHONE_CANONICAL = "201207829388";
const CODE = "9063955"; // fake macro: 20782938 + 1234567
const NAME = "لمياء وائل شرف";

// ---------------------------------------------------------------------------
// Canonical phone (Telegram's rule verbatim)
// ---------------------------------------------------------------------------

test("getcode registry: canonicalGetCodePhone folds to the 12-digit 20... form", () => {
  assert.equal(canonicalGetCodePhone("01207829388"), "201207829388", "11 digits starting with 0");
  assert.equal(canonicalGetCodePhone("+201207829388"), "201207829388", "12 digits starting with 20");
  assert.equal(canonicalGetCodePhone("201207829388"), "201207829388", "already canonical");
  assert.equal(canonicalGetCodePhone("1207829388"), "201207829388", "10 digits starting with 1");
  assert.equal(canonicalGetCodePhone("0101 234-5678"), "201012345678", "spaces and dashes are stripped");
  assert.equal(canonicalGetCodePhone("٠١٢٠٧٨٢٩٣٨٨"), "201207829388", "Arabic-Indic digits fold to Western");
  assert.equal(canonicalGetCodePhone("۰۱۲۰۷۸۲۹۳۸۸"), "201207829388", "Persian digits fold to Western");
  assert.equal(canonicalGetCodePhone("123"), null, "too short to canonicalize");
  assert.equal(canonicalGetCodePhone("12078293"), null, "8 digits have no canonical form");
  assert.equal(canonicalGetCodePhone(""), null);
  assert.equal(canonicalGetCodePhone(null), null);
  assert.equal(canonicalGetCodePhone("442071234567"), null, "a foreign number has no canonical form");
});

test("getcode registry: the key is getcode:registry:<canonicalPhone>", () => {
  assert.equal(getCodeRegistryKey("201207829388"), "getcode:registry:201207829388");
});

// ---------------------------------------------------------------------------
// Registry client (stubbed fetch)
// ---------------------------------------------------------------------------

function registryStubFetch({ entries = {}, fail = false, failGet = false } = {}) {
  const calls = [];
  const store = new Map(Object.entries(entries));
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    if (u.includes("/getcode-registry")) {
      const method = String(options.method ?? "GET").toUpperCase();
      const phone = method === "POST"
        ? JSON.parse(String(options.body ?? "{}")).phone
        : new URL(u).searchParams.get("phone");
      calls.push({ method, phone, auth: options.headers?.authorization ?? null, body: options.body !== undefined ? JSON.parse(String(options.body)) : undefined });
      if (fail || (failGet && method === "GET")) throw new Error("registry down");
      if (method === "GET") {
        const hit = store.get(String(phone));
        return { ok: true, json: async () => (hit ? { found: true, name: hit.name, code: hit.code } : { found: false }) };
      }
      if (method === "POST") {
        const b = JSON.parse(String(options.body ?? "{}"));
        store.set(String(b.phone), { name: b.name, code: b.code });
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (method === "DELETE") {
        store.delete(String(phone));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: false, json: async () => null };
    }
    // Anything else (should not happen — no OCR key in these tests).
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) };
  };
  fetchImpl.calls = calls;
  fetchImpl.store = store;
  return fetchImpl;
}

test("getcode registry client: lookup hit returns name+code and sends the Bearer secret", async () => {
  const fetchImpl = registryStubFetch({ entries: { [PHONE_CANONICAL]: { name: NAME, code: CODE } } });
  const hit = await getCodeRegistryLookup(PHONE_CANONICAL, { secret: REGISTRY_SECRET, fetchImpl });
  assert.deepEqual(hit, { found: true, name: NAME, code: CODE });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].method, "GET");
  assert.equal(fetchImpl.calls[0].phone, PHONE_CANONICAL);
  assert.equal(fetchImpl.calls[0].auth, `Bearer ${REGISTRY_SECRET}`);
  assert.ok(String(fetchImpl.calls[0].phone).startsWith("20"), "the lookup key is canonical");
});

test("getcode registry client: lookup miss returns {found:false}", async () => {
  const fetchImpl = registryStubFetch({ entries: {} });
  assert.deepEqual(await getCodeRegistryLookup(PHONE_CANONICAL, { secret: REGISTRY_SECRET, fetchImpl }), { found: false });
});

test("getcode registry client: any error fails open to a miss, never throws", async () => {
  const throwing = registryStubFetch({ fail: true });
  assert.deepEqual(await getCodeRegistryLookup(PHONE_CANONICAL, { secret: REGISTRY_SECRET, fetchImpl: throwing }), { found: false });
  const badStatus = async () => ({ ok: false, json: async () => null });
  assert.deepEqual(await getCodeRegistryLookup(PHONE_CANONICAL, { secret: REGISTRY_SECRET, fetchImpl: badStatus }), { found: false });
  const badJson = async () => ({ ok: true, json: async () => { throw new Error("bad json"); } });
  assert.deepEqual(await getCodeRegistryLookup(PHONE_CANONICAL, { secret: REGISTRY_SECRET, fetchImpl: badJson }), { found: false });
});

test("getcode registry client: no secret means no call at all", async () => {
  const fetchImpl = registryStubFetch({ entries: { [PHONE_CANONICAL]: { name: NAME, code: CODE } } });
  assert.deepEqual(await getCodeRegistryLookup(PHONE_CANONICAL, { secret: null, fetchImpl }), { found: false });
  assert.equal(await storeCodeRegistryEntry(PHONE_CANONICAL, NAME, CODE, { secret: "", fetchImpl }), false);
  assert.equal(await deleteCodeRegistryEntry(PHONE_CANONICAL, { fetchImpl }), false);
  assert.equal(fetchImpl.calls.length, 0, "nothing is fetched without a secret");
});

test("getcode registry client: store and delete round-trip, errors fail open", async () => {
  const fetchImpl = registryStubFetch({ entries: {} });
  assert.equal(await storeCodeRegistryEntry(PHONE_CANONICAL, NAME, CODE, { secret: REGISTRY_SECRET, fetchImpl }), true);
  assert.deepEqual(fetchImpl.store.get(PHONE_CANONICAL), { name: NAME, code: CODE });
  assert.equal(await deleteCodeRegistryEntry(PHONE_CANONICAL, { secret: REGISTRY_SECRET, fetchImpl }), true);
  assert.equal(fetchImpl.store.has(PHONE_CANONICAL), false);
  const throwing = registryStubFetch({ fail: true });
  assert.equal(await storeCodeRegistryEntry(PHONE_CANONICAL, NAME, CODE, { secret: REGISTRY_SECRET, fetchImpl: throwing }), false);
  assert.equal(await deleteCodeRegistryEntry(PHONE_CANONICAL, { secret: REGISTRY_SECRET, fetchImpl: throwing }), false);
});

test("getcode registry client: base URL defaults to the Telegram Worker", () => {
  assert.equal(GETCODE_REGISTRY_BASE_URL, "https://coptic-dictionary-bot.abr429701.workers.dev");
});

// ---------------------------------------------------------------------------
// Registry flow (parity, stubbed fetch + fake macro)
// ---------------------------------------------------------------------------

function fakeMacro(name, phone) {
  const last8 = String(phone ?? "").slice(-8);
  return { code: String(parseInt(last8, 10) + 1234567), error: null };
}

function makeParity(deps = {}) {
  const macroCalls = [];
  const parity = createMessengerParity({
    adminPsids: [ADMIN_PSID],
    certLookup: async () => ({ kind: "not-found" }),
    getCode: async (name, phone) => {
      macroCalls.push({ name, phone });
      return (deps.getCode ?? fakeMacro)(name, phone);
    },
    macroUrl: "https://macro.test/exec",
    getcodeRegistrySecret: deps.registrySecret ?? null,
    fetchImpl: deps.fetchImpl ?? null,
  });
  parity.macroCalls = macroCalls;
  return parity;
}

async function runFullFlow(parity, psid = USER_PSID) {
  await parity.handleText(psid, "/getcode");
  await parity.handleText(psid, PHONE_TYPED);
  return parity.handleText(psid, NAME);
}

test("getcode registry flow: hit greets immediately — no name question, no macro call", async () => {
  const fetchImpl = registryStubFetch({ entries: { [PHONE_CANONICAL]: { name: NAME, code: CODE } } });
  const parity = makeParity({ registrySecret: REGISTRY_SECRET, fetchImpl });
  await parity.handleText(USER_PSID, "/getcode");
  const greet = await parity.handleText(USER_PSID, PHONE_TYPED);
  assert.match(greet.texts[0].text, new RegExp(`مرحباً ${NAME}، الرقم الكودي الخاص بك هو ${CODE}`, "u"));
  assert.doesNotMatch(greet.texts[0].text, /اسمك الثلاثي/u, "no name question on a hit");
  assert.equal(parity.macroCalls.length, 0, "no macro call on a hit");
  assert.equal(fetchImpl.calls.filter((c) => c.method === "GET").length, 1);
  assert.equal(fetchImpl.calls[0].phone, PHONE_CANONICAL, "the lookup uses the canonical phone");
  // The hit wrote the record as activated, so a later /getcode still greets.
  const again = await parity.handleText(USER_PSID, "/getcode");
  assert.match(again.texts[0].text, /مرحباً/u, "a registry hit stays greeted");
  assert.equal(parity.macroCalls.length, 0);
});

test("getcode registry flow: miss asks the name, then the macro, then the success reply", async () => {
  const fetchImpl = registryStubFetch({ entries: {} });
  const parity = makeParity({ registrySecret: REGISTRY_SECRET, fetchImpl });
  await parity.handleText(USER_PSID, "/getcode");
  const askName = await parity.handleText(USER_PSID, PHONE_TYPED);
  assert.match(askName.texts[0].text, /اسمك الثلاثي/u, "a miss moves on to the name question");
  const done = await parity.handleText(USER_PSID, NAME);
  assert.ok(done.texts[0].text.startsWith("لتفعيل اشتراكك"), "the success notice follows the macro");
  assert.equal(done.getCodePhotoReply, true);
  assert.equal(parity.macroCalls.length, 1, "the macro runs once on a miss");
  assert.equal(parity.macroCalls[0].phone, PHONE_FOLDED, "the macro gets the folded phone as typed, never the canonical form");
  assert.equal(fetchImpl.calls.filter((c) => c.method === "POST").length, 0, "no registry write at macro-success time");
});

test("getcode registry flow: registry error fails open to the miss path", async () => {
  const fetchImpl = registryStubFetch({ failGet: true });
  const parity = makeParity({ registrySecret: REGISTRY_SECRET, fetchImpl });
  await parity.handleText(USER_PSID, "/getcode");
  const askName = await parity.handleText(USER_PSID, PHONE_TYPED);
  assert.match(askName.texts[0].text, /اسمك الثلاثي/u, "a registry outage never strands the student");
});

test("getcode registry flow: a non-canonical phone is re-asked and the registry is never called", async () => {
  const fetchImpl = registryStubFetch({ entries: {} });
  const parity = makeParity({ registrySecret: REGISTRY_SECRET, fetchImpl });
  await parity.handleText(USER_PSID, "/getcode");
  const retry = await parity.handleText(USER_PSID, "١٢٠٧٨٢٩٣");
  assert.match(retry.texts[0].text, /٤ أرقام على الأقل/u);
  assert.equal(fetchImpl.calls.length, 0, "no lookup without a canonical phone");
});

test("getcode registry flow: the entry is written ONLY at activation, never at macro success", async () => {
  const fetchImpl = registryStubFetch({ entries: {} });
  const parity = makeParity({ registrySecret: REGISTRY_SECRET, fetchImpl });
  await runFullFlow(parity);
  assert.equal(fetchImpl.calls.filter((c) => c.method === "POST").length, 0, "macro success alone writes nothing");
  const shot = await parity.handleImage(USER_PSID);
  assert.match(shot.texts[0].text, new RegExp(`تم تفعيل اشتراكك عزيزنا ${NAME} والرقم الكودي الخاص بك هو: ${CODE}`, "u"));
  const posts = fetchImpl.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1, "exactly one write, at activation time");
  assert.deepEqual(posts[0].body, { phone: PHONE_CANONICAL, name: NAME, code: CODE });
});

test("getcode registry flow: never-activated record + /getcode reveals NO code — the wait re-opens and the notice is re-sent", async () => {
  const fetchImpl = registryStubFetch({ entries: {} });
  const parity = makeParity({ registrySecret: REGISTRY_SECRET, fetchImpl });
  await runFullFlow(parity);
  const again = await parity.handleText(USER_PSID, "/getcode");
  assert.doesNotMatch(again.texts[0].text, /مرحباً/u, "no greeting with the code before activation");
  assert.doesNotMatch(again.texts[0].text, /الرقم الكودي الخاص بك هو:/u, "the code is never revealed before the screenshot");
  assert.match(again.texts[0].text, /لتفعيل اشتراكك/u, "the notice is re-sent so the student uploads the screenshot");
  assert.equal(again.getCodePhotoReply, true, "the notice rides the direct send with the example photo");
  assert.equal(again.attachments?.[0]?.url, GET_CODE_EXAMPLE_PHOTO_URL);
  // The wait re-opened: a screenshot now completes the activation.
  const shot = await parity.handleImage(USER_PSID);
  assert.match(shot.texts[0].text, /تم تفعيل اشتراكك/u);
  // And now the greeting works — the student is activated.
  const greeted = await parity.handleText(USER_PSID, "/getcode");
  assert.match(greeted.texts[0].text, new RegExp(`مرحباً ${NAME}، الرقم الكودي الخاص بك هو ${CODE}`, "u"));
});

test("getcode registry flow: activated record + /getcode greets with the code", async () => {
  const fetchImpl = registryStubFetch({ entries: {} });
  const parity = makeParity({ registrySecret: REGISTRY_SECRET, fetchImpl });
  await runFullFlow(parity);
  await parity.handleImage(USER_PSID);
  const greeted = await parity.handleText(USER_PSID, "/getcode");
  assert.match(greeted.texts[0].text, new RegExp(`مرحباً ${NAME}، الرقم الكودي الخاص بك هو ${CODE}`, "u"));
});

test("getcode registry flow: /resetcode deletes the registry entry when the record has a phone", async () => {
  const fetchImpl = registryStubFetch({ entries: {} });
  const parity = makeParity({ registrySecret: REGISTRY_SECRET, fetchImpl });
  await parity.handleText(ADMIN_PSID, "/getcode");
  await parity.handleText(ADMIN_PSID, PHONE_TYPED);
  await parity.handleText(ADMIN_PSID, "ابرام مرزق");
  await parity.handleImage(ADMIN_PSID); // activates → POST the entry
  assert.equal(fetchImpl.calls.filter((c) => c.method === "POST").length, 1);
  const reset = await parity.handleText(ADMIN_PSID, "/resetcode");
  assert.equal(reset.texts[0].text, "تم مسح الرقم الكودي المسجّل — ابعت /getcode من الأول.");
  const deletes = fetchImpl.calls.filter((c) => c.method === "DELETE");
  assert.equal(deletes.length, 1, "exactly one DELETE, on reset");
  assert.equal(deletes[0].phone, PHONE_CANONICAL);
  // The next /getcode re-runs the full flow instead of greeting from the registry.
  const fresh = await parity.handleText(ADMIN_PSID, "/getcode");
  assert.match(fresh.texts[0].text, /اكتب رقم موبايلك/u);
  assert.doesNotMatch(fresh.texts[0].text, /مرحباً/u);
});
