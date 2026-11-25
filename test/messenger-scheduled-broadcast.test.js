// Scheduled broadcasts on Messenger (/schedule, /schedules, /unschedule)
// + the 5-minute cron tick that sends due jobs.
//
// Parity flow (compose -> time -> confirm) runs through handleText, like
// /broadcast. The tick (runDueScheduledBroadcasts, src/messenger-core.js)
// reads the same DO key the parity layer writes ("broadcast:scheduled").
//
// Media limit (2026-11-25): the live receive path is Botcake (text
// only), so media is scheduled by pasting its PUBLIC URL — the tick
// sends it as an attachment with the caption.
import test from "node:test";
import assert from "node:assert/strict";
import { createMessengerParity } from "../src/messenger-parity.js";
import { runDueScheduledBroadcasts, SCHEDULED_BROADCAST_KEY, BROADCAST_RUNNING_KEY, BROADCAST_CTRL_KEY } from "../src/messenger-core.js";

const ADMIN_PSID = "123456789012345";
const USER_PSID = "987654321098765";

function makeParity(deps = {}) {
  return createMessengerParity({
    adminPsids: [ADMIN_PSID],
    listRecipients: async () => [USER_PSID, "111222333"],
    ...deps,
  });
}
const planText = (plan) => (plan?.texts ?? []).map((t) => t.text).join("\n");
const POSTER_URL = "https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev/poster-v9.jpg";

async function scheduleOne(parity, message = "رسالة تجريبية", time = "بعد ساعتين") {
  await parity.handleText(ADMIN_PSID, "/schedule");
  await parity.handleText(ADMIN_PSID, message);
  const confirm = await parity.handleText(ADMIN_PSID, time);
  const text = planText(confirm);
  assert.ok(text.includes("تمت جدولة الرسالة"), "the confirm is sent");
  const id = text.match(/🆔 المعرف: (\w+)/u)?.[1];
  assert.ok(id, "the confirm carries the job id");
  return id;
}

// ---------------------------------------------------------------------------
// Parity compose flow
// ---------------------------------------------------------------------------

test("messenger schedule: /schedule -> text -> time confirms and lists the job", async () => {
  const parity = makeParity();
  const start = await parity.handleText(ADMIN_PSID, "/schedule");
  assert.match(planText(start), /أرسل رسالة البث/u);
  const ready = await parity.handleText(ADMIN_PSID, "رسالة تجريبية");
  assert.match(planText(ready), /اكتب ميعاد الإرسال/u);
  const confirm = await parity.handleText(ADMIN_PSID, "بعد ساعتين");
  assert.match(planText(confirm), /تمت جدولة الرسالة/u);
  assert.match(planText(confirm), /المستلمون: 2 مستخدم/u);
  const list = await parity.handleText(ADMIN_PSID, "/schedules");
  assert.match(planText(list), /رسالة تجريبية/u);
  assert.match(planText(list), /🆔/u);
});

test("messenger schedule: /schedule <text> goes straight to the time prompt", async () => {
  const parity = makeParity();
  const ready = await parity.handleText(ADMIN_PSID, "/schedule نص مباشر");
  assert.match(planText(ready), /اكتب ميعاد الإرسال/u);
  assert.match(planText(ready), /نص مباشر/u);
  const confirm = await parity.handleText(ADMIN_PSID, "بكرة 08:00");
  assert.match(planText(confirm), /تمت جدولة الرسالة/u);
  const list = await parity.handleText(ADMIN_PSID, "/schedules");
  assert.match(planText(list), /نص مباشر/u);
});

test("messenger schedule: a bad time errors and the flow stays open", async () => {
  const parity = makeParity();
  await parity.handleText(ADMIN_PSID, "/schedule");
  await parity.handleText(ADMIN_PSID, "رسالة تجريبية");
  const bad = await parity.handleText(ADMIN_PSID, "أمس");
  assert.match(planText(bad), /لم أفهم الميعاد/u);
  const list = await parity.handleText(ADMIN_PSID, "/schedules");
  assert.match(planText(list), /لا توجد رسائل مجدولة/u);
  const good = await parity.handleText(ADMIN_PSID, "بعد ساعة");
  assert.match(planText(good), /تمت جدولة الرسالة/u);
});

test("messenger schedule: a media URL becomes an image job with a caption", async () => {
  const parity = makeParity();
  const ready = await parity.handleText(ADMIN_PSID, `/schedule ${POSTER_URL} إعلان النسخة الثانية`);
  assert.match(planText(ready), /📷 صورة/u);
  const confirm = await parity.handleText(ADMIN_PSID, "بعد 30 دقيقة");
  assert.match(planText(confirm), /تمت جدولة الرسالة/u);
  const list = await parity.handleText(ADMIN_PSID, "/schedules");
  assert.match(planText(list), /📷 صورة/u);
  assert.match(planText(list), /إعلان النسخة الثانية/u);
});

test("messenger schedule: /unschedule cancels by id; unknown id errors", async () => {
  const parity = makeParity();
  const id = await scheduleOne(parity);
  const cancelled = await parity.handleText(ADMIN_PSID, `/unschedule ${id}`);
  assert.match(planText(cancelled), /تم إلغاء الرسالة المجدولة/u);
  const list = await parity.handleText(ADMIN_PSID, "/schedules");
  assert.match(planText(list), /لا توجد رسائل مجدولة/u);
  const unknown = await parity.handleText(ADMIN_PSID, "/unschedule zzz999");
  assert.match(planText(unknown), /لا توجد رسالة مجدولة/u);
});

test("messenger schedule: a non-admin gets silence", async () => {
  const parity = makeParity();
  assert.deepEqual((await parity.handleText(USER_PSID, "/schedule"))?.texts ?? [], []);
  assert.deepEqual((await parity.handleText(USER_PSID, "/schedules"))?.texts ?? [], []);
  assert.deepEqual((await parity.handleText(USER_PSID, "/unschedule abc123"))?.texts ?? [], []);
});

test("messenger schedule: /cancel clears the compose flow", async () => {
  const parity = makeParity();
  await parity.handleText(ADMIN_PSID, "/schedule");
  await parity.handleText(ADMIN_PSID, "رسالة تجريبية");
  const cancelled = await parity.handleText(ADMIN_PSID, "/cancel");
  assert.match(planText(cancelled), /تم الإلغاء/u);
  // The time text afterwards is no longer a schedule time: it falls
  // through (no parity match) instead of confirming a job.
  const after = await parity.handleText(ADMIN_PSID, "بعد ساعة");
  assert.equal(after, null);
  const list = await parity.handleText(ADMIN_PSID, "/schedules");
  assert.match(planText(list), /لا توجد رسائل مجدولة/u);
});

test("messenger schedule: a command typed mid-flow is not captured as the message", async () => {
  const parity = makeParity();
  await parity.handleText(ADMIN_PSID, "/schedule");
  const list = await parity.handleText(ADMIN_PSID, "/schedules");
  assert.match(planText(list), /لا توجد رسائل مجدولة/u);
  // The flow is still open: the message now lands, then the time.
  await parity.handleText(ADMIN_PSID, "رسالة تجريبية");
  const confirm = await parity.handleText(ADMIN_PSID, "بعد ساعتين");
  assert.match(planText(confirm), /تمت جدولة الرسالة/u);
});

// ---------------------------------------------------------------------------
// Cron tick
// ---------------------------------------------------------------------------

function fakeStore(users) {
  const map = new Map();
  return {
    map,
    handle: async (payload) => {
      if (payload.op === "get") return { value: map.get(payload.key) ?? null };
      if (payload.op === "put") { map.set(payload.key, payload.value); return { ok: true }; }
      if (payload.op === "userpage") {
        return { users: users.map((id) => ({ id: `msgr:${id}`, record: {} })), next: null };
      }
      return { value: null };
    },
  };
}
function fakeGraph(calls, failPsids = new Set()) {
  return async (url, options = {}) => {
    const body = JSON.parse(options.body ?? "{}");
    const to = body?.recipient?.id;
    calls.push({ to, message: body?.message });
    if (failPsids.has(String(to))) {
      return new Response(JSON.stringify({ error: { message: "user inactive" } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return Response.json({ message_id: `mid-${calls.length}` });
  };
}
function tickEnv(store, users) {
  return { USERS: {}, __directStore: store, MESSENGER_PAGE_TOKEN: "test-token" };
}
const tickOpts = (calls, failPsids) => ({ fetchImpl: fakeGraph(calls, failPsids), gapMs: 0, adminPsid: ADMIN_PSID });

test("messenger tick: a due text job sends to all, reports, and is removed", async () => {
  const store = fakeStore([USER_PSID, "111222333"]);
  const job = { id: "abc123", sendAt: Date.now() - 1000, status: "queued", sent: 0, kind: "text", text: "رسالة مجدولة", createdBy: ADMIN_PSID, createdAt: Date.now() };
  store.map.set(SCHEDULED_BROADCAST_KEY, [job]);
  const calls = [];
  const started = await runDueScheduledBroadcasts(tickEnv(store), tickOpts(calls));
  assert.equal(started, true);
  const toUser = calls.filter((c) => c.to === USER_PSID || c.to === "111222333");
  assert.equal(toUser.length, 2, "both recipients get the text");
  assert.ok(toUser.every((c) => c.message?.text === "رسالة مجدولة"));
  const report = calls.find((c) => c.to === ADMIN_PSID);
  assert.match(report?.message?.text ?? "", /اكتمل البث المجدول: أُرسل إلى 2 من 2/u);
  assert.deepEqual(store.map.get(SCHEDULED_BROADCAST_KEY), [], "the finished job is removed");
  assert.equal(store.map.get(BROADCAST_RUNNING_KEY), null, "the running marker is cleared");
});

test("messenger tick: a future job waits; nothing is sent", async () => {
  const store = fakeStore([USER_PSID]);
  const job = { id: "fut001", sendAt: Date.now() + 60 * 60 * 1000, status: "queued", sent: 0, kind: "text", text: "لاحقًا", createdBy: ADMIN_PSID, createdAt: Date.now() };
  store.map.set(SCHEDULED_BROADCAST_KEY, [job]);
  const calls = [];
  assert.equal(await runDueScheduledBroadcasts(tickEnv(store), tickOpts(calls)), false);
  assert.equal(calls.length, 0);
  assert.equal(store.map.get(SCHEDULED_BROADCAST_KEY).length, 1, "the job stays queued");
});

test("messenger tick: a running broadcast makes the tick wait (queue-after-current)", async () => {
  const store = fakeStore([USER_PSID]);
  store.map.set(SCHEDULED_BROADCAST_KEY, [{ id: "abc123", sendAt: Date.now() - 1000, status: "queued", sent: 0, kind: "text", text: "رسالة مجدولة", createdBy: ADMIN_PSID, createdAt: Date.now() }]);
  store.map.set(BROADCAST_RUNNING_KEY, { startedAt: Date.now(), scheduledId: null, from: ADMIN_PSID });
  const calls = [];
  assert.equal(await runDueScheduledBroadcasts(tickEnv(store), tickOpts(calls)), false);
  assert.equal(calls.length, 0, "nothing is sent while another broadcast runs");
  assert.equal(store.map.get(SCHEDULED_BROADCAST_KEY).length, 1, "the job stays queued");
});

test("messenger tick: a paused broadcast control leaves the job queued", async () => {
  const store = fakeStore([USER_PSID]);
  store.map.set(SCHEDULED_BROADCAST_KEY, [{ id: "abc123", sendAt: Date.now() - 1000, status: "queued", sent: 0, kind: "text", text: "رسالة مجدولة", createdBy: ADMIN_PSID, createdAt: Date.now() }]);
  store.map.set(BROADCAST_CTRL_KEY, { paused: true });
  const calls = [];
  assert.equal(await runDueScheduledBroadcasts(tickEnv(store), tickOpts(calls)), false);
  assert.equal(calls.length, 0);
  assert.equal(store.map.get(SCHEDULED_BROADCAST_KEY).length, 1, "the job stays queued");
});

test("messenger tick: a media job sends the attachment first, then the caption", async () => {
  const store = fakeStore([USER_PSID]);
  const job = { id: "med001", sendAt: Date.now() - 1000, status: "queued", sent: 0, kind: "image", mediaUrl: POSTER_URL, caption: "إعلان النسخة الثانية", createdBy: ADMIN_PSID, createdAt: Date.now() };
  store.map.set(SCHEDULED_BROADCAST_KEY, [job]);
  const calls = [];
  assert.equal(await runDueScheduledBroadcasts(tickEnv(store), tickOpts(calls)), true);
  const toUser = calls.filter((c) => c.to === USER_PSID);
  assert.equal(toUser.length, 2, "attachment + caption");
  assert.equal(toUser[0].message?.attachment?.type, "image");
  assert.equal(toUser[0].message?.attachment?.payload?.url, POSTER_URL);
  assert.equal(toUser[1].message?.text, "إعلان النسخة الثانية");
  assert.deepEqual(store.map.get(SCHEDULED_BROADCAST_KEY), [], "the finished job is removed");
});

test("messenger tick: resilient mode skips inactive users instead of aborting", async () => {
  const users = ["u1", "u2", "u3", "u4", "u5", "u6", "u7"];
  const store = fakeStore(users);
  store.map.set(SCHEDULED_BROADCAST_KEY, [{ id: "res001", sendAt: Date.now() - 1000, status: "queued", sent: 0, kind: "text", text: "رسالة مجدولة", createdBy: ADMIN_PSID, createdAt: Date.now() }]);
  const calls = [];
  const fail = new Set(["u1", "u2", "u3", "u4", "u5", "u6"]);
  assert.equal(await runDueScheduledBroadcasts(tickEnv(store), tickOpts(calls, fail)), true);
  assert.ok(calls.some((c) => c.to === "u7" && c.message?.text === "رسالة مجدولة"), "the 7th user still gets the message after 6 consecutive failures");
  const report = calls.find((c) => c.to === ADMIN_PSID);
  assert.match(report?.message?.text ?? "", /أُرسل إلى 1 من 7/u);
  assert.deepEqual(store.map.get(SCHEDULED_BROADCAST_KEY), [], "the job finishes despite the failures");
});

test("messenger tick: a partial job resumes from its saved offset", async () => {
  const store = fakeStore([USER_PSID, "111222333"]);
  store.map.set(SCHEDULED_BROADCAST_KEY, [{ id: "part01", sendAt: Date.now() - 1000, status: "sending", sent: 1, kind: "text", text: "رسالة مجدولة", createdBy: ADMIN_PSID, createdAt: Date.now() }]);
  const calls = [];
  assert.equal(await runDueScheduledBroadcasts(tickEnv(store), tickOpts(calls)), true);
  assert.equal(calls.filter((c) => c.to === USER_PSID).length, 0, "the already-sent user is skipped");
  assert.equal(calls.filter((c) => c.to === "111222333").length, 1, "the remaining user gets it");
  assert.deepEqual(store.map.get(SCHEDULED_BROADCAST_KEY), [], "the job is removed after completion");
});

test("messenger tick: no recipients drops the job with an admin notice", async () => {
  const store = fakeStore([]);
  store.map.set(SCHEDULED_BROADCAST_KEY, [{ id: "non001", sendAt: Date.now() - 1000, status: "queued", sent: 0, kind: "text", text: "رسالة مجدولة", createdBy: ADMIN_PSID, createdAt: Date.now() }]);
  const calls = [];
  assert.equal(await runDueScheduledBroadcasts(tickEnv(store), tickOpts(calls)), true);
  const notice = calls.find((c) => c.to === ADMIN_PSID);
  assert.match(notice?.message?.text ?? "", /لا يوجد مستخدمون/u);
  assert.deepEqual(store.map.get(SCHEDULED_BROADCAST_KEY), [], "the job is dropped");
});
