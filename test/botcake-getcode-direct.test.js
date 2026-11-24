// Get-code direct send (live bug 24 Nov 2026): in the Messenger bot a
// user types their name, then their phone number, and the code NEVER
// arrives — the Worker builds the correct envelope (code + WhatsApp
// link) but sends nothing directly, and the Botcake flow drops the text
// (it reads its saved reply fields one run stale). Same bug as the
// word-card text (23 Nov) and the name-completion welcome (24 Nov),
// same fix: the Worker sends the reply text directly and clears the
// envelope so the flow sends nothing (no double). The macro-failure
// fallback rides the direct send too — otherwise the student gets
// silence instead of the registration instructions.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { UserStore } from "../src/index.js";
import { MESSENGER_SEND_URL } from "../src/messenger.js";

const BOTCAKE_SECRET = "test-botcake-secret";
const PAGE_TOKEN = "test-page-token";
const PSID = "555000111333";
const MACRO_URL = "https://macro.test/exec";

function fakeKv() {
  const store = new Map();
  const storage = {
    get: async (key) => store.get(key),
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix = "", startAfter, limit } = {}) => {
      let entries = [...store].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (startAfter) entries = entries.filter(([key]) => key > startAfter);
      return new Map(limit ? entries.slice(0, limit) : entries);
    },
    setAlarm: async () => {},
  };
  const object = new UserStore({ storage }, {});
  return {
    store,
    object,
    idFromName: (name) => name,
    get: () => ({ fetch: (url, options) => object.fetch(new Request(url, options)) }),
  };
}

function recordingFetch(calls, macroResponse) {
  return async (url, options = {}) => {
    let body = null;
    try { body = JSON.parse(options.body ?? "null"); } catch { body = null; }
    calls.push({ url: String(url), method: options.method ?? "GET", body });
    if (String(url) === MACRO_URL) return Response.json(macroResponse);
    return Response.json({ recipient_id: PSID, message_id: "mid.test-1" });
  };
}

async function postBotcake(body, kv, calls, macroResponse) {
  const restoreFetch = globalThis.fetch;
  globalThis.fetch = recordingFetch(calls, macroResponse);
  const tasks = [];
  const ctx = { waitUntil: (p) => { tasks.push(p); return p; } };
  try {
    const response = await worker.fetch(new Request("https://bot.test/botcake", {
      method: "POST",
      headers: { "content-type": "application/json", "x-botcake-secret": BOTCAKE_SECRET },
      body: JSON.stringify(body),
    }), {
      BOTCAKE_SECRET,
      MESSENGER_PAGE_TOKEN: PAGE_TOKEN,
      APPS_SCRIPT_URL: MACRO_URL,
      USERS: kv,
      RECORDED_AUDIO_BASE_URL: "https://example.r2.dev",
    }, ctx);
    assert.equal(response.status, 200);
    const envelope = await response.json();
    await Promise.allSettled(tasks);
    return { envelope, tasks };
  } finally {
    globalThis.fetch = restoreFetch;
  }
}

function directTextSends(calls) {
  return calls.filter((c) => c.url === MESSENGER_SEND_URL && typeof c.body?.message?.text === "string");
}

function seedGetCodePhone(kv) {
  kv.store.set(`user:msgr:${PSID}`, {
    name: "Tester",
    parity: { getcodeStep: "phone", getcodeName: "أحمد محمد" },
  });
}

// Success: the macro returns a code — it must go out directly, with the
// WhatsApp link, and the envelope must be cleared (no double).
test("get-code phone turn: code sent directly, envelope cleared", async () => {
  const kv = fakeKv();
  seedGetCodePhone(kv);
  const calls = [];
  const { envelope } = await postBotcake(
    { psid: PSID, text: "01289254084" },
    kv,
    calls,
    { success: true, code: "90488651", message: "ok" },
  );
  assert.equal(envelope.text, "", "envelope text cleared after direct send");
  assert.equal(envelope.has_text, "no");
  assert.equal(envelope.quick_replies, "", "envelope quick replies cleared");
  const direct = directTextSends(calls);
  assert.ok(direct.length >= 1, "code reply sent directly");
  const allDirect = direct.map((d) => d.body.message.text).join("\n");
  assert.match(allDirect, /90488651/u, "direct sends carry the code");
  assert.match(allDirect, /الرقم الكودي الخاص بك هو/u, "direct sends carry the code line");
  assert.match(allDirect, /wa\.me\/201207829388\?text=/u, "direct sends carry the WhatsApp link");
  const last = direct[direct.length - 1];
  assert.deepEqual(
    (last.body.message.quick_replies ?? []).map((q) => q.title),
    ["البداية", "تعلّم", "القائمة", "كلمة عشوائية", "تواصل معنا"],
    "five navigation buttons ride on the last chunk",
  );
});

// Macro failure: the fallback instructions must go out directly too —
// otherwise the student gets silence instead of the registration link.
test("get-code macro failure: fallback sent directly, envelope cleared", async () => {
  const kv = fakeKv();
  seedGetCodePhone(kv);
  const calls = [];
  const { envelope } = await postBotcake(
    { psid: PSID, text: "01289254084" },
    kv,
    calls,
    { success: false },
  );
  assert.equal(envelope.text, "", "envelope text cleared after direct send");
  assert.equal(envelope.has_text, "no");
  const direct = directTextSends(calls);
  assert.ok(direct.length >= 1, "fallback sent directly");
  const allDirect = direct.map((d) => d.body.message.text).join("\n");
  assert.match(allDirect, /تعذّر إحضار الرقم الكودي/u, "direct sends carry the fallback");
});
