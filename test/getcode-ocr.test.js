// Get-code screenshot OCR verification (28 Nov 2026, Telegram parity):
// pure-function tests for src/getcode.js. No live network: the OCR call
// is stubbed through fetchImpl.
import test from "node:test";
import assert from "node:assert/strict";
import {
  GET_CODE_WHATSAPP_NUMBER,
  GET_CODE_SCREENSHOT_UNSAVED_TEXT,
  GET_CODE_SCREENSHOT_NO_CODE_TEXT,
  OCR_SPACE_API_URL,
  normalizeOcrDigits,
  checkScreenshotOcrText,
  ocrScreenshotText,
  verifyScreenshotOcr,
} from "../src/getcode.js";

test("OCR rejection texts: unsaved is the user's exact wording, no-code unchanged", () => {
  assert.equal(
    GET_CODE_SCREENSHOT_UNSAVED_TEXT,
    "قم برفع صورة مضبوطة تُوضح أن الرقم مسجل في جهات اتصالك.",
    "no emoji, no phone number, word-for-word",
  );
  assert.equal(
    GET_CODE_SCREENSHOT_NO_CODE_TEXT,
    "⚠️ رسالة التسجيل مش ظاهرة في السكرين — اتأكد إنك بعت الرسالة على الواتساب، وبعدين ابعت سكرين شوت تاني.",
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
  for (const form of ["+201207829388", "+20 120 782 9388", "01207829388", "٠١٢٠٧٨٢٩٣٨٨", "201207829388"]) {
    assert.deepEqual(
      checkScreenshotOcrText(`${form}\nتم التسجيل، الرقم الكودي الخاص بي: ${code}`, code),
      { verdict: "unsaved-number" },
      `form ${form}`,
    );
  }
});

test("checkScreenshotOcrText: saved name (any language) + code present accepts", () => {
  const code = "13312860";
  for (const header of ["Coptic Dictionary", "أحمد محمد", "John Smith", "القاموس القبطي"]) {
    assert.deepEqual(
      checkScreenshotOcrText(`${header}\nتم التسجيل، الرقم الكودي الخاص بي: ${code}، اسمي: لمياء وائل شرف`, code),
      { verdict: "ok" },
      `header ${header}`,
    );
  }
});

test("checkScreenshotOcrText: code missing rejects as no-code", () => {
  assert.deepEqual(checkScreenshotOcrText("Coptic Dictionary\nتم التسجيل", "13312860"), { verdict: "no-code" });
  assert.deepEqual(checkScreenshotOcrText("", "13312860"), { verdict: "no-code" });
});

test("checkScreenshotOcrText: unsaved number wins over a missing code", () => {
  assert.deepEqual(checkScreenshotOcrText("+201207829388", "13312860"), { verdict: "unsaved-number" });
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
