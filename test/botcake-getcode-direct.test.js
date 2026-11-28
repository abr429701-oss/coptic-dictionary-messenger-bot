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
import worker, { UserStore, isBotcakeImageUrlText } from "../src/index.js";
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

async function postBotcake(body, kv, calls, macroResponse, envExtra = {}) {
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
      ...envExtra,
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

function seedGetCodeName(kv) {
  // Phone already given (phone-first order); the flow waits for the name.
  kv.store.set(`user:msgr:${PSID}`, {
    name: "Tester",
    parity: { getcodeStep: "name", getcodePhone: "01289254084" },
  });
}

function seedGetCodeDone(kv, { wait = false, activated = true } = {}) {
  kv.store.set(`user:msgr:${PSID}`, {
    name: "Tester",
    parity: {
      ...(wait ? { getcodeScreenshotAwaiting: true } : {}),
      ...(activated ? { getcodeActivated: true } : {}),
      getcodeScreenshotName: "أحمد محمد",
      getcodeScreenshotCode: "90488651",
    },
  });
}

// Success: the macro returns a code — the full reply text goes out
// directly as ONE whole message (never split — the long wa.me link
// would be cut mid-URL by the envelope splitter), then the example
// screenshot image, and the envelope must be fully cleared (no double).
test("get-code name turn: whole reply text, then example image, envelope cleared", async () => {
  const kv = fakeKv();
  seedGetCodeName(kv);
  const calls = [];
  const { envelope } = await postBotcake(
    { psid: PSID, text: "أحمد محمد" },
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
  seedGetCodeName(kv);
  const calls = [];
  const { envelope } = await postBotcake(
    { psid: PSID, text: "أحمد محمد" },
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
    /تم تفعيل اشتراكك عزيزنا أحمد محمد والرقم الكودي الخاص بك هو: 90488651/u,
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
  assert.match(allDirect, /مرحباً أحمد محمد، الرقم الكودي الخاص بك هو 90488651/u, "greeting carries the stored name and code");
  assert.doesNotMatch(allDirect, /اكتب اسمك/u, "no name question for a returning user");
});

// First-time user: no stored record — the name question rides the
// envelope (no direct send needed for a short ask).
test("get-code first-time user: asks for the phone", async () => {
  const kv = fakeKv();
  kv.store.set(`user:msgr:${PSID}`, { name: "Tester" });
  const calls = [];
  const { envelope } = await postBotcake({ psid: PSID, text: "/getcode" }, kv, calls, { success: true, code: "90488651" });
  assert.match(envelope.text, /اكتب رقم موبايلك/u, "first-time user is asked for the phone");
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

// OCR (28 Nov 2026): the /botcake empty-text hook carries NO image
// bytes, so it cannot OCR — it must fail open to the activation even
// when the OCR key is configured, and never call api.ocr.space.
test("get-code screenshot: empty-text turn with OCR key set still activates, never calls OCR", async () => {
  const kv = fakeKv();
  seedGetCodeDone(kv, { wait: true });
  const calls = [];
  const { envelope } = await postBotcake(
    { psid: PSID, text: "" },
    kv,
    calls,
    { success: true, code: "90488651" },
    { OCR_SPACE_API_KEY: "test-ocr-key" },
  );
  assert.equal(envelope.text, "", "envelope text cleared after direct send");
  const direct = directTextSends(calls);
  assert.equal(direct.length, 1, "exactly one activation reply");
  assert.match(direct[0].body.message.text, /تم تفعيل اشتراكك عزيزنا أحمد محمد والرقم الكودي الخاص بك هو: 90488651/u);
  assert.ok(!calls.some((c) => String(c.url).startsWith("https://api.ocr.space/")), "no OCR call without image bytes");
});

// ---------------------------------------------------------------------------
// Screenshot bug (live 28 Nov 2026, admin report): sending the screenshot on
// Messenger searched the dictionary instead of completing the activation.
// Root cause: Botcake forwards a photo as its Facebook CDN URL as the
// message text, so the turn carried a non-empty text, the empty-text
// image hook never fired, and the URL was searched as a dictionary word.
// Fix: an image-URL text is an image turn (the URL goes to handleImage so
// OCR can download it, exactly like the webhook path); an image-like turn
// with no owner stays silent — a URL is never searched.
// ---------------------------------------------------------------------------

const FBCDN_PHOTO_URL = "https://scontent.fcai1-2.fna.fbcdn.net/v/t39.30808-6/123456789_987654321.jpg?_nc_cat=1&ccb=1-7";

test("isBotcakeImageUrlText: fbcdn/scontent URLs and image extensions only", () => {
  assert.equal(isBotcakeImageUrlText(FBCDN_PHOTO_URL), true, "Facebook CDN photo URL is an image turn");
  assert.equal(isBotcakeImageUrlText("https://scontent.xx.fbcdn.net/v/photo.png"), true, "scontent host is an image turn");
  assert.equal(isBotcakeImageUrlText("https://example.com/photo.jpg"), true, "image extension is an image turn");
  assert.equal(isBotcakeImageUrlText("https://example.com/some-page"), false, "a plain page link is not an image turn");
  assert.equal(isBotcakeImageUrlText("https://example.com/page?x=1"), false, "a link with a query is not an image turn");
  assert.equal(isBotcakeImageUrlText("نور"), false, "a word is not an image turn");
  assert.equal(isBotcakeImageUrlText(""), false, "empty text is not an image turn");
  assert.equal(isBotcakeImageUrlText(null), false, "null is not an image turn");
});

// Fetch stub for the URL-turn tests: the macro, the fbcdn image download,
// the OCR.space call (configurable OCR text), and the Send API.
function ocrRecordingFetch(calls, { macroResponse, ocrText }) {
  return async (url, options = {}) => {
    const urlStr = String(url);
    let body = null;
    try { body = JSON.parse(options.body ?? "null"); } catch { body = null; }
    calls.push({ url: urlStr, method: options.method ?? "GET", body });
    if (urlStr === MACRO_URL) return Response.json(macroResponse);
    if (urlStr.startsWith("https://api.ocr.space/")) {
      return Response.json({ OCRExitCode: 1, IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: ocrText }] });
    }
    if (urlStr.includes("fbcdn.net")) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    return Response.json({ recipient_id: PSID, message_id: "mid.test-1" });
  };
}

async function postBotcakeWithFetch(body, kv, fetchImpl, envExtra = {}) {
  const restoreFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
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
      ...envExtra,
    }, ctx);
    assert.equal(response.status, 200);
    const envelope = await response.json();
    await Promise.allSettled(tasks);
    return { envelope, tasks };
  } finally {
    globalThis.fetch = restoreFetch;
  }
}

// Photo as its fbcdn URL, no OCR key: fail-open activation, no search.
test("get-code screenshot as URL: fbcdn URL turn confirms activation, never searches", async () => {
  const kv = fakeKv();
  seedGetCodeDone(kv, { wait: true });
  const calls = [];
  const { envelope } = await postBotcake({ psid: PSID, text: FBCDN_PHOTO_URL }, kv, calls, { success: true, code: "90488651" });
  assert.equal(envelope.text, "", "envelope text cleared after direct send");
  const direct = directTextSends(calls);
  assert.equal(direct.length, 1, "exactly one activation reply");
  assert.match(
    direct[0].body.message.text,
    /تم تفعيل اشتراكك عزيزنا أحمد محمد والرقم الكودي الخاص بك هو: 90488651/u,
    "activation reply carries the stored name and code",
  );
  assert.ok(!calls.some((c) => String(c.url).startsWith("https://api.ocr.space/")), "no OCR call without a key");
  const record = kv.store.get(`user:msgr:${PSID}`);
  assert.equal(record.parity.getcodeScreenshotAwaiting, undefined, "the wait clears after the screenshot");
});

// Photo as its fbcdn URL, OCR key set: the Worker downloads the URL and
// OCR-verifies it (code + own name present) — real verification, not just
// fail-open, on the Botcake path too.
test("get-code screenshot as URL: with OCR key, downloads the URL and OCR-verifies (accept)", async () => {
  const kv = fakeKv();
  seedGetCodeDone(kv, { wait: true });
  const calls = [];
  const fetchImpl = ocrRecordingFetch(calls, {
    macroResponse: { success: true, code: "90488651" },
    ocrText: "Coptic\n90488651\nأحمد محمد",
  });
  const { envelope } = await postBotcakeWithFetch(
    { psid: PSID, text: FBCDN_PHOTO_URL },
    kv,
    fetchImpl,
    { OCR_SPACE_API_KEY: "test-ocr-key" },
  );
  assert.equal(envelope.text, "", "envelope text cleared after direct send");
  assert.ok(calls.some((c) => String(c.url) === FBCDN_PHOTO_URL), "the photo URL is downloaded for OCR");
  assert.ok(calls.some((c) => String(c.url).startsWith("https://api.ocr.space/")), "OCR runs on the downloaded bytes");
  const direct = directTextSends(calls);
  assert.equal(direct.length, 1, "exactly one activation reply");
  assert.match(direct[0].body.message.text, /تم تفعيل اشتراكك عزيزنا أحمد محمد والرقم الكودي الخاص بك هو: 90488651/u);
});

// Photo as its fbcdn URL, OCR key set, screenshot without the code:
// rejected with the single rejection text, wait stays open.
test("get-code screenshot as URL: OCR rejects a screenshot without the code", async () => {
  const kv = fakeKv();
  seedGetCodeDone(kv, { wait: true });
  const calls = [];
  const fetchImpl = ocrRecordingFetch(calls, {
    macroResponse: { success: true, code: "90488651" },
    ocrText: "Coptic\nأحمد محمد",
  });
  const { envelope } = await postBotcakeWithFetch(
    { psid: PSID, text: FBCDN_PHOTO_URL },
    kv,
    fetchImpl,
    { OCR_SPACE_API_KEY: "test-ocr-key" },
  );
  assert.equal(envelope.text, "", "envelope text cleared after direct send");
  const direct = directTextSends(calls);
  assert.equal(direct.length, 1, "exactly one reply");
  assert.match(
    direct[0].body.message.text,
    /قم برفع صورة مضبوطة تُوضح أن الرقم مسجل في جهات اتصالك، وتُوضح اسمك ورقمك الكودي في شات الواتساب\./u,
    "the single rejection text, nothing else",
  );
  assert.ok(!direct.some((d) => /تم تفعيل اشتراكك/u.test(d.body.message.text)), "no activation on a rejected screenshot");
  const record = kv.store.get(`user:msgr:${PSID}`);
  assert.equal(record.parity.getcodeScreenshotAwaiting, true, "the wait stays open so the student can re-send");
});

// Photo as its fbcdn URL with no wait: silence — the URL is never
// searched as a dictionary word.
test("get-code screenshot as URL with no wait: silence, no search", async () => {
  const kv = fakeKv();
  kv.store.set(`user:msgr:${PSID}`, { name: "Tester" });
  const calls = [];
  const { envelope } = await postBotcake({ psid: PSID, text: FBCDN_PHOTO_URL }, kv, calls, { success: true, code: "90488651" });
  assert.equal(envelope.text, "", "nothing in the envelope");
  assert.equal(directTextSends(calls).length, 0, "no direct sends at all");
});

// A plain (non-image) URL as text: silence, never searched.
test("non-image URL text: silence, never searched", async () => {
  const kv = fakeKv();
  kv.store.set(`user:msgr:${PSID}`, { name: "Tester" });
  const calls = [];
  const { envelope } = await postBotcake({ psid: PSID, text: "https://example.com/some-page" }, kv, calls, { success: true, code: "90488651" });
  assert.equal(envelope.text, "", "nothing in the envelope");
  assert.equal(directTextSends(calls).length, 0, "no direct sends at all");
});

// Returning user who never activated: the greeting re-opens the wait, so
// the screenshot sent next completes the activation.
test("get-code returning user who never activated: no code revealed — notice re-sent, wait re-opens, screenshot then activates", async () => {
  const kv = fakeKv();
  seedGetCodeDone(kv, { wait: false, activated: false });
  const calls = [];
  const { envelope } = await postBotcake({ psid: PSID, text: "/getcode" }, kv, calls, { success: true, code: "90488651" });
  assert.equal(envelope.text, "", "envelope text cleared after direct send");
  const direct = directTextSends(calls);
  const allDirect = direct.map((d) => d.body.message.text).join("\n");
  assert.doesNotMatch(allDirect, /مرحباً/u, "no greeting with the code before activation");
  assert.doesNotMatch(allDirect, /الرقم الكودي الخاص بك هو:/u, "the code is never revealed before the screenshot");
  assert.match(allDirect, /لتفعيل اشتراكك/u, "the notice is re-sent so the student uploads the screenshot");
  const images = directImageSends(calls);
  assert.equal(images.length, 1, "the example photo rides along with the notice");
  assert.equal(images[0].body.message.attachment.payload.url, "https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev/getcode-example.jpg");
  const record = kv.store.get(`user:msgr:${PSID}`);
  assert.equal(record.parity.getcodeScreenshotAwaiting, true, "the notice re-opens the wait for a never-activated user");
  const calls2 = [];
  await postBotcake({ psid: PSID, text: FBCDN_PHOTO_URL }, kv, calls2, { success: true, code: "90488651" });
  const direct2 = directTextSends(calls2);
  assert.equal(direct2.length, 1, "exactly one activation reply");
  assert.match(direct2[0].body.message.text, /تم تفعيل اشتراكك عزيزنا أحمد محمد والرقم الكودي الخاص بك هو: 90488651/u);
});

// Returning user who already activated: the greeting does NOT re-open
// the wait — a stray photo/like later cannot re-trigger the activation.
test("get-code returning user who already activated: greeting does not re-open the wait", async () => {
  const kv = fakeKv();
  seedGetCodeDone(kv, { wait: false });
  kv.store.set(`user:msgr:${PSID}`, {
    name: "Tester",
    parity: {
      getcodeScreenshotName: "أحمد محمد",
      getcodeScreenshotCode: "90488651",
      getcodeActivated: true,
    },
  });
  const calls = [];
  await postBotcake({ psid: PSID, text: "/getcode" }, kv, calls, { success: true, code: "90488651" });
  const record = kv.store.get(`user:msgr:${PSID}`);
  assert.equal(record.parity.getcodeScreenshotAwaiting, undefined, "no wait re-opened for an activated user");
});

// /resetcode clears the activation flag too, so the next /getcode runs
// the full flow again.
test("get-code /resetcode clears the activation flag", async () => {
  const kv = fakeKv();
  kv.store.set(`user:msgr:${PSID}`, {
    name: "Tester",
    parity: {
      getcodeScreenshotAwaiting: true,
      getcodeScreenshotName: "أحمد محمد",
      getcodeScreenshotCode: "90488651",
      getcodeActivated: true,
    },
  });
  const calls = [];
  const { envelope } = await postBotcake(
    { psid: PSID, text: "/resetcode" },
    kv,
    calls,
    { success: true, code: "90488651" },
    { MESSENGER_ADMIN_PSID: PSID },
  );
  assert.equal(envelope.text, "", "envelope text cleared after direct send");
  const direct = directTextSends(calls);
  assert.match(direct.map((d) => d.body.message.text).join("\n"), /تم مسح الرقم الكودي المسجّل/u, "reset confirmation sent");
  const record = kv.store.get(`user:msgr:${PSID}`);
  assert.equal(record.parity.getcodeScreenshotName, undefined, "the name record is cleared");
  assert.equal(record.parity.getcodeScreenshotCode, undefined, "the code record is cleared");
  assert.equal(record.parity.getcodeScreenshotAwaiting, undefined, "the wait is cleared");
  assert.equal(record.parity.getcodeActivated, undefined, "the activation flag is cleared");
});
