// Word-card direct send (live bug 23 Nov 2026): picking a suggestion
// returned only the voice — the Botcake flow drops the card text on pick
// turns (it reads its saved reply fields one run stale), while the voice,
// sent directly by the Worker, always arrives. The Worker now sends the
// card text directly too and clears the envelope text so the flow sends
// nothing (no double); a failed send leaves the text in the envelope so
// the flow tries as a fallback. The name-gate prompt is not a word card,
// so a brand-new user still gets FIRST_TIME_TEXT first.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { UserStore } from "../src/index.js";
import { MESSENGER_SEND_URL } from "../src/messenger.js";

const BOTCAKE_SECRET = "test-botcake-secret";
const PAGE_TOKEN = "test-page-token";
const PSID = "555000111333";

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

function recordingFetch(calls) {
  return async (url, options = {}) => {
    let body = null;
    try { body = JSON.parse(options.body ?? "null"); } catch { body = null; }
    calls.push({ url: String(url), method: options.method ?? "GET", body });
    return Response.json({ recipient_id: PSID, message_id: "mid.test-1" });
  };
}

async function postBotcake(body, kv, calls) {
  const restoreFetch = globalThis.fetch;
  globalThis.fetch = recordingFetch(calls);
  const tasks = [];
  const ctx = { waitUntil: (p) => { tasks.push(p); return p; } };
  try {
    const response = await worker.fetch(new Request("https://bot.test/botcake", {
      method: "POST",
      headers: { "content-type": "application/json", "x-botcake-secret": BOTCAKE_SECRET },
      body: JSON.stringify(body),
    }), { BOTCAKE_SECRET, MESSENGER_PAGE_TOKEN: PAGE_TOKEN, USERS: kv, RECORDED_AUDIO_BASE_URL: "https://example.r2.dev" }, ctx);
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

// Registered user: search (list) then pick — the card text must go out
// directly from the Worker and the envelope text must be cleared.
test("existing user pick: card text sent directly, envelope text cleared", async () => {
  const kv = fakeKv();
  kv.store.set(`user:msgr:${PSID}`, { name: "Tester" });
  const calls = [];
  await postBotcake({ psid: PSID, text: "مال" }, kv, calls);
  calls.length = 0;
  const { envelope } = await postBotcake({ psid: PSID, text: "1" }, kv, calls);
  // The flow must have nothing to send (no double).
  assert.equal(envelope.text, "", "envelope text cleared after direct send");
  assert.equal(envelope.has_text, "no");
  assert.equal(envelope.quick_replies, "", "envelope quick replies cleared");
  // The voice still goes out via the Worker (envelope keeps its URL).
  assert.ok(envelope.voice_url, "voice_url stays in the envelope for the Worker send");
  // The Worker sent the card text directly, with the five navigation
  // buttons the flow's Content #7 normally attaches.
  const direct = directTextSends(calls);
  assert.equal(direct.length, 1, "exactly one direct text send for the card");
  const card = direct[0].body.message.text;
  assert.match(card, /الكلمة:/u, "card carries the headword");
  assert.match(card, /المعنى:/u, "card carries the meaning");
  assert.match(card, /النوع:/u, "card carries the kind");
  assert.match(card, /الأصل:/u, "card carries the origin");
  const replies = direct[0].body.message.quick_replies ?? [];
  assert.deepEqual(replies.map((q) => q.title), ["البداية", "تعلّم", "القائمة", "كلمة عشوائية", "تواصل معنا"]);
});

// Name completion (live bug 23 Nov 2026): a new user types their name
// after the prompt — the name is saved and the envelope carries the
// welcome + help, but the Worker sent nothing directly and the flow
// dropped it, so the user got total silence and could leave the bot.
// The welcome must now go out directly and the envelope must be cleared
// (no double from the flow).
test("new user name completion: welcome sent directly, envelope cleared", async () => {
  const kv = fakeKv();
  const calls = [];
  await postBotcake({ psid: PSID, text: "مال" }, kv, calls);
  calls.length = 0;
  const { envelope } = await postBotcake({ psid: PSID, text: "أحمد محمد" }, kv, calls);
  assert.equal(envelope.text, "", "envelope text cleared after direct send");
  assert.equal(envelope.has_text, "no");
  assert.equal(envelope.quick_replies, "", "envelope quick replies cleared");
  const direct = directTextSends(calls);
  assert.ok(direct.length >= 2, "welcome + help sent directly");
  assert.match(direct[0].body.message.text, /مرحبًا بك أحمد محمد/u, "first direct send is the welcome caption");
  const allDirect = direct.map((d) => d.body.message.text).join("\n");
  assert.match(allDirect, /القاموس القبطي — المساعدة/u, "the help text goes out across the direct sends");
  const last = direct[direct.length - 1];
  assert.ok((last.body.message.quick_replies ?? []).length > 0, "quick replies ride on the last chunk");
});

// A brand-new user's first word still gets the name prompt, not a card —
// the word-card block must not fire (and must not duplicate the
// first-ever direct send).
test("new user first word: name prompt only, no word-card double send", async () => {
  const kv = fakeKv();
  const calls = [];
  const { envelope } = await postBotcake({ psid: PSID, text: "مال" }, kv, calls);
  assert.match(envelope.text, /الرجاء إدخال اسمك/u, "envelope carries the name prompt");
  const direct = directTextSends(calls);
  assert.equal(direct.length, 1, "exactly one direct send (first-ever only)");
  assert.match(direct[0].body.message.text, /الرجاء إدخال اسمك/u, "direct send is the name prompt");
});

// A non-card reply (the suggestions list) still goes through the flow:
// the Worker sends nothing directly and the envelope keeps the text.
test("suggestions list: no direct send, envelope keeps the text", async () => {
  const kv = fakeKv();
  kv.store.set(`user:msgr:${PSID}`, { name: "Tester" });
  const calls = [];
  const { envelope } = await postBotcake({ psid: PSID, text: "مال" }, kv, calls);
  assert.match(envelope.text, /اختر من الاقتراحات التالية:/u, "envelope carries the list");
  assert.equal(envelope.has_text, "yes");
  assert.equal(directTextSends(calls).length, 0, "no direct send for a list");
});
