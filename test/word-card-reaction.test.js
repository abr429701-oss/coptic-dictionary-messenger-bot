// Word-card ❤️ reaction — the bot love-reacts the user's message when
// it shows a word card (search pick, deep link, /random, /wod, meaning
// step), and never for menus, lists, help, admin, learn, errors or
// no-result turns. The reaction is a direct Graph call on the incoming
// message's id — 0 Botcake messages, 0 Worker requests beyond the call
// itself — and best-effort: it never blocks, delays or breaks the card.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { UserStore, parseBotcakeInput } from "../src/index.js";
import {
  handleMessengerMessaging,
  sendMessengerReaction,
  MESSENGER_SEND_URL,
  MESSENGER_GRAPH_BASE_URL,
} from "../src/messenger.js";

const BOTCAKE_SECRET = "test-secret";
const SENDER_ID = "987654321";
const PAGE_ID = "201014403093272";
const PAGE_TOKEN = "test-page-token";
const MID = "mid.live-1";
const AGAPETOS_ID = 25374;
const REACTIONS_URL = `${MESSENGER_GRAPH_BASE_URL}/${encodeURIComponent(MID)}/reactions`;

// In-memory UserStore Durable Object (same shape as word-links.test.js).
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

// Recording fetch stub: every Graph call answers like Meta, and every
// call is recorded (url + parsed body) so tests can assert exactly which
// Graph calls a turn made. The reaction waitUntil callback fires
// synchronously up to its first await, so a reactions call is already
// recorded by the time worker.fetch resolves — no timers to await.
function recordingFetch(calls, reactionAnswer = { success: true }) {
  return async (url, options = {}) => {
    let body = null;
    try { body = JSON.parse(options.body ?? "null"); } catch { body = null; }
    calls.push({ url: String(url), method: options.method ?? "GET", body });
    if (String(url).includes("/reactions")) return Response.json(reactionAnswer);
    return Response.json({ recipient_id: SENDER_ID, message_id: "mid.test-1" });
  };
}

async function postBotcake(body, kv, calls, reactionAnswer) {
  const restoreFetch = globalThis.fetch;
  globalThis.fetch = recordingFetch(calls, reactionAnswer);
  const tasks = [];
  const ctx = { waitUntil: (p) => { tasks.push(p); return p; } };
  try {
    const response = await worker.fetch(new Request("https://bot.test/botcake", {
      method: "POST",
      headers: { "content-type": "application/json", "x-botcake-secret": BOTCAKE_SECRET },
      body: JSON.stringify(body),
    }), { BOTCAKE_SECRET, MESSENGER_PAGE_TOKEN: PAGE_TOKEN, USERS: kv }, ctx);
    assert.equal(response.status, 200);
    const envelope = await response.json();
    // Await the background tasks BEFORE restoring the real fetch, so the
    // delayed voice send (~3 s) still hits the recording stub instead of
    // the live Graph API with a fake token (which would log 401 noise).
    await Promise.allSettled(tasks);
    return { envelope, tasks };
  } finally {
    globalThis.fetch = restoreFetch;
  }
}

function seedNamedUser(kv, psid = SENDER_ID) {
  kv.store.set(`user:msgr:${psid}`, { name: "Ebram" });
}

// --- sendMessengerReaction ------------------------------------------------

test("reaction: posts LOVE to the message reactions edge with the Page token", async () => {
  const calls = [];
  const env = { MESSENGER_PAGE_TOKEN: PAGE_TOKEN };
  const result = await sendMessengerReaction(env, MID, "LOVE", recordingFetch(calls));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, REACTIONS_URL);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { reaction: "LOVE" });
});

test("reaction: missing token or missing message id never calls the API", async () => {
  const calls = [];
  const fetchImpl = recordingFetch(calls);
  assert.deepEqual(await sendMessengerReaction({}, MID, "LOVE", fetchImpl), { ok: false, error: "missing-page-token" });
  assert.deepEqual(await sendMessengerReaction({ MESSENGER_PAGE_TOKEN: PAGE_TOKEN }, "", "LOVE", fetchImpl), { ok: false, error: "missing-message-id" });
  assert.deepEqual(await sendMessengerReaction({ MESSENGER_PAGE_TOKEN: PAGE_TOKEN }, null, "LOVE", fetchImpl), { ok: false, error: "missing-message-id" });
  assert.equal(calls.length, 0);
});

test("reaction: a failed call returns ok:false and never throws", async () => {
  const env = { MESSENGER_PAGE_TOKEN: PAGE_TOKEN };
  const networkFail = async () => { throw new Error("down"); };
  assert.deepEqual(await sendMessengerReaction(env, MID, "LOVE", networkFail), { ok: false, error: "network" });
  const metaFail = async () => Response.json({ error: { message: "bad id" } }, { status: 400 });
  const failed = await sendMessengerReaction(env, MID, "LOVE", metaFail);
  assert.equal(failed.ok, false);
  const noSuccess = async () => Response.json({ ok: true });
  assert.equal((await sendMessengerReaction(env, MID, "LOVE", noSuccess)).ok, false);
});

// --- Webhook transport (the only live path that carries a message id) -----

function webhookEnv() {
  return { MESSENGER_PAGE_TOKEN: PAGE_TOKEN };
}

function webhookEvent(mid, text = "hello") {
  return {
    sender: { id: SENDER_ID },
    recipient: { id: PAGE_ID },
    timestamp: 1794791000000,
    message: mid ? { mid, text } : { text },
  };
}

test("webhook: a word card love-reacts the user's message, after the card", async () => {
  const calls = [];
  const fetchImpl = recordingFetch(calls);
  const planFor = {
    text: async () => ({ texts: [{ text: "الكلمة: ⲁⲅⲁⲡⲏⲧⲟⲥ" }], voiceUrl: null, wordCard: true }),
    pick: async () => null,
  };
  const sent = await handleMessengerMessaging(webhookEnv(), webhookEvent(MID), planFor, fetchImpl);
  assert.equal(sent, true);
  const reaction = calls.find((c) => c.url === REACTIONS_URL);
  assert.ok(reaction, "a reactions call was made");
  assert.deepEqual(reaction.body, { reaction: "LOVE" });
  // The card text went out on the Send API before the reaction.
  const textCall = calls.find((c) => c.url === MESSENGER_SEND_URL && c.body?.message?.text);
  assert.ok(textCall, "the card text was sent");
  assert.ok(calls.indexOf(textCall) < calls.indexOf(reaction), "the card lands before the reaction");
});

test("webhook: a word card with a voice still reacts (reaction before voice)", async () => {
  const calls = [];
  const fetchImpl = recordingFetch(calls);
  const planFor = {
    text: async () => ({ texts: [{ text: "الكلمة: ⲁⲅⲁⲡⲏⲧⲟⲥ" }], voiceUrl: "https://example.invalid/voice.ogg", wordCard: true }),
    pick: async () => null,
  };
  const sent = await handleMessengerMessaging(webhookEnv(), webhookEvent(MID), planFor, fetchImpl);
  assert.equal(sent, true);
  assert.ok(calls.some((c) => c.url === REACTIONS_URL), "reaction fired");
});

test("webhook: a non-card turn never reacts, even with a message id", async () => {
  const calls = [];
  const fetchImpl = recordingFetch(calls);
  const planFor = {
    text: async () => ({ texts: [{ text: "القائمة" }], voiceUrl: null }),
    pick: async () => null,
  };
  const sent = await handleMessengerMessaging(webhookEnv(), webhookEvent(MID), planFor, fetchImpl);
  assert.equal(sent, true);
  assert.ok(!calls.some((c) => c.url.includes("/reactions")), "no reactions call for a menu");
});

test("webhook: a word card without a message id never reacts", async () => {
  const calls = [];
  const fetchImpl = recordingFetch(calls);
  const planFor = {
    text: async () => ({ texts: [{ text: "الكلمة: ⲁⲅⲁⲡⲏⲧⲟⲥ" }], voiceUrl: null, wordCard: true }),
    pick: async () => null,
  };
  const sent = await handleMessengerMessaging(webhookEnv(), webhookEvent(null), planFor, fetchImpl);
  assert.equal(sent, true);
  assert.ok(!calls.some((c) => c.url.includes("/reactions")), "no reactions call without a mid");
});

test("webhook: a failed reaction never breaks the card reply", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body ?? "null") });
    if (String(url).includes("/reactions")) return Response.json({ error: { message: "bad id" } }, { status: 400 });
    return Response.json({ recipient_id: SENDER_ID, message_id: "mid.test-1" });
  };
  const planFor = {
    text: async () => ({ texts: [{ text: "الكلمة: ⲁⲅⲁⲡⲏⲧⲟⲥ" }], voiceUrl: null, wordCard: true }),
    pick: async () => null,
  };
  const sent = await handleMessengerMessaging(webhookEnv(), webhookEvent(MID), planFor, fetchImpl);
  assert.equal(sent, true, "the card still counts as sent");
  assert.ok(calls.some((c) => c.url === MESSENGER_SEND_URL && c.body?.message?.text), "the card text went out");
});

// --- Botcake input: the message id ----------------------------------------

test("parseBotcakeInput accepts a message id under every plausible key", () => {
  const url = new URL("https://bot.test/botcake");
  assert.equal(parseBotcakeInput({ psid: SENDER_ID, text: "hi", message_id: MID }, url).messageId, MID);
  assert.equal(parseBotcakeInput({ psid: SENDER_ID, text: "hi", mid: MID }, url).messageId, MID);
  assert.equal(parseBotcakeInput({ psid: SENDER_ID, text: "hi", last_message_id: MID }, url).messageId, MID);
  assert.equal(parseBotcakeInput({ psid: SENDER_ID, text: "hi", messageId: MID }, url).messageId, MID);
  assert.equal(parseBotcakeInput({ psid: SENDER_ID, text: "hi" }, url).messageId, null);
  assert.equal(parseBotcakeInput({ psid: SENDER_ID, text: "hi" }, new URL("https://bot.test/botcake?message_id=" + encodeURIComponent(MID))).messageId, MID);
});

// --- POST /botcake round-trips ---------------------------------------------

test("botcake: a word deep link with a message id reacts (word card)", async () => {
  const kv = fakeKv();
  const calls = [];
  const { envelope, tasks } = await postBotcake({ psid: SENDER_ID, text: `word_${AGAPETOS_ID}`, message_id: MID }, kv, calls);
  assert.ok(envelope.text.includes("ⲁⲅⲁⲡⲏⲧⲟⲥ"), "the card came back");
  const reaction = calls.find((c) => c.url === REACTIONS_URL);
  assert.ok(reaction, "a reactions call was made");
  assert.deepEqual(reaction.body, { reaction: "LOVE" });
  // (A request-counting waitUntil task also registers; the count is not
  // asserted — the reactions call is the behaviour under test.)
});

test("botcake: a word deep link WITHOUT a message id does not react", async () => {
  const kv = fakeKv();
  const calls = [];
  const { envelope } = await postBotcake({ psid: SENDER_ID, text: `word_${AGAPETOS_ID}` }, kv, calls);
  assert.ok(envelope.text.includes("ⲁⲅⲁⲡⲏⲧⲟⲥ"), "the card still came back");
  assert.ok(!calls.some((c) => c.url.includes("/reactions")), "no reactions call without a message id");
});

test("botcake: /links with a message id does not react (not a word card)", async () => {
  const kv = fakeKv();
  const calls = [];
  const { envelope } = await postBotcake({ psid: SENDER_ID, text: "/links", message_id: MID }, kv, calls);
  assert.ok(envelope.text.includes("https://is.gd/copticdictionary"), "the links text came back");
  assert.ok(!calls.some((c) => c.url.includes("/reactions")), "no reactions call for /links");
});

test("botcake: /random with a message id reacts (word card)", async () => {
  const kv = fakeKv();
  seedNamedUser(kv);
  const calls = [];
  const { envelope } = await postBotcake({ psid: SENDER_ID, text: "/random", message_id: MID }, kv, calls);
  assert.ok(envelope.text.includes("الكلمة:"), "a word card came back");
  const reaction = calls.find((c) => c.url === REACTIONS_URL);
  assert.ok(reaction, "a reactions call was made for /random");
  assert.deepEqual(reaction.body, { reaction: "LOVE" });
});

test("botcake: /wod with a message id reacts (word card)", async () => {
  const kv = fakeKv();
  seedNamedUser(kv);
  const calls = [];
  const { envelope } = await postBotcake({ psid: SENDER_ID, text: "/wod", message_id: MID }, kv, calls);
  assert.ok(envelope.text.includes("الكلمة:"), "a word card came back");
  assert.ok(calls.some((c) => c.url === REACTIONS_URL), "a reactions call was made for /wod");
});

test("botcake: a search pick with a message id reacts (word card)", async () => {
  const kv = fakeKv();
  seedNamedUser(kv);
  const calls = [];
  // Search first (list, no reaction), then pick #1 (card, reaction).
  await postBotcake({ psid: SENDER_ID, text: "ⲁⲅⲁⲡⲏⲧⲟⲥ", message_id: MID }, kv, calls);
  assert.ok(!calls.some((c) => c.url.includes("/reactions")), "the suggestion list does not react");
  calls.length = 0;
  const { envelope } = await postBotcake({ psid: SENDER_ID, text: "1", message_id: MID }, kv, calls);
  assert.ok(envelope.text.includes("الكلمة:"), "the picked word card came back");
  assert.ok(calls.some((c) => c.url === REACTIONS_URL), "a reactions call was made for the pick");
});

test("botcake: a no-result search with a message id does not react", async () => {
  const kv = fakeKv();
  seedNamedUser(kv);
  const calls = [];
  const { envelope } = await postBotcake({ psid: SENDER_ID, text: "zzzzqqq", message_id: MID }, kv, calls);
  assert.equal(envelope.text, "No results are currently available for this word.", "the no-result text came back");
  assert.ok(!calls.some((c) => c.url.includes("/reactions")), "no reactions call for no result");
});
