// Messenger live monitoring (/livemon, /conversations, /userchat) —
// Telegram parity (final-code-fix test/live-monitor.test.js), adapted:
// the log + flag live in the Durable Object via adminStore, the
// forward is a direct Send API call from the webhook wiring
// (src/index.js liveMonitorHook), and every command ALWAYS replies —
// Telegram's /conversations stays silent on the empty case
// (undiagnosed since 2026-11-08); these tests pin the replies.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker, { UserStore } from "../src/index.js";
import {
  createMessengerParity,
  formatLiveForward,
  LIVEMON_KEY,
  CONV_KEY_PREFIX,
  CONV_ACTIVE_KEY,
  LIVEMON_ON_TEXT,
  LIVEMON_OFF_TEXT,
} from "../src/messenger-parity.js";

const ADMIN_PSID = "123456789012345";
const USER_PSID = "987654321098765";
const OTHER_PSID = "555666777888999";

// ---------------------------------------------------------------------------
// Parity-level: fake DO-backed adminStore
// ---------------------------------------------------------------------------

function makeStore() {
  const map = new Map();
  return {
    map,
    get: async (key) => map.get(String(key)) ?? null,
    put: async (key, value) => { map.set(String(key), value); return true; },
    del: async (key) => { map.delete(String(key)); },
  };
}

function makeParity({ store, names } = {}) {
  const adminStore = store ?? makeStore();
  return {
    adminStore,
    parity: createMessengerParity({
      adminPsids: [ADMIN_PSID],
      adminStore,
      getUserRecord: async (psid) => {
        const name = names?.[String(psid)];
        return name ? { record: { name }, history: [] } : null;
      },
      getStats: async () => ({ recordCount: 17226, users: 1 }),
    }),
  };
}

const planText = (plan) => (plan?.texts ?? []).map((t) => t.text).join("\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("live-monitor: the feed is OFF by default", async () => {
  const { parity, adminStore } = makeParity();
  assert.equal(await parity.liveMonitorOn(), false);
  assert.equal(adminStore.map.get(LIVEMON_KEY) ?? null, null);
});

test("live-monitor: /livemon flips the flag and persists it in the DO", async () => {
  const { parity, adminStore } = makeParity();
  const on = await parity.handleText(ADMIN_PSID, "/livemon");
  assert.equal(planText(on), LIVEMON_ON_TEXT);
  assert.equal(adminStore.map.get(LIVEMON_KEY), true);
  assert.equal(await parity.liveMonitorOn(), true);
  const off = await parity.handleText(ADMIN_PSID, "/livemon");
  assert.equal(planText(off), LIVEMON_OFF_TEXT);
  assert.equal(adminStore.map.get(LIVEMON_KEY), false);
  assert.equal(await parity.liveMonitorOn(), false);
});

test("live-monitor: a non-admin cannot toggle the feed (silence, flag untouched)", async () => {
  const { parity, adminStore } = makeParity();
  const plan = await parity.handleText(USER_PSID, "/livemon");
  assert.deepEqual(plan.texts, [], "non-admin admin commands stay silent");
  assert.equal(adminStore.map.get(LIVEMON_KEY) ?? null, null);
  assert.equal(await parity.liveMonitorOn(), false);
});

test("live-monitor: the per-user log caps at 100 (oldest dropped)", async () => {
  const { parity, adminStore } = makeParity();
  for (let i = 1; i <= 105; i += 1) {
    assert.equal(await parity.logIncomingMessage(USER_PSID, "text", `msg-${String(i).padStart(3, "0")}`), true);
  }
  const log = adminStore.map.get(`${CONV_KEY_PREFIX}${USER_PSID}`);
  assert.equal(log.length, 100);
  assert.equal(log[0].text, "msg-006", "the first five entries were dropped");
  assert.equal(log[99].text, "msg-105");
  const active = adminStore.map.get(CONV_ACTIVE_KEY);
  assert.equal(active[USER_PSID].count, 105, "the index counts every message, not just the kept ones");
  assert.ok(active[USER_PSID].at, "the index stamps the last message time");
});

test("live-monitor: admin messages are never logged or forwarded", async () => {
  const { parity, adminStore } = makeParity();
  assert.equal(await parity.logIncomingMessage(ADMIN_PSID, "text", "رسالة أدمن 777"), false);
  assert.equal(await parity.buildLiveForward(ADMIN_PSID, "text", "رسالة أدمن 777"), null);
  assert.ok(![...adminStore.map.keys()].some((k) => k.startsWith("msgr:conv")), "no conv key was written");
});

test("live-monitor: bot replies are never logged (only inbound messages log)", async () => {
  const { parity, adminStore } = makeParity();
  await parity.handleText(USER_PSID, "/menu");
  await parity.handleText(USER_PSID, "/learn");
  await parity.handleText(USER_PSID, "/help");
  assert.ok(![...adminStore.map.keys()].some((k) => k.startsWith("msgr:conv")), "answering never writes to the conv log");
});

test("live-monitor: /conversations and /userchat round-trip the log", async () => {
  const { parity } = makeParity({ names: { [USER_PSID]: "لمياء", [OTHER_PSID]: "مريم" } });
  await parity.logIncomingMessage(OTHER_PSID, "text", "سؤال من مريم 555");
  await sleep(5);
  await parity.logIncomingMessage(USER_PSID, "text", "كلمة تجريبية للمراقبة 111");
  await parity.logIncomingMessage(USER_PSID, "voice", "");
  const conv = await parity.handleText(ADMIN_PSID, "/conversations");
  const convText = planText(conv);
  assert.match(convText, /لمياء/u);
  assert.match(convText, /مريم/u);
  assert.ok(convText.indexOf("لمياء") < convText.indexOf("مريم"), "newest first");
  assert.match(convText, new RegExp(USER_PSID, "u"));
  assert.match(convText, /2 رسالة/u, "message count is shown");
  assert.match(convText, /\/userchat <id>/u, "the report tells the admin how to open the chat");
  const chat = await parity.handleText(ADMIN_PSID, `/userchat ${USER_PSID}`);
  const chatText = planText(chat);
  assert.match(chatText, /كلمة تجريبية للمراقبة 111/u);
  assert.match(chatText, /🎤 رسالة صوتية/u, "voice entries render as their label");
  assert.match(chatText, /💬.*987654321098765/u, "the report names the user id");
});

test("live-monitor: /userchat shows the last 30 messages only", async () => {
  const { parity } = makeParity();
  for (let i = 1; i <= 35; i += 1) {
    await parity.logIncomingMessage(USER_PSID, "text", `msg-${String(i).padStart(3, "0")}`);
  }
  const chatText = planText(await parity.handleText(ADMIN_PSID, `/userchat ${USER_PSID}`));
  assert.ok(!chatText.includes("msg-001"), "the oldest messages are cut");
  assert.ok(!chatText.includes("msg-005"));
  assert.ok(chatText.includes("msg-006"), "exactly the last 30 remain");
  assert.ok(chatText.includes("msg-035"));
  assert.match(chatText, /آخر 30 رسالة/u);
});

test("live-monitor: empty /conversations and /userchat ALWAYS reply (never silence)", async () => {
  const { parity } = makeParity();
  const conv = await parity.handleText(ADMIN_PSID, "/conversations");
  assert.equal(planText(conv), "📭 لا توجد محادثات محفوظة بعد — تظهر هنا بعد أول رسالة من أي مستخدم.");
  const chat = await parity.handleText(ADMIN_PSID, `/userchat ${USER_PSID}`);
  assert.equal(planText(chat), `📭 لا توجد رسائل محفوظة للمستخدم ${USER_PSID} بعد.`);
});

test("live-monitor: /userchat without an id, or with a bad id, explains the usage", async () => {
  const { parity } = makeParity();
  assert.match(planText(await parity.handleText(ADMIN_PSID, "/userchat")), /\/userchat <id>/u);
  assert.match(planText(await parity.handleText(ADMIN_PSID, "/userchat abc")), /\/userchat <id>/u);
  assert.match(planText(await parity.handleText(ADMIN_PSID, "/userchat")), /مثال: \/userchat 123456789/u);
});

test("live-monitor: voice and captioned-media entries render with their labels", async () => {
  const { parity } = makeParity({ names: { [USER_PSID]: "لمياء" } });
  await parity.logIncomingMessage(USER_PSID, "media", "شرح الصورة 888");
  const chatText = planText(await parity.handleText(ADMIN_PSID, `/userchat ${USER_PSID}`));
  assert.match(chatText, /📎 وسائط/u);
  assert.match(chatText, /شرح الصورة 888/u, "the media caption is kept as the entry text");
});

test("live-monitor: forward format — name, PSID, time, text sliced to 1000, /msg hint", () => {
  const long = "x".repeat(1500);
  const forward = formatLiveForward({ name: "لمياء", psid: USER_PSID, at: "2026-11-16T20:55:44.000Z", kind: "text", text: long });
  const lines = forward.split("\n");
  assert.match(lines[0], /لمياء/u);
  assert.match(lines[0], new RegExp(USER_PSID, "u"));
  assert.match(lines[0], /\d{2}:\d{2}:\d{2}/u, "time is HH:MM:SS");
  assert.equal(lines[1].length, 1000, "the message text is sliced to 1000");
  assert.equal(lines[2], `رد بـ /msg ${USER_PSID} <نص>`);
  assert.ok(!forward.includes("*"), "no asterisks around names (display rule)");
  const voice = formatLiveForward({ name: "", psid: USER_PSID, at: "2026-11-16T20:55:44.000Z", kind: "voice", text: "" });
  assert.match(voice, /بدون اسم/u, "missing name falls back to بدون اسم, never to a blank");
  assert.match(voice, /🎤 رسالة صوتية/u);
  const media = formatLiveForward({ name: "مينا", psid: USER_PSID, at: "2026-11-16T20:55:44.000Z", kind: "media", text: "شرح الصورة 888" });
  assert.match(media, /📎 وسائط شرح الصورة 888/u);
});

test("live-monitor: buildLiveForward resolves the name, falls back to the bare PSID", async () => {
  const withName = makeParity({ names: { [USER_PSID]: "لمياء" } });
  const forward = await withName.parity.buildLiveForward(USER_PSID, "text", "أهلًا");
  assert.match(forward, /لمياء/u);
  assert.match(forward, /أهلًا/u);
  const noName = makeParity();
  const bare = await noName.parity.buildLiveForward(USER_PSID, "text", "أهلًا");
  assert.match(bare, new RegExp(USER_PSID, "u"));
  assert.match(bare, /بدون اسم/u);
});

// ---------------------------------------------------------------------------
// Webhook-level: the forward goes out through the real Send API path
// ---------------------------------------------------------------------------

const VERIFY_TOKEN = "messenger-verify-test-token";
const APP_SECRET = "messenger-app-secret-test-value";
const PAGE_TOKEN = "messenger-page-token-test-value";
const env = {
  MESSENGER_VERIFY_TOKEN: VERIFY_TOKEN,
  MESSENGER_APP_SECRET: APP_SECRET,
  MESSENGER_PAGE_TOKEN: PAGE_TOKEN,
};
const PAGE_ID = "61596442358492";
const sign = (rawBody) => `sha256=${createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;

function messageEvent(message, senderId = USER_PSID) {
  return {
    object: "page",
    entry: [{
      id: PAGE_ID,
      time: 1794791000000,
      messaging: [{
        sender: { id: senderId },
        recipient: { id: PAGE_ID },
        timestamp: 1794791000000,
        message,
      }],
    }],
  };
}

function postSigned(body, envOverride = env) {
  const raw = JSON.stringify(body);
  return worker.fetch(
    new Request("https://bot.test/messenger-webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) },
      body: raw,
    }),
    envOverride,
  );
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
  const object = new UserStore({ storage }, env);
  return {
    store,
    object,
    idFromName: (name) => name,
    get: () => ({ fetch: (url, options) => object.fetch(new Request(url, options)) }),
  };
}

// Stub the Send API: capture every outbound call, answer like Meta.
function stubMessengerApi(calls) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options?.body;
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    calls.push({
      url: String(url),
      payload: isForm ? null : (body ? JSON.parse(body) : null),
      form: isForm ? body : null,
    });
    return Response.json({ recipient_id: USER_PSID, message_id: "mid.test-1" });
  };
  return () => { globalThis.fetch = realFetch; };
}

async function sendMessengerMessage(message, { senderId = USER_PSID, envOverride = env } = {}) {
  const calls = [];
  const restore = stubMessengerApi(calls);
  try {
    const response = await postSigned(messageEvent(message, senderId), envOverride);
    assert.equal(response.status, 200);
    return calls;
  } finally {
    restore();
  }
}

const textsTo = (calls, recipientId) =>
  calls
    .filter((c) => c.payload?.recipient?.id === recipientId && typeof c.payload?.message?.text === "string")
    .map((c) => c.payload.message.text);

function liveEnv() {
  const kv = fakeKv();
  kv.store.set(`user:msgr:${USER_PSID}`, { name: "مينا", registeredAt: new Date().toISOString(), firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() });
  return { kv, adminEnv: { ...env, USERS: kv, MESSENGER_ADMIN_PSID: ADMIN_PSID } };
}

test("live-monitor webhook: no forward while OFF, but the message is still logged", async () => {
  const { kv, adminEnv } = liveEnv();
  const calls = await sendMessengerMessage({ text: "رسالة بدون مراقبة 222" }, { envOverride: adminEnv });
  assert.ok(!textsTo(calls, ADMIN_PSID).some((t) => t.includes("رسالة بدون مراقبة 222")), "no live forward reaches the admin while the monitor is off");
  const log = kv.store.get(`${CONV_KEY_PREFIX}${USER_PSID}`);
  assert.equal(log?.length, 1, "logging happens even while the feed is off");
  assert.equal(log[0].text, "رسالة بدون مراقبة 222");
});

test("live-monitor webhook: forward when ON, silence when OFF again", async () => {
  const { kv, adminEnv } = liveEnv();
  const onCalls = await sendMessengerMessage({ text: "/livemon" }, { senderId: ADMIN_PSID, envOverride: adminEnv });
  assert.ok(textsTo(onCalls, ADMIN_PSID).some((t) => /تم تشغيل المراقبة المباشرة/u.test(t)), "toggle on is confirmed");
  const liveCalls = await sendMessengerMessage({ text: "رسالة مباشرة 333" }, { envOverride: adminEnv });
  const forward = textsTo(liveCalls, ADMIN_PSID).find((t) => t.includes("رسالة مباشرة 333"));
  assert.ok(forward, "the admin receives the message live once the monitor is on");
  assert.match(forward, /مينا/u, "forward names the sender");
  assert.match(forward, new RegExp(USER_PSID, "u"), "forward names the sender id");
  assert.match(forward, new RegExp(`رد بـ /msg ${USER_PSID} <نص>`, "u"), "forward tells the admin to reply with /msg");
  const offCalls = await sendMessengerMessage({ text: "/livemon" }, { senderId: ADMIN_PSID, envOverride: adminEnv });
  assert.ok(textsTo(offCalls, ADMIN_PSID).some((t) => /تم إيقاف المراقبة المباشرة/u.test(t)), "toggle off is confirmed");
  const quietCalls = await sendMessengerMessage({ text: "رسالة بعد الإيقاف 444" }, { envOverride: adminEnv });
  assert.ok(!textsTo(quietCalls, ADMIN_PSID).some((t) => t.includes("رسالة بعد الإيقاف 444")), "no forward reaches the admin after the monitor is off");
  assert.equal(kv.store.get(LIVEMON_KEY), false, "the flag survives across webhook requests (DO-backed)");
});

test("live-monitor webhook: a non-admin cannot toggle the feed", async () => {
  const { kv, adminEnv } = liveEnv();
  const calls = await sendMessengerMessage({ text: "/livemon" }, { envOverride: adminEnv });
  assert.deepEqual(textsTo(calls, USER_PSID), [], "a non-admin /livemon stays silent");
  assert.equal(kv.store.get(LIVEMON_KEY) ?? null, null, "the flag was not flipped");
  const after = await sendMessengerMessage({ text: "رسالة بعد محاولة غير أدمن 666" }, { envOverride: adminEnv });
  assert.ok(!textsTo(after, ADMIN_PSID).some((t) => t.includes("رسالة بعد محاولة غير أدمن 666")), "no forward: a non-admin /livemon must not enable the monitor");
});

test("live-monitor webhook: the admin's own messages are not logged or forwarded", async () => {
  const { kv, adminEnv } = liveEnv();
  await sendMessengerMessage({ text: "/livemon" }, { senderId: ADMIN_PSID, envOverride: adminEnv });
  const calls = await sendMessengerMessage({ text: "رسالة أدمن تجريبية 777" }, { senderId: ADMIN_PSID, envOverride: adminEnv });
  assert.ok(!textsTo(calls, ADMIN_PSID).some((t) => t.includes("رسالة أدمن تجريبية 777")), "the admin's own message is not forwarded to themself");
  assert.equal(kv.store.get(`${CONV_KEY_PREFIX}${ADMIN_PSID}`) ?? null, null, "the admin has no logged conversation");
  const reportCalls = await sendMessengerMessage({ text: `/userchat ${ADMIN_PSID}` }, { senderId: ADMIN_PSID, envOverride: adminEnv });
  assert.ok(textsTo(reportCalls, ADMIN_PSID).some((t) => /لا توجد رسائل محفوظة/u.test(t)), "the admin's empty chat still gets a reply");
});

test("live-monitor webhook: a voice message is forwarded with its label when ON", async () => {
  const { adminEnv } = liveEnv();
  await sendMessengerMessage({ text: "/livemon" }, { senderId: ADMIN_PSID, envOverride: adminEnv });
  const calls = await sendMessengerMessage(
    { attachments: [{ type: "audio", payload: { url: "https://example.test/voice.mp3" } }] },
    { envOverride: adminEnv },
  );
  const forward = textsTo(calls, ADMIN_PSID).find((t) => t.includes("🎤 رسالة صوتية"));
  assert.ok(forward, "the voice forward reaches the admin");
  assert.match(forward, new RegExp(USER_PSID, "u"));
  assert.deepEqual(textsTo(calls, USER_PSID), [], "a non-admin voice stays silent for the user");
});

test("live-monitor webhook: a captioned photo is logged as media", async () => {
  const { adminEnv } = liveEnv();
  await sendMessengerMessage(
    { text: "شرح الصورة 888", attachments: [{ type: "image", payload: { url: "https://example.test/pic.jpg" } }] },
    { envOverride: adminEnv },
  );
  const reportCalls = await sendMessengerMessage({ text: `/userchat ${USER_PSID}` }, { senderId: ADMIN_PSID, envOverride: adminEnv });
  const report = textsTo(reportCalls, ADMIN_PSID).find((t) => t.includes("شرح الصورة 888"));
  assert.ok(report, "/userchat shows the photo caption");
  assert.match(report, /📎 وسائط/u, "the entry is kind media");
});
