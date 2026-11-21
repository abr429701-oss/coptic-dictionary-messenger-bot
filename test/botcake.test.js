// POST /botcake helpers: input parsing (tolerant of Botcake's variable
// names) and the flat JSON envelope the flow maps to variables.
import test from "node:test";
import assert from "node:assert/strict";
import { parseBotcakeInput, planToBotcakeEnvelope } from "../src/index.js";

const url = (qs = "") => new URL(`https://example.workers.dev/botcake${qs}`);

test("parseBotcakeInput accepts the canonical field names", () => {
  const input = parseBotcakeInput(
    { psid: "28955648934116129", text: "ⲁⲅⲁⲡⲏ", conversation_id: "c_1" },
    url(),
  );
  assert.equal(input.psid, "28955648934116129");
  assert.equal(input.text, "ⲁⲅⲁⲡⲏ");
  assert.equal(input.payload, null);
  assert.equal(input.conversationId, "c_1");
});

test("parseBotcakeInput accepts alternate field names", () => {
  const input = parseBotcakeInput(
    { sender_id: "111", message_text: "hello", quick_reply_payload: "pick|42" },
    url(),
  );
  assert.equal(input.psid, "111");
  assert.equal(input.text, "hello");
  assert.equal(input.payload, "pick|42");
});

test("parseBotcakeInput falls back to query params and reports a missing psid", () => {
  const fromQuery = parseBotcakeInput(null, url("?psid=222&text=abc"));
  assert.equal(fromQuery.psid, "222");
  assert.equal(fromQuery.text, "abc");
  const missing = parseBotcakeInput({ text: "abc" }, url());
  assert.equal(missing.psid, null);
  assert.equal(missing.text, "abc");
});

test("planToBotcakeEnvelope maps a word-card plan", () => {
  const envelope = planToBotcakeEnvelope({
    texts: [{ text: "ⲁⲅⲁⲡⲏ — محبة" }],
    voiceUrl: "https://example.r2.dev/audio/123.ogg",
    voiceRepeats: 3,
  });
  assert.equal(envelope.text, "ⲁⲅⲁⲡⲏ — محبة");
  assert.equal(envelope.text2, "");
  assert.equal(envelope.text3, "");
  assert.equal(envelope.voice_url, "https://example.r2.dev/audio/123.ogg");
  assert.equal(envelope.image_url, "");
  assert.equal(envelope.quick_replies, "");
  assert.equal(envelope.has_text, "yes");
  assert.equal(envelope.has_text2, "no");
  assert.equal(envelope.has_text3, "no");
  assert.equal(envelope.has_image, "no");
  assert.equal(envelope.action, "none");
});

test("planToBotcakeEnvelope takes quick replies from the last text that has them", () => {
  const replies = [
    { content_type: "text", title: "التالي ⏭", payload: "list|next" },
    { content_type: "text", title: "ⲁⲅⲁⲡⲏ", payload: "pick|12" },
  ];
  const envelope = planToBotcakeEnvelope({
    texts: [
      { text: "page 1" },
      { text: "page 2", quickReplies: replies },
    ],
    voiceUrl: null,
  });
  assert.equal(envelope.text, "page 1");
  assert.equal(envelope.text2, "page 2");
  assert.deepEqual(JSON.parse(envelope.quick_replies), [
    { title: "التالي ⏭", payload: "list|next" },
    { title: "ⲁⲅⲁⲡⲏ", payload: "pick|12" },
  ]);
});

test("planToBotcakeEnvelope splits an over-long text into <=300-char chunks", () => {
  const lines = ["🎓 المستوى الأول — اختر:"];
  for (let i = 1; i <= 21; i++) lines.push(`${i}. الدرس رقم ${i} — عنوان طويل للدرس`);
  const longText = lines.join("\n");
  assert.ok(longText.length > 320, `fixture is ${longText.length} chars`);
  const envelope = planToBotcakeEnvelope({ texts: [{ text: longText }] });
  for (const key of ["text", "text2", "text3"]) {
    assert.ok(envelope[key].length <= 300, `${key} is ${envelope[key].length} chars`);
  }
  assert.equal(envelope.has_text, "yes");
  assert.equal(envelope.has_text2, "yes");
  assert.equal(envelope.has_text3, "yes");
  // The split is lossless: rejoining the chunks gives the original text.
  const rejoined = [envelope.text, envelope.text2, envelope.text3].join("\n\n");
  assert.ok(longText.split("\n").every((line) => rejoined.includes(line)));
});

test("planToBotcakeEnvelope keeps quick replies on the last piece of a split text", () => {
  const replies = [{ content_type: "text", title: "التالي ⏭", payload: "list|next" }];
  const longText = Array.from({ length: 60 }, (_, i) => `سطر ${i + 1}`).join("\n");
  const envelope = planToBotcakeEnvelope({
    texts: [{ text: longText, quickReplies: replies }],
  });
  assert.ok(envelope.text.length > 0 && envelope.text2.length > 0);
  assert.deepEqual(JSON.parse(envelope.quick_replies), [
    { title: "التالي ⏭", payload: "list|next" },
  ]);
});

test("planToBotcakeEnvelope joins extra text chunks into text3 and takes the first image", () => {
  const envelope = planToBotcakeEnvelope({
    texts: [{ text: "one" }, { text: "two" }, { text: "three" }, { text: "four" }],
    attachments: [{ type: "image", url: "https://example.r2.dev/lessons/1.jpg" }],
  });
  assert.equal(envelope.text, "one");
  assert.equal(envelope.text2, "two");
  assert.equal(envelope.text3, "three\n\nfour");
  assert.equal(envelope.image_url, "https://example.r2.dev/lessons/1.jpg");
  assert.equal(envelope.has_text, "yes");
  assert.equal(envelope.has_text2, "yes");
  assert.equal(envelope.has_text3, "yes");
  assert.equal(envelope.has_image, "yes");
});

test("planToBotcakeEnvelope splits image and video attachments", () => {
  const envelope = planToBotcakeEnvelope({
    texts: [{ text: "lesson" }],
    attachments: [
      { type: "video", url: "https://example.r2.dev/lessons/1.mp4" },
      { type: "image", url: "https://example.r2.dev/lessons/1.jpg" },
    ],
  });
  assert.equal(envelope.video_url, "https://example.r2.dev/lessons/1.mp4");
  assert.equal(envelope.image_url, "https://example.r2.dev/lessons/1.jpg");
  assert.equal(envelope.has_video, "yes");
  assert.equal(envelope.has_image, "yes");
});

test("planToBotcakeEnvelope degrades an empty plan to empty fields", () => {
  assert.deepEqual(planToBotcakeEnvelope(null), {
    text: "",
    text2: "",
    text3: "",
    voice_url: "",
    image_url: "",
    video_url: "",
    quick_replies: "",
    has_text: "no",
    has_text2: "no",
    has_text3: "no",
    has_image: "no",
    has_video: "no",
    action: "none",
  });
  assert.deepEqual(planToBotcakeEnvelope({ texts: [] }), {
    text: "",
    text2: "",
    text3: "",
    voice_url: "",
    image_url: "",
    video_url: "",
    quick_replies: "",
    has_text: "no",
    has_text2: "no",
    has_text3: "no",
    has_image: "no",
    has_video: "no",
    action: "none",
  });
});

test("planToBotcakeEnvelope leaves a certificate's photoBytes out of the envelope", () => {
  // A ready certificate arrives as BYTES (plan.photoBytes), not a URL.
  // The Worker sends those bytes itself via the Send API (multipart) in
  // the /botcake handler — the envelope carries only the caption text, so
  // image_url stays empty and the flow's Image step does not fire.
  const envelope = planToBotcakeEnvelope({
    texts: [{ text: "🎓 شهادتك 🎓" }],
    photoBytes: { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png", fileName: "certificate.png" },
  });
  assert.equal(envelope.text, "🎓 شهادتك 🎓");
  assert.equal(envelope.image_url, "");
  assert.equal(envelope.has_image, "no");
});

test("planToBotcakeEnvelope flags are always real yes/no strings, never empty", () => {
  for (const plan of [null, { texts: [] }, { texts: [{ text: "x" }] }]) {
    const envelope = planToBotcakeEnvelope(plan);
    for (const key of ["has_text", "has_text2", "has_text3", "has_image", "has_video"]) {
      assert.ok(envelope[key] === "yes" || envelope[key] === "no", `${key} is ${envelope[key]}`);
    }
  }
});
