// /share direct send (25 Nov 2026): the v2 launch announcement (~2,900
// chars) + poster image + closing share-ask line. The Botcake envelope
// only carries three capped text chunks, so the flow would truncate the
// announcement — the Worker sends the announcement chunks first, then the
// image, then the closing line, directly (awaited), and clears the
// envelope so the flow sends nothing (no double). Same pattern as the
// word-card / name-completion / get-code direct sends.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { UserStore } from "../src/index.js";
import { MESSENGER_SEND_URL } from "../src/messenger.js";
import { SHARE_POSTER_URL } from "../src/messenger-parity.js";

const BOTCAKE_SECRET = "test-secret";
const PAGE_TOKEN = "test-page-token";
const PSID = "555000111444";

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
    }), {
      BOTCAKE_SECRET,
      MESSENGER_PAGE_TOKEN: PAGE_TOKEN,
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

function directImageSends(calls) {
  return calls.filter((c) => c.url === MESSENGER_SEND_URL && c.body?.message?.attachment?.type === "image");
}

// Existing (named) user, so the name gate lets /share through and the
// first-ever branch does not fire.
function seedExistingUser(kv) {
  kv.store.set(`user:msgr:${PSID}`, { name: "Tester" });
}

test("/share: announcement text first, then poster image, then closing share-ask line, envelope cleared", async () => {
  const kv = fakeKv();
  seedExistingUser(kv);
  const calls = [];
  const { envelope } = await postBotcake({ psid: PSID, text: "/share" }, kv, calls);
  assert.equal(envelope.text, "", "envelope text cleared after direct send");
  assert.equal(envelope.text2, "", "envelope text2 cleared");
  assert.equal(envelope.text3, "", "envelope text3 cleared");
  assert.equal(envelope.has_text, "no");
  assert.equal(envelope.image_url, "", "envelope image cleared after direct send");
  assert.equal(envelope.has_image, "no");
  assert.equal(envelope.quick_replies, "", "envelope quick replies cleared");
  const images = directImageSends(calls);
  assert.equal(images.length, 1, "exactly one direct image send");
  assert.equal(images[0].body.message.attachment.payload.url, SHARE_POSTER_URL, "image is the R2 poster");
  const direct = directTextSends(calls);
  assert.ok(direct.length >= 3, "announcement chunks + closing line");
  const allDirect = direct.map((d) => d.body.message.text).join("\n");
  assert.match(allDirect, /إطلاق النسخة الثانية من تطبيق القاموس القبطي الناطق/u, "direct texts carry the announcement opening");
  assert.match(allDirect, /https:\/\/is\.gd\/copticdictionary/u, "direct texts carry the app link");
  assert.match(allDirect, /Ebram Merzik/u, "direct texts carry the signature");
  assert.match(allDirect, /نرجو منك نشر ومشاركة البوست السابق/u, "direct texts end with the share-ask line");
  for (const d of direct) {
    assert.ok(d.body.message.text.length <= 2000, "each chunk fits Messenger's 2000-char cap");
  }
  // Order: announcement text, then image, then the closing line.
  const firstImageAt = calls.indexOf(images[0]);
  const firstTextAt = calls.indexOf(direct[0]);
  const closingAt = calls.indexOf(direct[direct.length - 1]);
  assert.ok(firstTextAt < firstImageAt, "announcement text sent before the image");
  assert.ok(firstImageAt < closingAt, "image sent before the closing line");
  // The five fixed nav buttons ride on the closing line (the last text).
  const last = direct[direct.length - 1].body.message;
  assert.equal(last.quick_replies?.length, 5, "five fixed nav buttons on the closing line");
  assert.deepEqual(last.quick_replies.map((q) => q.title), ["البداية", "تعلّم", "القائمة", "كلمة عشوائية", "تواصل معنا"]);
  // No quick replies on the announcement chunks (they are not last).
  for (const d of direct.slice(0, -1)) {
    assert.equal(d.body.message.quick_replies, undefined, "announcement chunks carry no quick replies");
  }
});
