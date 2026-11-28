// Get-code screenshot OCR verification (28 Nov 2026, Telegram parity):
// pure-function tests for src/getcode.js. No live network: the OCR call
// is stubbed through fetchImpl.
import test from "node:test";
import assert from "node:assert/strict";
import {
  GET_CODE_WHATSAPP_NUMBER,
  GET_CODE_SCREENSHOT_UNSAVED_TEXT,
  OCR_SPACE_API_URL,
  normalizeOcrDigits,
  normalizeOcrName,
  checkScreenshotOcrText,
  ocrScreenshotText,
  verifyScreenshotOcr,
} from "../src/getcode.js";

test("OCR rejection text: ONE text for every screenshot rejection, the user's exact final wording", () => {
  assert.equal(
    GET_CODE_SCREENSHOT_UNSAVED_TEXT,
    "قم برفع صورة مضبوطة تُوضح أن الرقم مسجل في جهات اتصالك، وتُوضح اسمك ورقمك الكودي في شات الواتساب.",
    "no emoji, no phone number, word-for-word",
  );
});

test("normalizeOcrDigits: Arabic-Indic and Persian digits fold to Western", () => {
  assert.equal(normalizeOcrDigits("٠١٢٠٧٨٢٩٣٨٨"), "01207829388");
  assert.equal(normalizeOcrDigits("۰۱۲۰۷۸۲۹۳۸۸"), "01207829388");
  assert.equal(normalizeOcrDigits("+20 120 782 9388"), "201207829388");
  assert.equal(normalizeOcrDigits("Coptic 13312860"), "13312860");
  assert.equal(normalizeOcrDigits(""), "");
});

test("checkScreenshotOcrText: unsaved number in any form rejects", () => {
  const code = "13312860";
  const name = "لمياء وائل شرف";
  for (const form of ["+201207829388", "+20 120 782 9388", "01207829388", "٠١٢٠٧٨٢٩٣٨٨", "201207829388"]) {
    assert.deepEqual(
      checkScreenshotOcrText(`${form}\nتم التسجيل، الرقم الكودي الخاص بي: ${code}، اسمي: ${name}`, code, name),
      { verdict: "unsaved-number" },
      `form ${form}`,
    );
  }
});

test("checkScreenshotOcrText: saved name (any language) + own code + own name accepts", () => {
  const code = "13312860";
  const name = "لمياء وائل شرف";
  for (const header of ["Coptic Dictionary", "أحمد محمد", "John Smith", "القاموس القبطي"]) {
    assert.deepEqual(
      checkScreenshotOcrText(`${header}\nتم التسجيل، الرقم الكودي الخاص بي: ${code}، اسمي: ${name}`, code, name),
      { verdict: "ok" },
      `header ${header}`,
    );
  }
});

test("checkScreenshotOcrText: code missing rejects as no-code", () => {
  assert.deepEqual(checkScreenshotOcrText("Coptic Dictionary\nتم التسجيل", "13312860", "لمياء وائل شرف"), { verdict: "no-code" });
  assert.deepEqual(checkScreenshotOcrText("", "13312860", "لمياء وائل شرف"), { verdict: "no-code" });
});

test("checkScreenshotOcrText: unsaved number wins over a missing code", () => {
  assert.deepEqual(checkScreenshotOcrText("+201207829388", "13312860", "لمياء وائل شرف"), { verdict: "unsaved-number" });
});

test("normalizeOcrName: diacritics/tatweel stripped, alef/yeh/teh unified, spaces and punctuation dropped, Latin lowercased", () => {
  assert.equal(normalizeOcrName("أَحْمَد مُحَمَّد"), "احمدمحمد");
  assert.equal(normalizeOcrName("لَمْياء وَائِل شَرَف"), "لمياءوائلشرف");
  assert.equal(normalizeOcrName("آيةُ — مُحَمَّـد!"), "ايهمحمد");
  assert.equal(normalizeOcrName("فاطمة الزهراء"), "فاطمهالزهراء");
  assert.equal(normalizeOcrName("John Smith"), "johnsmith");
  assert.equal(normalizeOcrName(""), "");
  assert.equal(normalizeOcrName(null), "");
});

test("checkScreenshotOcrText: a DIFFERENT name rejects as name-mismatch (another student's screenshot)", () => {
  // Right code, wrong name: the cheat the user showed — a screenshot of
  // someone else's chat (or the example image) where the number shows
  // saved, but the name in it is not the uploader's.
  assert.deepEqual(
    checkScreenshotOcrText("Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: أحمد محمد علي", "13312860", "لمياء وائل شرف"),
    { verdict: "name-mismatch" },
  );
});

test("checkScreenshotOcrText: right name, wrong code rejects as no-code (code is the strict check)", () => {
  assert.deepEqual(
    checkScreenshotOcrText("Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 99999999، اسمي: لمياء وائل شرف", "13312860", "لمياء وائل شرف"),
    { verdict: "no-code" },
  );
});

test("checkScreenshotOcrText: name with diacritics / hamza variation still accepts", () => {
  // Stored "أحمد محمد", OCR reads it with tashkeel or without hamza —
  // normalization makes both sides the same.
  assert.deepEqual(
    checkScreenshotOcrText("Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: أَحْمَد مُحَمَّد", "13312860", "أحمد محمد"),
    { verdict: "ok" },
  );
  assert.deepEqual(
    checkScreenshotOcrText("Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: احمد محمد", "13312860", "أحمد محمد"),
    { verdict: "ok" },
  );
});

test("checkScreenshotOcrText: empty stored name skips the name check (fail open)", () => {
  assert.deepEqual(
    checkScreenshotOcrText("Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: أحمد محمد علي", "13312860", ""),
    { verdict: "ok" },
  );
  assert.deepEqual(
    checkScreenshotOcrText("Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860", "13312860", null),
    { verdict: "ok" },
  );
});

test("checkScreenshotOcrText: Coptic/Greek-only names skip the name check (OCR cannot read those scripts)", () => {
  // OCR.space reads Arabic+English+digits only, so a Coptic/Greek name
  // can never appear in the OCR text — the name check must not reject
  // a correct screenshot for its name's script. The code check is the
  // strict gate and still applies.
  assert.deepEqual(
    checkScreenshotOcrText("Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: Ⲁⲃⲣⲁⲁⲙ", "13312860", "Ⲁⲃⲣⲁⲁⲙ"),
    { verdict: "ok" },
  );
  assert.deepEqual(
    checkScreenshotOcrText("Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: Αβραάμ", "13312860", "Αβραάμ"),
    { verdict: "ok" },
  );
  // Mixed Arabic+Coptic: the Arabic part is still checked.
  assert.deepEqual(
    checkScreenshotOcrText("Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: ابرام Ⲁⲃⲣⲁⲁⲙ", "13312860", "ابرام Ⲁⲃⲣⲁⲁⲙ"),
    { verdict: "ok" },
  );
  assert.deepEqual(
    checkScreenshotOcrText("Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: أحمد محمد", "13312860", "ابرام Ⲁⲃⲣⲁⲁⲙ"),
    { verdict: "name-mismatch" },
  );
});

function ocrFetch(result) {
  return async (url) => {
    assert.equal(String(url), OCR_SPACE_API_URL);
    return { ok: true, json: async () => result };
  };
}

test("verifyScreenshotOcr: no key → skipped without any fetch call", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error("must not be called"); };
  assert.deepEqual(await verifyScreenshotOcr(new Uint8Array([1, 2, 3]), "13312860", null, fetchImpl), { verdict: "skipped" });
  assert.deepEqual(await verifyScreenshotOcr(new Uint8Array([1, 2, 3]), "13312860", "", fetchImpl), { verdict: "skipped" });
  assert.equal(called, false);
});

test("verifyScreenshotOcr: oversize image → skipped without any fetch call", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error("must not be called"); };
  assert.deepEqual(
    await verifyScreenshotOcr(new Uint8Array(1048577), "13312860", "test-key", fetchImpl),
    { verdict: "skipped" },
  );
  assert.equal(called, false);
});

test("verifyScreenshotOcr: OCR error / empty text → skipped", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  assert.deepEqual(
    await verifyScreenshotOcr(bytes, "13312860", "test-key", ocrFetch({ OCRExitCode: 1, IsErroredOnProcessing: true, ParsedResults: [] })),
    { verdict: "skipped" },
  );
  assert.deepEqual(
    await verifyScreenshotOcr(bytes, "13312860", "test-key", ocrFetch({ OCRExitCode: 1, IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: "   " }] })),
    { verdict: "skipped" },
  );
  assert.deepEqual(
    await verifyScreenshotOcr(bytes, "13312860", "test-key", async () => { throw new Error("network down"); }),
    { verdict: "skipped" },
  );
});

test("verifyScreenshotOcr: name check runs through the OCR path (own name ok, other name name-mismatch)", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const own = "Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: لمياء وائل شرف";
  const other = "Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: أحمد محمد علي";
  assert.deepEqual(
    await verifyScreenshotOcr(bytes, "13312860", "test-key", ocrFetch({ OCRExitCode: 1, IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: own }] }), "لمياء وائل شرف"),
    { verdict: "ok" },
  );
  assert.deepEqual(
    await verifyScreenshotOcr(bytes, "13312860", "test-key", ocrFetch({ OCRExitCode: 1, IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: other }] }), "لمياء وائل شرف"),
    { verdict: "name-mismatch" },
  );
});

test("ocrScreenshotText: sends base64, never a URL (no token ever leaves the Worker)", async () => {
  let seenBody = null;
  const fetchImpl = async (url, options) => {
    seenBody = new URLSearchParams(options.body);
    return {
      ok: true,
      json: async () => ({ OCRExitCode: 1, IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: "hello" }] }),
    };
  };
  const { text, error } = await ocrScreenshotText(new Uint8Array([0xff, 0xd8, 0xff]), "test-key", fetchImpl);
  assert.equal(error, null);
  assert.equal(text, "hello");
  assert.equal(seenBody.get("apikey"), "test-key");
  assert.ok(seenBody.get("base64Image").startsWith("data:image/jpeg;base64,"), "base64 upload, not a URL");
  assert.equal(seenBody.get("url"), null, "no image URL is ever shared with the OCR service");
  assert.equal(seenBody.get("OCREngine"), "2");
  assert.equal(String(GET_CODE_WHATSAPP_NUMBER), "201207829388");
});
