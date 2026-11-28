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


test("checkScreenshotOcrText: the name is NEVER checked (user rule 28 Nov 2026) — only the number being saved and the code matter", () => {
  // Right code + number saved: any name (different, missing, Coptic,
  // Greek, mixed) accepts. The code is unique per student, so another
  // student's screenshot shows a different code (→ no-code).
  const code = "13312860";
  for (const [ocr, name] of [
    ["Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: أحمد محمد علي", "لمياء وائل شرف"],
    ["Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860", "لمياء وائل شرف"],
    ["Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: Ⲁⲃⲣⲁⲁⲙ", "Ⲁⲃⲣⲁⲁⲙ"],
    ["Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: Αβραάμ", "Αβραάμ"],
    ["Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: ابرام Ⲁⲃⲣⲁⲁⲙ", "ابرام Ⲁⲃⲣⲁⲁⲙ"],
    ["Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: أحمد محمد", ""],
  ]) {
    assert.deepEqual(checkScreenshotOcrText(ocr, code, name), { verdict: "ok" }, `name ${name}`);
  }
});

test("checkScreenshotOcrText: right name, wrong code rejects as no-code (code is the strict check)", () => {
  assert.deepEqual(
    checkScreenshotOcrText("Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 99999999، اسمي: لمياء وائل شرف", "13312860", "لمياء وائل شرف"),
    { verdict: "no-code" },
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

test("verifyScreenshotOcr: the name is never checked through the OCR path (own name and other name both ok)", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const own = "Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: لمياء وائل شرف";
  const other = "Coptic\nتم التسجيل، الرقم الكودي الخاص بي: 13312860، اسمي: أحمد محمد علي";
  assert.deepEqual(
    await verifyScreenshotOcr(bytes, "13312860", "test-key", ocrFetch({ OCRExitCode: 1, IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: own }] }), "لمياء وائل شرف"),
    { verdict: "ok" },
  );
  assert.deepEqual(
    await verifyScreenshotOcr(bytes, "13312860", "test-key", ocrFetch({ OCRExitCode: 1, IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: other }] }), "لمياء وائل شرف"),
    { verdict: "ok" },
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
