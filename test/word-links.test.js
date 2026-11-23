// /links, word share links, and word_<id> deep links — POST /botcake
// round-trips (the live Botcake path), plus the /menu wiring for /links.
// No live network: the Send API (typing indicator) is stubbed, the DO
// store is the same in-memory UserStore fake messenger.test.js uses.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { UserStore } from "../src/index.js";
import { LINKS_TEXT } from "../src/messenger-parity.js";
import records from "../data/dictionary.json" with { type: "json" };

const BOTCAKE_SECRET = "test-botcake-secret";
const SENDER_ID = "987654321";

// ⲁⲅⲁⲡⲏⲧⲟⲥ has 4 meaning parts (حبيب، محبوب، مُحب، عزيز) — the
// multi-meaning word the «معنى آخر» test in messenger.test.js uses.
const AGAPETOS_ID = 25374;
const AGAPETOS_SHARE = `🔗 شارك الكلمة: https://m.me/Copticdictionary?ref=word_${AGAPETOS_ID}`;
const NO_RESULT_TEXT = "لا توجد نتائج حالياً لهذه الكلمة.";

function botcakeEnv() {
  return { BOTCAKE_SECRET, USERS: fakeKv() };
}

// A Botcake env with the test user already registered, so word searches
// exercise search — not the new-user name gate (a brand-new user's
// first word gets the name prompt instead).
function registeredBotcakeEnv() {
  const kv = fakeKv();
  kv.store.set(`user:msgr:${SENDER_ID}`, { name: "اختبار المستخدم", registeredAt: "2026-11-23T00:00:00.000Z" });
  return { BOTCAKE_SECRET, USERS: kv };
}

// In-memory UserStore Durable Object (same shape as messenger.test.js).
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

// Stub the Send API (the typing indicator) — answer like Meta.
function stubFetch() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ recipient_id: SENDER_ID, message_id: "mid.test-1" });
  return () => { globalThis.fetch = realFetch; };
}

async function postBotcake(body, envOverride) {
  const restore = stubFetch();
  try {
    const response = await worker.fetch(new Request("https://bot.test/botcake", {
      method: "POST",
      headers: { "content-type": "application/json", "x-botcake-secret": BOTCAKE_SECRET },
      body: JSON.stringify(body),
    }), envOverride);
    assert.equal(response.status, 200);
    return await response.json();
  } finally {
    restore();
  }
}

const envelopeText = (envelope) => [envelope.text, envelope.text2, envelope.text3].filter(Boolean).join("\n");

test("/links returns all five cross-platform links exactly", async () => {
  const envelope = await postBotcake({ psid: SENDER_ID, text: "/links" }, botcakeEnv());
  assert.equal(envelopeText(envelope), LINKS_TEXT);
  assert.ok(envelopeText(envelope).includes("https://is.gd/copticdictionary"), "app link");
  assert.ok(envelopeText(envelope).includes("https://copticdictionry.neocities.org/"), "website link");
  assert.ok(envelopeText(envelope).includes("https://t.me/Coptic_Dictionary_bot"), "telegram link");
  assert.ok(envelopeText(envelope).includes("https://m.me/Copticdictionary"), "messenger link");
  assert.ok(envelopeText(envelope).includes("https://wa.me/message/WSYPILDL7WV7C1"), "whatsapp link");
  assert.ok(!envelopeText(envelope).includes("<b>"), "no bold markers");
  const hasDirectionMarks = [...envelopeText(envelope)].some((ch) => ch === "\u200E" || ch === "\u200F");
  assert.ok(!hasDirectionMarks, "no direction marks");
});

test("/menu lists روابط المنصات, and picking it (number 6 or payload) returns /links", async () => {
  const envOverride = botcakeEnv();
  const menu = await postBotcake({ psid: SENDER_ID, text: "/menu" }, envOverride);
  assert.ok(envelopeText(menu).includes("6. 🔗 روابط المنصات"), "menu lists the links item");
  assert.ok(!envelopeText(menu).includes("شارك الكلمة"), "menu carries no share line");
  const byNumber = await postBotcake({ psid: SENDER_ID, text: "6" }, envOverride);
  assert.equal(envelopeText(byNumber), LINKS_TEXT);
  const byPayload = await postBotcake({ psid: SENDER_ID, text: "", payload: "learn|links" }, envOverride);
  assert.equal(envelopeText(byPayload), LINKS_TEXT);
});

test("a word card carries the share line with its m.me ref link", async () => {
  const envOverride = registeredBotcakeEnv();
  await postBotcake({ psid: SENDER_ID, text: "ⲁⲅⲁⲡⲏ" }, envOverride);
  const pick = await postBotcake({ psid: SENDER_ID, text: "2" }, envOverride);
  const first = envelopeText(pick);
  assert.ok(first.includes("حبيب"), "first card shows the first meaning");
  assert.ok(first.includes(AGAPETOS_SHARE), "initial card carries the share line");
  // Stepped-meaning card: same word, same share line.
  const second = envelopeText(await postBotcake({ psid: SENDER_ID, text: "معنى آخر" }, envOverride));
  assert.ok(second.includes("محبوب"), "second step shows the second meaning");
  assert.ok(second.includes(AGAPETOS_SHARE), "stepped card carries the same share line");
});

test("text word_<id> opens that word's card directly", async () => {
  const envelope = await postBotcake({ psid: SENDER_ID, text: `word_${AGAPETOS_ID}` }, botcakeEnv());
  const text = envelopeText(envelope);
  assert.ok(text.includes("ⲁⲅⲁⲡⲏⲧⲟⲥ"), "card shows the word's Coptic headword");
  assert.ok(text.includes("حبيب"), "card shows the first meaning");
  assert.ok(text.includes(AGAPETOS_SHARE), "deep-linked card carries the share line");
});

test("text word_<id>_<lang> renders the card in that language", async () => {
  const envelope = await postBotcake({ psid: SENDER_ID, text: `word_${AGAPETOS_ID}_en` }, botcakeEnv());
  const text = envelopeText(envelope);
  assert.ok(text.includes("beloved"), "English card shows the English translation");
  assert.ok(text.includes("Word:"), "English card uses English labels");
  assert.ok(text.includes(AGAPETOS_SHARE), "language card carries the share line");
});

test("payload word_<id> opens that word's card directly", async () => {
  const envelope = await postBotcake({ psid: SENDER_ID, text: "", payload: `word_${AGAPETOS_ID}` }, botcakeEnv());
  const text = envelopeText(envelope);
  assert.ok(text.includes("ⲁⲅⲁⲡⲏⲧⲟⲥ"), "payload card shows the word's Coptic headword");
  assert.ok(text.includes(AGAPETOS_SHARE), "payload card carries the share line");
});

test("word_<unknown id> answers with the standard no-result text", async () => {
  const byText = await postBotcake({ psid: SENDER_ID, text: "word_999999999" }, botcakeEnv());
  assert.equal(envelopeText(byText), NO_RESULT_TEXT);
  const byPayload = await postBotcake({ psid: SENDER_ID, text: "", payload: "word_999999999" }, botcakeEnv());
  assert.equal(envelopeText(byPayload), NO_RESULT_TEXT);
});

test("the share line never appears on a suggestion list or on /menu", async () => {
  const envOverride = registeredBotcakeEnv();
  const list = await postBotcake({ psid: SENDER_ID, text: "ⲁⲅⲁⲡⲏ" }, envOverride);
  assert.ok(envelopeText(list).includes("اختر من الاقتراحات التالية:"), "search returns a suggestion list");
  assert.ok(!envelopeText(list).includes("شارك الكلمة"), "suggestion list carries no share line");
  const menu = await postBotcake({ psid: SENDER_ID, text: "/menu" }, envOverride);
  assert.ok(!envelopeText(menu).includes("شارك الكلمة"), "/menu carries no share line");
});

test("word_<id> resolves against the real dictionary ids", () => {
  const record = records.find((r) => Number(r.id) === AGAPETOS_ID);
  assert.ok(record, "the test word id exists in the dictionary");
  assert.equal(String(record.meaning).split("،")[0].trim(), "حبيب");
  assert.ok(!records.some((r) => Number(r.id) === 999999999), "the unknown test id has no record");
});
