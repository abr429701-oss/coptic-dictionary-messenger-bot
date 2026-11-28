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

function directImageSends(calls) {
  return calls.filter((c) => c.url === MESSENGER_SEND_URL && c.body?.message?.attachment?.type === "image");
}

function seedGetCodePhone(kv) {
  kv.store.set(`user:msgr:${PSID}`, {
    name: "Tester",
    parity: { getcodeStep: "phone", getcodeName: "أحمد محمد" },
  });
}

function seedGetCodeDone(kv, { wait = false } = {}) {
  kv.store.set(`user:msgr:${PSID}`, {
    name: "Tester",
    parity: {
      ...(wait ? { getcodeScreenshotAwaiting: true } : {}),
      getcodeScreenshotName: "أحمد محمد",
      getcodeScreenshotCode: "90488651",
    },
  });
}

// Success: the macro returns a code — the full reply text goes out
// directly as ONE whole message (never split — the long wa.me link
// would be cut mid-URL by the envelope splitter), then the example
// screenshot image, and the envelope must be fully cleared (no double).
test("get-code phone turn: whole reply text, then example image, envelope cleared", async () => {
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
  assert.equal(envelope.image_url, "", "envelope image cleared after direct send");
  assert.equal(envelope.has_image, "no");
  assert.equal(envelope.quick_replies, "", "envelope quick replies cleared");
  const direct = directTextSends(calls);
  assert.equal(direct.length, 1, "the reply goes out as exactly one whole text message");
  const reply = direct[0].body.message.text;
  assert.ok(reply.startsWith("لتفعيل اشتراكك"), "reply starts directly with the activation steps");
  assert.ok(!reply.includes("الاسم:"), "no name line in the success text");
  assert.ok(!reply.includes("الرقم الكودي الخاص بك هو:"), "no code line in the success text");
  assert.match(reply, /لتفعيل اشتراكك/u, "direct send carries the activation instructions");
  assert.match(reply, /Screenshot/u, "direct send tells the student to screenshot");
  // The wa.me link arrives WHOLE inside the one message — never split
  // across chunks (the 22 Nov 2026 bug).
  assert.ok(reply.includes("https://wa.me/201207829388?text="), "direct send carries the WhatsApp link");
  assert.ok(
    reply.includes(encodeURIComponent("تم التسجيل، الرقم الكودي الخاص بي: 90488651، اسمي: أحمد محمد")),
    "the pre-filled text is Telegram's exact wording, whole in one message",
  );
  const images = directImageSends(calls);
  assert.equal(images.length, 1, "the example screenshot goes out as one image message");
  assert.equal(
    images[0].body.message.attachment.payload.url,
    "https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev/getcode-example.jpg",
    "the image is the R2 example screenshot",
  );
  assert.ok(
    calls.indexOf(direct[0]) < calls.indexOf(images[0]),
    "order: text first, then the image (Messenger has no photo captions)",
  );
  assert.deepEqual(
    (images[0].body.message.quick_replies ?? []).map((q) => q.title),
    ["البداية", "تعلّم", "القائمة", "كلمة عشوائية", "تواصل معنا"],
    "five navigation buttons ride on the last message (the image)",
  );
  assert.equal((direct[0].body.message.quick_replies ?? []).length, 0, "no buttons on the text — they ride the image");
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

// Screenshot (28 Nov 2026 redesign): after the code reply, the student
// sends the WhatsApp screenshot back. Botcake forwards a non-text
// message as an empty-text call, so the empty-text turn checks the
// one-shot wait — the activation reply goes out directly with the
// stored name+code, the wait clears, and the record persists.
test("get-code screenshot: empty-text turn confirms activation once, record persists", async () => {
  const kv = fakeKv();
  seedGetCodeDone(kv, { wait: true });
  const calls = [];
  const { envelope } = await postBotcake({ psid: PSID, text: "" }, kv, calls, { success: true, code: "90488651" });
  assert.equal(envelope.text, "", "envelope text cleared after direct send");
  const direct = directTextSends(calls);
  assert.equal(direct.length, 1, "exactly one activation reply");
  assert.match(
    direct[0].body.message.text,
    /تم تفعيل اشتراكك عزيزنا، أحمد محمد والرقم الكودي الخاص بك هو: 90488651/u,
    "activation reply carries the stored name and code",
  );
  const record = kv.store.get(`user:msgr:${PSID}`);
  assert.equal(record.parity.getcodeScreenshotAwaiting, undefined, "the wait clears after the screenshot");
  assert.equal(record.parity.getcodeScreenshotName, "أحمد محمد", "the name record persists");
  assert.equal(record.parity.getcodeScreenshotCode, "90488651", "the code record persists");
  // A second image afterwards does not repeat the activation.
  const calls2 = [];
  await postBotcake({ psid: PSID, text: "" }, kv, calls2, { success: true, code: "90488651" });
  const direct2 = directTextSends(calls2);
  assert.ok(!direct2.some((d) => /تم تفعيل اشتراكك/u.test(d.body.message.text)), "no second activation reply");
});

// Returning user: tapping get-code again shows the stored code directly
// — never re-asks for name/phone.
test("get-code returning user: greeting with the stored code, no name question", async () => {
  const kv = fakeKv();
  seedGetCodeDone(kv);
  const calls = [];
  const { envelope } = await postBotcake({ psid: PSID, text: "/getcode" }, kv, calls, { success: true, code: "90488651" });
  assert.equal(envelope.text, "", "envelope text cleared after direct send");
  const direct = directTextSends(calls);
  const allDirect = direct.map((d) => d.body.message.text).join("\n");
  assert.match(allDirect, /مرحباً، أحمد محمد، الرقم الكودي الخاص بك هو 90488651/u, "greeting carries the stored name and code");
  assert.doesNotMatch(allDirect, /اكتب اسمك/u, "no name question for a returning user");
});

// First-time user: no stored record — the name question rides the
// envelope (no direct send needed for a short ask).
test("get-code first-time user: asks for the name", async () => {
  const kv = fakeKv();
  kv.store.set(`user:msgr:${PSID}`, { name: "Tester" });
  const calls = [];
  const { envelope } = await postBotcake({ psid: PSID, text: "/getcode" }, kv, calls, { success: true, code: "90488651" });
  assert.match(envelope.text, /اكتب اسمك الثلاثي/u, "first-time user is asked for the name");
  assert.doesNotMatch(envelope.text, /مرحباً/u, "no returning-user greeting without a record");
});

// An empty-text turn with no screenshot wait stays silent (no false
// activation from a stray like/sticker).
test("get-code empty-text turn with no wait: silence, no activation", async () => {
  const kv = fakeKv();
  kv.store.set(`user:msgr:${PSID}`, { name: "Tester" });
  const calls = [];
  const { envelope } = await postBotcake({ psid: PSID, text: "" }, kv, calls, { success: true, code: "90488651" });
  assert.equal(envelope.text, "", "nothing in the envelope");
  assert.ok(!directTextSends(calls).some((d) => /تم تفعيل اشتراكك/u.test(d.body.message.text)), "no activation reply without a wait");
});
