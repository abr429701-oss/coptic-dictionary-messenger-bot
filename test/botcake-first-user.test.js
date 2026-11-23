// First-ever Botcake user: the Worker sends the reply text directly, so a
// brand-new subscriber is never met with silence. Botcake's flow reads the
// saved reply fields one run stale, and a new user has no previous fields —
// so its Conditions see empty and it sends NOTHING (live case 23 Nov 2026:
// Asmaa Mohamed's first word got total silence while the Worker answered).
// The direct send fires only on the very first message; from the second
// message on, the fields exist and Botcake sends as normal, so there is no
// double reply.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { UserStore } from "../src/index.js";
import { MESSENGER_SEND_URL } from "../src/messenger.js";

const BOTCAKE_SECRET = "test-botcake-secret";
const PAGE_TOKEN = "test-page-token";
const NEW_PSID = "555000111222";

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

// Recording fetch stub: every Graph call answers like Meta, and every call
// is recorded (url + parsed body) so tests can assert exactly which Graph
// calls a turn made.
function recordingFetch(calls) {
  return async (url, options = {}) => {
    let body = null;
    try { body = JSON.parse(options.body ?? "null"); } catch { body = null; }
    calls.push({ url: String(url), method: options.method ?? "GET", body });
    return Response.json({ recipient_id: NEW_PSID, message_id: "mid.test-1" });
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

// Direct text sends: POSTs to the Send API carrying a text message (as
// opposed to the typing_on sender_action, which carries no message).
function directTextSends(calls) {
  return calls.filter((c) => c.url === MESSENGER_SEND_URL && typeof c.body?.message?.text === "string");
}

test("first-ever user: the Worker sends the reply text directly", async () => {
  const kv = fakeKv();
  const calls = [];
  // No user record and no search history seeded — this PSID never messaged.
  const { envelope } = await postBotcake({ psid: NEW_PSID, text: "ϩⲉⲛⲥⲁⲃⲉⲉⲩ" }, kv, calls);
  assert.ok(envelope.text, "envelope still carries the text for the flow");
  const direct = directTextSends(calls);
  assert.equal(direct.length, 1, "exactly one direct text send for a first-ever user");
  assert.equal(direct[0].body.recipient.id, NEW_PSID);
  assert.equal(direct[0].body.message.text, envelope.text);
});

test("second message from the same user: no direct send (Botcake owns it)", async () => {
  const kv = fakeKv();
  const calls = [];
  await postBotcake({ psid: NEW_PSID, text: "ϩⲉⲛⲥⲁⲃⲉⲉⲩ" }, kv, calls);
  // The first word wrote a search history, so the second turn is not first-ever.
  calls.length = 0;
  const { envelope } = await postBotcake({ psid: NEW_PSID, text: "ϩⲉⲛⲥⲁⲃⲉⲉⲩ" }, kv, calls);
  assert.ok(envelope.text, "envelope still carries the text for the flow");
  assert.equal(directTextSends(calls).length, 0, "no direct text send on the second message");
});

test("existing named user: no direct send", async () => {
  const kv = fakeKv();
  kv.store.set(`user:msgr:${NEW_PSID}`, { name: "Ebram" });
  const calls = [];
  const { envelope } = await postBotcake({ psid: NEW_PSID, text: "ϩⲉⲛⲥⲁⲃⲉⲉⲩ" }, kv, calls);
  assert.ok(envelope.text, "envelope still carries the text for the flow");
  assert.equal(directTextSends(calls).length, 0, "no direct text send for an existing user");
});
