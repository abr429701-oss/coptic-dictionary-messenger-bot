// "الحصول على الرقم الكودي" — fetch the student's code inside Telegram.
//
// The feature lives in apps-script/Code.gs (generateAndStoreCode, copied
// verbatim from the final registration project «المشروع النهائي للرقم
// الكودي»): code = 1234567 + last-8-digits of the phone, stored as [code,
// name, phone] in columns A/B/C of the "code" sheet of spreadsheet
// 1Cts5whXGJTaXTvjlbR7Mt31rQE5hPzkQavslHhYTxgI («تجميع الرقم الكودي») —
// appending only when the phone is new; an existing phone returns the
// same code without storing.
// The bot replicates that flow in chat: it asks for the name, then the
// phone, then POSTs {name, phone} to the bot's own Apps Script web app
// (the /setdrive URL or the APPS_SCRIPT_URL secret — see driveConfig in
// src/index.js) and shows the returned code with a ready WhatsApp link to
// 201207829388. The storage happens in Code.gs, exactly per the file's
// logic — the Worker never writes to the sheet itself (gviz is read-only).
// Code.gs answers through its json_() helper, so the bot gets real JSON
// (the standalone project's doPost returned a plain object, which a web
// app cannot return — verified live 2026-11-09, and nothing was stored).
export const GET_CODE_WHATSAPP_NUMBER = "201207829388";
// The example screenshot the success reply refers to ("الصورة
// المرفقة"): a WhatsApp chat with the admin showing the code message,
// so the student sees exactly what screenshot to send back. Hosted on
// R2 (public) — the same file Telegram uses.
export const GET_CODE_EXAMPLE_PHOTO_URL = "https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev/getcode-example.jpg";
// Where Code.gs stores the codes (documentation — the Worker never
// writes here; generateAndStoreCode in apps-script/Code.gs does).
export const GET_CODE_SHEET_ID = "1Cts5whXGJTaXTvjlbR7Mt31rQE5hPzkQavslHhYTxgI";

// The form strips non-digits as the user types (validateInput) and
// requires at least 8 digits (the code uses the last 8).
export function normalizeGetCodePhone(phone) {
  return String(phone ?? "").replace(/\D/gu, "");
}

export function getCodePhoneValid(phone) {
  return normalizeGetCodePhone(phone).length >= 4;
}

// A ready WhatsApp chat with the admin, pre-filled with the student's
// code and name — tapping it opens the chat with the message ready to
// send. When the admin receives that message, that IS the proof the
// student completed the step (and the code in the message matches the
// sheet). A contact list cannot be checked from Telegram or a web page,
// so the arriving message — not the saved contact — is what gets
// verified.
//
// The pre-filled text is Telegram's exact wording (28 Nov 2026
// redesign, mirrored here «بنفس النظام بالملي»): "تم التسجيل، الرقم
// الكودي الخاص بي: {code}، اسمي: {name}" — the same message the
// example screenshot shows the student sending. The resulting wa.me
// URL is ~370 chars for a normal triple name, which the OLD Botcake
// chunk splitter would have cut mid-URL (live bug 22 Nov 2026, when
// the reply rode the envelope) — but the success reply now bypasses
// the envelope entirely (Worker direct-send of the whole text, like
// /share), so the long link arrives whole. The short "كودي: X،
// اسمي: Y" workaround is retired; no link shortener, ever.
export function buildGetCodeWhatsAppUrl(code, name) {
  const text = `تم التسجيل، الرقم الكودي الخاص بي: ${code}، اسمي: ${name}`;
  return `https://wa.me/${GET_CODE_WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

// The reply (Telegram's exact text, 28 Nov 2026 redesign, corrected
// the same night): NO name or code lines — it starts directly with
// the activation steps (save the admin number, open the WhatsApp chat
// from the link, screenshot it, and send the screenshot back here in
// the chat to complete the activation). The student first sees their
// name and code in the ACTIVATION reply after the screenshot is
// accepted. The name+code still travel inside the wa.me link's
// pre-filled text. Messenger's Send API has no photo captions, so
// this goes as a text message followed by the example screenshot image
// (same words, same order) — see the getCodePhotoReply direct-send
// block in src/index.js.
export function buildGetCodeReply(name, code) {
  return `لتفعيل اشتراكك، سجّل هذا الرقم +${GET_CODE_WHATSAPP_NUMBER} في جهات اتصالك أولاً، ثم اضغط على رابط الواتساب التالي:\n${buildGetCodeWhatsAppUrl(code, name)}\nلفتح المحادثة مع الرقم على الواتساب، ثم التقط Screenshot للشاشة على سبيل المثال مثل الشكل الموضح في الصورة المرفقة، ثم أرسلها هنا في الشات لإتمام التفعيل.`;
}

// POST {name, phone} to the bot's Apps Script web app (apps-script/Code.gs).
// `macroUrl` is the bot's Apps Script URL (driveConfig: the /setdrive URL
// or the APPS_SCRIPT_URL secret); without it there is nothing to call.
// Returns { code, message } on success, or { code: null, error } — the
// error is a short key the caller turns into the fallback (the
// instructions text), never a raw dump. `fetchImpl` exists so tests can
// stub the call.
export async function getCodeFromMacro(name, phone, macroUrl, fetchImpl = fetch) {
  const cleanPhone = normalizeGetCodePhone(phone);
  if (!macroUrl) return { code: null, error: "macro-unreachable" };
  try {
    const resp = await fetchImpl(macroUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: String(name ?? "").trim(), phone: cleanPhone }),
      signal: AbortSignal.timeout(30000),
    });
    const raw = await resp.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { data = null; }
    if (!resp.ok || !data || data.success !== true || data.code === undefined || data.code === null) {
      return { code: null, error: "macro-unreadable" };
    }
    return { code: String(data.code), message: String(data.message ?? ""), error: null };
  } catch {
    return { code: null, error: "macro-unreachable" };
  }
}
