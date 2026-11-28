// src/messenger-parity.js
//
// Facebook Messenger full-parity handlers: learn (levels / lessons /
// exams), certificates, get-code, and the admin subset. This module is
// the Messenger twin of the WhatsApp port's learn.js / cert.js /
// getcode.js / exams.js / admin.js, adapted to Messenger's constraints:
//
// - Plain text only (no HTML). Telegram's <b> becomes *bold* via
//   plainTextCard (src/messenger.js).
// - Quick replies are the ONLY tap mechanism (standing rule: no inline
//   keyboards, no generic templates). Every menu/list carries its quick
//   replies on the LAST text message of the turn: in Messenger, quick
//   replies vanish from the composer once the Page sends a later message
//   without them, so the send loop must NEVER send a trailing message
//   after a menu/list in the same turn. Send order (see the wiring spec
//   in the report): attachments first, then photoBytes, then texts (quick
//   replies on the last text), then voiceUrl. Lesson media therefore goes
//   out before the exercise text — which is also Telegram's order
//   (video -> photo -> text -> exam).
// - Stateless picks where possible: quick-reply payloads carry the
//   lesson / level / admin action id (learn|lesson:<id>, ...). The only
//   per-user state is the multi-step flows (cert code entry, get-code
//   name -> phone, the exam code gate, pending broadcast, last lesson /
//   menu for bare-number and nav-word picks) — stored in the SAME
//   UserStore Durable Object user record Telegram uses (getUser /
//   saveUser in src/index.js), under a Messenger-namespaced id
//   (`msgr:<PSID>`), via the injected loadState / saveState. There is NO
//   second store. The bare-number hook for the dictionary agent: a plan
//   carries `menuList` ({ kind, items }) describing the numbered list it
//   just sent, and the same menuList is kept in state; a bare number
//   arriving while state.menuList is set is resolved here before the
//   dictionary search runs.
// - Voices: parity plans carry voiceUrl (null — lessons have no word
//   voice of their own). Word-card voices stay with the dictionary core
//   agent, which sends the prebuilt OGG URL as a separate message after
//   the text (live-verified: Messenger plays the OGG URL; no MP3 switch).
//
// SYNC (no second sync system — this module reads the SAME live sources
// Telegram does, so a Sheet / dictionary / media edit lands in Messenger
// through the existing pipelines):
// - Learn levels/lessons: LEARN_LEVELS from src/learn-manifest.js — the
//   frozen manifest the deploy workflow regenerates from the live
//   "coptic" Sheet every 30 min and deploys on change. A Sheet edit ->
//   manifest commit -> deploy -> this module serves the new lessons.
// - Lesson media: direct public R2 URLs in the attachment (the fast
//   path — no download, no re-upload, no Worker /media proxy hop per
//   send). The user reported hangs/delays around media: the ONLY slow
//   path left in this module is the ready-certificate image, which
//   arrives as bytes (lookupCertificate downloads it once from Google,
//   then the coordinator uploads it to Meta) — inherited from Telegram,
//   where passing Google a slow export URL hung the webhook. A cert is
//   a rare one-off send, unlike lesson media; the fast-path alternative
//   (send the derived Google export URL as an image attachment and let
//   Meta fetch it) reintroduces the slow-Google risk and is NOT used.
// - Certificates: lookupCertificate (src/certificates.js) reads the live
//   cert Sheets (gviz) on every lookup — settings cached 60 s only.
// - Get-code: getCodeFromMacro (src/getcode.js) POSTs to the same Apps
//   Script macro Telegram uses; the code formula lives in the macro.
// - Exams: the gate checks the baked pattern first (examForms dep — the
//   webapp's learn-app/exams.json), then the form's LIVE pattern via the
//   injected fetchLiveExamPattern (index.js's own function, 5-min cache),
//   and FAILS CLOSED. The teacher's sequencing lives in the Forms.
// - Dictionary: not read here — the dictionary core agent owns search.
//
// This module never imports src/index.js (no cycle). Everything live is
// injected through createMessengerParity(deps) with safe defaults, so
// tests run with fakes and no network.

import { LEARN_LEVELS } from "./learn-manifest.js";
import { LEARN_GET_CODE_TEXT } from "./learn-text.js";
import { lookupCertificate } from "./certificates.js";
import {
  getCodeFromMacro,
  buildGetCodeReply,
  getCodePhoneValid,
  GET_CODE_EXAMPLE_PHOTO_URL,
  GET_CODE_SCREENSHOT_UNSAVED_TEXT,
  verifyScreenshotOcr,
} from "./getcode.js";
import { copticNameReply } from "./coptic-name.js";
import { buildQuickReplies, plainTextCard } from "./messenger.js";
import { parseScheduleTime, formatCairoDateTime } from "./schedule-time.js";
import { PARKED_DISPATCH_MESSAGES } from "./dispatch-commands.js";
import { listRecordedVoiceIds, recordedManifestFilename } from "./neural-voice.js";
import {
  RECORDED_OVERLAY_KEY,
  RECORDED_R2_PREFIX,
  MAX_RECORD_BYTES,
  RECORD_AUDIO_TIMEOUT_MS,
  cleanMimeType,
  recordedFileName,
  recordPrompt,
  mergeRecordedIds,
  applyVoiceDelete,
  voiceDeleteR2Keys,
} from "./record-voice.js";

export const WORKER_BASE_URL = "https://coptic-dictionary-messenger-bot.abr429701.workers.dev";
// The learn web app + privacy page stay on the Telegram Worker (see the
// split notes in README.md); LEARN_APP_URL is deliberately NOT derived
// from WORKER_BASE_URL anymore.
export const LEARN_APP_URL = "https://coptic-dictionary-bot.abr429701.workers.dev/learn-app/?v=2";
export const R2_MEDIA_BASE_URL = "https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev";

// Quick-reply payload namespaces. "pick|<index>" belongs to the
// dictionary core agent; these three belong to this module.
export const MESSENGER_PARITY_PAYLOAD_PREFIXES = ["learn|", "cert|", "admin|", "record|"];

export const BROADCAST_MAX_CHARS = 4000;
export const CERT_NOT_FOUND_TEXT = "الرقم الكودي غير صحيح.";
export const CERT_ASK_TEXT = "أدخل الرقم الكودي. ";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Arabic-Indic (٠-٩), Eastern Arabic-Indic (۰-۹) and fullwidth (０-９)
// digits are the default on Arabic keyboards: fold them to ASCII before
// any number is parsed, or "٦" becomes a search instead of pick 6 — and
// a code typed as ١٢٣٤٥٦ must give the same result as 123456.
export function foldDigits(value) {
  return String(value ?? "")
    .replace(/[٠-٩]/gu, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/gu, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[０-９]/gu, (d) => String(d.charCodeAt(0) - 0xff10));
}

// Messenger has no alignment control: a line's base direction comes from
// its first strong character, so a numbered Arabic line ("1. الأوامر…")
// or an emoji-led line can flip to the wrong side — Arabic must sit
// right, English left. Prefix every line of the command displays with
// the mark matching its first strong character (RLM for Arabic, LRM for
// Latin/Coptic/Greek) so each line renders on its own correct side.
const RLM = "\u200F";
const LRM = "\u200E";
export function directLine(line) {
  for (const ch of String(line ?? "")) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x0600 && code <= 0x06ff) ||
      (code >= 0x0750 && code <= 0x077f) ||
      (code >= 0x08a0 && code <= 0x08ff) ||
      (code >= 0xfb50 && code <= 0xfdff) ||
      (code >= 0xfe70 && code <= 0xfeff)
    ) return `${RLM}${line}`;
    if (
      (code >= 0x0041 && code <= 0x005a) ||
      (code >= 0x0061 && code <= 0x007a) ||
      (code >= 0x0370 && code <= 0x03ff) ||
      (code >= 0x2c80 && code <= 0x2cff)
    ) return `${LRM}${line}`;
  }
  return String(line ?? "");
}
export function directLines(text) {
  return String(text ?? "").split("\n").map(directLine).join("\n");
}

// Get-code phone, Telegram-style (strip non-digits, need >= 4), after
// folding Arabic-Indic digits — Telegram's own normalizer would strip
// them entirely, the WhatsApp port folds first, and so do we.
export function normalizeGetCodePhoneMsgr(phone) {
  return foldDigits(String(phone ?? "")).replace(/\D/gu, "");
}

export function getCodePhoneValidMsgr(phone) {
  return getCodePhoneValid(normalizeGetCodePhoneMsgr(phone));
}

export function isCertCodeShape(code) {
  return /^\d{6,10}$/u.test(foldDigits(String(code ?? "").trim()));
}

// The exam code check, exactly like Google's "matches" validation
// (full-string match against the alternation of allowed codes) — a
// verbatim port of the web app's codeMatches(). If the pattern is too
// big for the regex engine, fall back to a plain set lookup of the same
// alternatives; if that cannot be done either, block (fail closed).
export function codeMatches(pattern, value) {
  const v = String(value ?? "");
  try {
    return new RegExp(`^(?:${pattern})$`).test(v);
  } catch { /* fall through to the set check */ }
  const p = String(pattern ?? "");
  if (p.charAt(0) === "(" && p.charAt(p.length - 1) === ")") {
    const alts = p.slice(1, -1).split("|");
    for (const alt of alts) if (alt === v) return true;
    return false;
  }
  return false;
}

export function examForm(examForms, formId) {
  return (Array.isArray(examForms) ? examForms : []).find((f) => f?.formId === formId) ?? null;
}

// The baked allowed-code pattern: the first question's regex validation
// (the "ادخل الرقم الكودي" question), exactly as the web app reads it.
export function bakedPatternFor(formId, examForms) {
  const form = examForm(examForms, formId);
  if (!form || !Array.isArray(form.questions)) return null;
  const codeQ = form.questions.find((q) => q?.validation?.kind === "regex") ?? null;
  const pattern = codeQ?.validation?.pattern;
  return typeof pattern === "string" && pattern ? pattern : null;
}

// The Forms link the student opens, exactly as Telegram sends it: one
// message "📝 الامتحان الإلكتروني: <url>". `url` is the student-facing
// viewform URL (the manifest holds the /edit link; the baked form's
// submitUrl becomes the viewform URL).
export function examUrlFor(formId, manifestUrl = null, examForms = []) {
  const form = examForm(examForms, formId);
  if (form?.submitUrl) return String(form.submitUrl).replace(/\/formResponse$/u, "/viewform");
  return manifestUrl;
}

export function examLinkText(url, name = null) {
  const greeting = name ? `أهلًا ${name} 👋\n` : "";
  return `${greeting}📝 الامتحان الإلكتروني: ${url ?? ""}`;
}

// R2 public URL for a lesson media file. Every key in the bucket is
// <driveId>.mp4 (video) or <driveId>.jpg (photo) — verified 50/50 — so
// the URL is built from the driveId + kind, with no map file to go stale.
export function r2UrlFor(driveId, kind, r2Base = R2_MEDIA_BASE_URL) {
  const id = String(driveId ?? "").trim();
  if (!id || !r2Base) return null;
  const ext = kind === "video" ? "mp4" : "jpg";
  return `${String(r2Base).replace(/\/+$/u, "")}/${id}.${ext}`;
}

// Default media URL: direct R2 URL — the FAST path (no Worker hop, no
// download, no re-upload). A wiring-provided mediaUrlFor may prefer the
// Worker /media/<id> proxy (Drive) instead, e.g. for items not yet
// uploaded to R2 — that is the SLOW path and should only be used as a
// fallback, never as the default for lesson sends.
export function defaultMediaUrlFor(driveId, kind, { r2Base = R2_MEDIA_BASE_URL } = {}) {
  return r2UrlFor(driveId, kind, r2Base);
}

// ---------------------------------------------------------------------------
// Learn data (same live source as Telegram: src/learn-manifest.js)
// ---------------------------------------------------------------------------

export function findLevel(levelId, levels = LEARN_LEVELS) {
  return (Array.isArray(levels) ? levels : []).find((l) => l.id === levelId) ?? null;
}

export function findLesson(lessonId, levels = LEARN_LEVELS) {
  for (const level of Array.isArray(levels) ? levels : []) {
    const lesson = (level.lessons ?? []).find((x) => x.id === lessonId);
    if (lesson) return { lesson, level };
  }
  return { lesson: null, level: null };
}

export function siblingLesson(lessonId, direction, levels = LEARN_LEVELS) {
  const { lesson, level } = findLesson(lessonId, levels);
  if (!lesson || !level) return null;
  const idx = level.lessons.findIndex((x) => x.id === lessonId);
  return level.lessons[idx + direction] ?? null;
}

export function lessonIndex(lessonId, levels = LEARN_LEVELS) {
  const { level } = findLesson(lessonId, levels);
  if (!level) return { index: -1, total: 0 };
  return { index: level.lessons.findIndex((x) => x.id === lessonId), total: level.lessons.length };
}

// Level menu items in Telegram's order (buildLearnMenus): get-code (L1
// only, at the very top), lessons in order, certificate ABOVE back/home,
// search, then back + home last.
export function levelMenuItems(levelId, levels = LEARN_LEVELS) {
  const level = findLevel(levelId, levels);
  if (!level) return null;
  const items = [];
  if (levelId === "m_learn_l1") items.push({ type: "getcode", label: "الحصول على الرقم الكودي", payload: "learn|getcode" });
  for (const lesson of level.lessons) {
    items.push({ type: "lesson", lessonId: lesson.id, label: lesson.title, payload: `learn|lesson:${lesson.id}` });
  }
  items.push({
    type: "cert",
    level: levelId === "m_learn_l2" ? "2" : "1",
    label: levelId === "m_learn_l2" ? "الحصول على شهادة المستوى الثاني" : "الحصول على شهادة المستوى الأول",
    payload: `learn|cert:${levelId === "m_learn_l2" ? "2" : "1"}`,
  });
  items.push({ type: "search", label: "🔍 بحث في القاموس", payload: "learn|search" });
  items.push({ type: "back", label: "🔙 رجوع", payload: `learn|back:${levelId}` });
  items.push({ type: "home", label: "🏠 الرئيسية", payload: "learn|home" });
  return items;
}

export function lessonNavHint(lessonId, levels = LEARN_LEVELS) {
  const { index, total } = lessonIndex(lessonId, levels);
  const bits = [];
  if (index > 0) bits.push("«السابق» للدرس السابق");
  if (index >= 0 && index < total - 1) bits.push("«التالي» للدرس التالي");
  bits.push("«رجوع» للرجوع للمستوى", "«القائمة» للقائمة الرئيسية");
  return bits.join(" • ");
}

// The send plan for one lesson, in manifest order: video, then photo
// (oral/summary), then exercise text, then the exam (gated — the exam
// step carries the form id; the handler turns it into a "send your code"
// prompt). Media steps carry the R2 (or wired) URL. Returns null when
// the lesson is unknown or a media item has no usable URL.
export function lessonPlan(lessonId, { levels = LEARN_LEVELS, mediaUrlFor = defaultMediaUrlFor } = {}) {
  const { lesson, level } = findLesson(lessonId, levels);
  if (!lesson || !level) return null;
  const steps = [];
  for (const item of lesson.items ?? []) {
    if (item.kind === "video" || item.kind === "photo") {
      const url = mediaUrlFor(item.driveId, item.kind);
      if (!url) return null;
      steps.push({ type: "media", kind: item.kind, driveId: item.driveId, url, caption: lesson.title });
    } else if (item.kind === "text") {
      const text = String(item.text ?? "").trim();
      if (text) steps.push({ type: "text", text });
    } else if (item.kind === "url") {
      const m = String(item.url ?? "").match(/\/forms\/d\/([a-zA-Z0-9-_]+)/);
      if (!m) return null;
      steps.push({ type: "exam", formId: m[1], examUrl: String(item.url) });
    } else {
      return null;
    }
  }
  return steps.length ? { lesson, level, steps } : null;
}

// ---------------------------------------------------------------------------
// Menu texts (numbered lists — the text list is always sent in full;
// quick replies are a tap supplement on the last message of the turn)
// ---------------------------------------------------------------------------

export function levelsText(levels = LEARN_LEVELS, appUrl = LEARN_APP_URL) {
  const lines = [
    "🎓 التعلم — اختر المستوى:",
    "أرسل رقمًا للاختيار، أو اضغط على المستوى.",
    "",
  ];
  (Array.isArray(levels) ? levels : []).forEach((level, i) => {
    lines.push(`${i + 1}. ${level.title} (${level.lessons.length} درسًا)`);
  });
  lines.push("", `🌐 أو افتح تطبيق التعلم من المتصفح: ${appUrl}`);
  return directLines(lines.join("\n"));
}

export function levelMenuText(levelId, levels = LEARN_LEVELS) {
  const level = findLevel(levelId, levels);
  if (!level) return null;
  const items = levelMenuItems(levelId, levels);
  const lines = [`🎓 ${level.title} — اختر:`, "أرسل رقمًا للاختيار، أو اضغط على الدرس.", ""];
  items.forEach((item, i) => lines.push(`${i + 1}. ${item.label}`));
  return directLines(lines.join("\n"));
}

export function mainMenuText() {
  return directLines([
    "📖 القاموس القبطي — القائمة",
    "أرسل رقمًا للاختيار، أو اضغط على زر.",
    "",
    "1. 🔍 بحث — أرسل أي كلمة مباشرة",
    "2. 🎓 التعلم — الدروس والامتحانات والشهادات",
    "3. 🎓 الشهادة — الحصول على شهادة مستوى",
    "4. 🔑 الرقم الكودي — الحصول على الرقم الكودي",
    "5. ❓ مساعدة — عرض الأوامر",
    "6. 🔗 روابط المنصات — روابط التطبيق والموقع والبوتات",
    "7. 📣 مشاركة الإعلان — إعلان إطلاق النسخة الثانية",
    "8. ✍️ اكتب اسمك بالقبطية",
  ].join("\n"));
}

export const MAIN_MENU_ITEMS = [
  { type: "search", label: "🔍 بحث", payload: "learn|search" },
  { type: "learn", label: "🎓 التعلم", payload: "learn|levels" },
  { type: "certmenu", label: "🎓 الشهادة", payload: "learn|certmenu" },
  { type: "getcode", label: "🔑 الرقم الكودي", payload: "learn|getcode" },
  { type: "help", label: "❓ مساعدة", payload: "learn|help" },
  { type: "links", label: "🔗 روابط المنصات", payload: "learn|links" },
  { type: "share", label: "📣 مشاركة الإعلان", payload: "learn|share" },
  { type: "copticname", label: "✍️ اكتب اسمك بالقبطية", payload: "learn|copticname" },
];

export function parityWelcomeText() {
  return directLines([
    "📖 القاموس القبطي — ابعت أي كلمة بالقبطي أو العربي أو الإنجليزي أو الفرنسي أو الألماني، وأنا أجيب معناها ونطقها.",
    "",
    "الأوامر:",
    "/learn — تعلم اللغة القبطية من بوت منفصل",
    "/learnhere — تعلم اللغة القبطية هنا",
    "/links — روابط المنصات (التطبيق والموقع والبوتات)",
    "/share — مشاركة إعلان النسخة الثانية",
    "/copticname — اكتب اسمك بالحروف القبطية",
    "/cert — الحصول على الشهادة",
    "/getcode — الحصول على الرقم الكودي",
    "/help — المساعدة",
  ].join("\n"));
}

export function parityHelpText() {
  return directLines([
    "📖 القاموس القبطي — المساعدة",
    "",
    "البحث: اكتب أي كلمة مباشرة: قبطي / عربي / إنجليزي / فرنسي / ألماني.",
    "التعلم:",
    "/learn — تعلم اللغة القبطية من بوت منفصل",
    "/getcode — الحصول على الرقم الكودي",
    "/cert — الشهادة",
    "القائمة:",
    "/learnhere — تعلم اللغة القبطية هنا",
    "/links — روابط المنصات (التطبيق والموقع والبوتات)",
    "/share — مشاركة إعلان النسخة الثانية",
    "/copticname — اكتب اسمك بالحروف القبطية",
    "/start — بدء الاستخدام",
    "",
    "الدروس فيديو وصور من تطبيق التعلم، والامتحانات برابط تفتحه من المتصفح بعد إدخال رقمك الكودي.",
  ].join("\n"));
}

// Cross-platform links (same text in all three bots): the app, the
// website, and the Telegram / Messenger / WhatsApp doors. Plain text,
// verbatim — no bold markers, no HTML, no direction marks — so the
// reply is byte-identical in every bot. Deliberately NOT passed
// through directLines: the lines' first strong character is Arabic,
// so they render on the correct side as-is.
export const LINKS_TEXT = [
  "🔗 روابط القاموس القبطي Ⲭⲏⲙⲓ",
  "📲 التطبيق (أندرويد): https://is.gd/copticdictionary",
  "🌐 الموقع الإلكتروني: https://copticdictionry.neocities.org/",
  "📱 تيليجرام: https://t.me/Coptic_Dictionary_bot",
  "💬 ماسنجر: https://m.me/Copticdictionary",
  "🟢 واتساب: https://wa.me/message/WSYPILDL7WV7C1",
].join("\n");

// /share — إعلان إطلاق النسخة الثانية (نص طويل + صورة البوستر).
// النص حرفيًا كما كتبه المستخدم؛ الصورة مرفوعة على R2. مثل LINKS_TEXT،
// لا يمر عبر directLines: أول حرف قوي في السطور عربي، فتظهر كما هي.
export const SHARE_POSTER_URL = "https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev/poster-v9.jpg";
export const SHARE_TEXT = `إطلاق النسخة الثانية من تطبيق القاموس القبطي الناطق Ⲭⲏⲙⲓ | Coptic Dictionary 😍🎉

بعد إطلاق النسخة الأولى التجريبية، يُسعدنا أن نقدم لكم النسخة الثانية من القاموس القبطي الناطق Ⲭⲏⲙⲓ، بإصدار أكثر تطوراً وشمولاً، يضم حوالي 17,000 كلمة متنوعة، إلى جانب مجموعة من المميزات والإضافات الجديدة التي تهدف إلى تسهيل تعلم اللغة القبطية والبحث في مفرداتها.

📚 أبرز إمكانيات ومميزات القاموس:

🔹 قاعدة بيانات لغوية موسّعة: تضم حوالي 17,000 كلمة قبطية متنوعة، لتوفير مرجع لغوي واسع للبحث والتعلم.

🔹 النطق الصوتي للكلمات: إمكانية الاستماع إلى النطق الصوتي للمفردات القبطية، مما يساعد على التعرف على نطق الكلمات وتعلمها بصورة عملية.

🔹 واجهة بحث سهلة وسريعة: إمكانية البحث عن الكلمات والوصول إلى معانيها من خلال واجهة استخدام بسيطة وميسرة.

🔹 دعم منصات متعددة: إمكانية استخدام القاموس من خلال تطبيق الأندرويد أو الموقع الإلكتروني أو بوتات تيليجرام وماسنجر.

📱 ميزة خاصة بتطبيق الأندرويد: من أبرز المميزات التي ينفرد بها تطبيق الأندرويد إمكانية تحميل الملفات الصوتية والاحتفاظ بها على جهازك، لتتمكن من الاستماع إلى نطق الكلمات القبطية في أي وقت، حتى دون الحاجة إلى الاتصال بالإنترنت، وذلك بعد تحميلها لأول مرة، وهذه الميزة متاحة داخل تطبيق الأندرويد، لتمنح مستخدميه تجربة مختلفة عن استخدام القاموس من خلال البوتات.

🎧 والأفضل من ذلك أن الحجم الإجمالي للملفات الصوتية لا يتجاوز 40 ميجابايت فقط!

⚠️ تنويه مهم: القاموس مرجع لغوي متخصص في عرض معاني الكلمات المفردة، وليس أداة لترجمة الجمل والنصوص الكاملة.

📖 إضافة قسم جديد: الكتاب المقدس 😍
إضافة قسم مميز للكتاب المقدس، يتيح الاطلاع على نصوصه وترجماته باللغات المختلفة، وفي مقدمتها اللغة القبطية، إلى جانب لغات أخرى مثل السريانية واليونانية والعبرية والإنجليزية. 😍

🔔 نظام الإشعارات اليومية😍
إضافة مجموعة متنوعة من الإشعارات اليومية وإشعارات المناسبات، ومن أبرزها إشعار الكلمة القبطية اليومية، بهدف تعزيز التعلم المستمر والتفاعل مع اللغة والتراث القبطي، ولتعمل هذه الميزة لديك، قُم بتفعيل الاشعارات للتطبيق.

✨ تحسينات وإضافات جديدة
العديد من التحسينات والتطويرات والمميزات الإضافية التي ندعوكم لاكتشافها بأنفسكم!

📱 طرق استخدام القاموس القبطي Ⲭⲏⲙⲓ:

1️⃣ تطبيق الأندرويد:
https://is.gd/copticdictionary

2️⃣ الموقع الإلكتروني:
https://copticdictionry.neocities.org/

3️⃣ بوت تيليجرام للقاموس:
https://t.me/Coptic_Dictionary_bot

4️⃣ بوت ماسنجر للقاموس:
https://m.me/Copticdictionary

📚 وأيضاً بوت تعلم اللغات القديمة: يمكنكم أيضاً الاستفادة من بوت مخصص لتعلم اللغة القبطية والهيروغليفية واليونانية:
https://t.me/Coptic2_bot

وندعوكم لمشاركة هذا العمل مع جميع أحبائكم وأصدقائكم والمهتمين باللغة القبطية والتراث المصري القديم، للمساهمة في نشر المعرفة وإيصال هذا المشروع إلى أكبر عدد ممكن من المهتمين، حتى تعم الفائدة😍❤️

━━━━━━━━━━━━━━━━━━
وإذا تعذر عليك تحميل نسخة القاموس للاندرويد أو لديك أي استفسار، يمكنك التواصل مع مبرمج القاموس من خلال الواتساب: https://wa.me/@Ebram_El_masry أو من خلال التيليجرام: https://telegram.me/Abraam55 وسيتم ارسال لك نسخة ملف الـ APK جاهزة للتثبيت المباشر😍

Ebram Merzik
ⲬⲎⲘⲒ | COPTIC DICTIONARY`;

// /share — النسخة المختصرة (1,705 حرف) لماسنجر فقط: الإعلان الكامل
// ~2,900 حرف ولا يدخل في رسالة ماسنجر واحدة (الحد 2000 حرف — جرّبناه
// حي 25 نوفمبر 2026 ورفضته ميتا بالخطأ 100). تيليجرام وواتساب
// يبقيان على النص الكامل SHARE_TEXT. وافق عليها المستخدم 25 نوفمبر 2026.
export const SHARE_TEXT_SHORT = `إطلاق النسخة الثانية من تطبيق القاموس القبطي الناطق Ⲭⲏⲙⲓ | Coptic Dictionary 😍🎉

يُسعدنا أن نقدم لكم النسخة الثانية من القاموس القبطي الناطق Ⲭⲏⲙⲓ، بإصدار أكثر تطوراً وشمولاً، يضم حوالي 17,000 كلمة متنوعة.

📚 أبرز إمكانيات ومميزات القاموس:

🔹 قاعدة بيانات موسّعة: حوالي 17,000 كلمة قبطية متنوعة.
🔹 النطق الصوتي للكلمات: استمع إلى نطق المفردات القبطية وتعلمها بصورة عملية.
🔹 واجهة بحث سهلة وسريعة للوصول إلى معاني الكلمات.
🔹 يعمل على الأندرويد والموقع الإلكتروني وبوتات تيليجرام وماسنجر.

📱 ميزة خاصة بتطبيق الأندرويد: حمّل الملفات الصوتية واحتفظ بها على جهازك، واستمع إلى نطق الكلمات في أي وقت حتى دون إنترنت، بعد تحميلها لأول مرة.

🎧 الحجم الإجمالي للملفات الصوتية لا يتجاوز 40 ميجابايت فقط!

⚠️ تنويه مهم: القاموس مرجع لغوي لمعاني الكلمات المفردة، وليس أداة لترجمة الجمل والنصوص الكاملة.

📖 قسم جديد: الكتاب المقدس 😍 — نصوصه وترجماته بالقبطية والسريانية واليونانية والعبرية والإنجليزية.

🔔 إشعارات يومية😍 — ومن أبرزها إشعار الكلمة القبطية اليومية، فعّل إشعارات التطبيق لتصلك كل يوم.

📱 طرق استخدام القاموس القبطي Ⲭⲏⲙⲓ:

1️⃣ تطبيق الأندرويد: https://is.gd/copticdictionary
2️⃣ الموقع الإلكتروني: https://copticdictionry.neocities.org/
3️⃣ بوت تيليجرام: https://t.me/Coptic_Dictionary_bot
4️⃣ بوت ماسنجر: https://m.me/Copticdictionary

📚 بوت تعلم اللغات القديمة (القبطية والهيروغليفية واليونانية):
https://t.me/Coptic2_bot

شاركوا هذا العمل مع أحبائكم وأصدقائكم والمهتمين باللغة القبطية والتراث المصري القديم، حتى تعم الفائدة😍❤️

━━━━━━━━━━━━━━━━━━
إذا تعذر عليك تحميل نسخة القاموس للأندرويد أو لديك أي استفسار، تواصل مع مبرمج القاموس واتساب: https://wa.me/@Ebram_El_masry أو تيليجرام: https://telegram.me/Abraam55، وسيتم إرسال نسخة ملف الـ APK جاهزة للتثبيت المباشر😍

Ebram Merzik
ⲬⲎⲘⲒ | COPTIC DICTIONARY`;

// Messenger caps a text message at 2000 chars; split the announcement
// at line boundaries into <=1900-char pieces.
function splitShareText(text, max = 1900) {
  const lines = String(text ?? "").split("\n");
  const chunks = [];
  let cur = "";
  for (const line of lines) {
    const add = cur ? "\n" + line : line;
    if (cur && cur.length + add.length > max) {
      chunks.push(cur);
      cur = line;
    } else {
      cur += add;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// /share — السطر الختامي بعد الصورة: دعوة النشر والمشاركة.
export const SHARE_CLOSING_TEXT = "نرجو منك نشر ومشاركة البوست السابق في صفحتك وجروباتك ولكل احبائك ليستفيد الجميع من هذا العمل الضخم ❤️❤️😍";

// The /botcake handler sends this plan directly (announcement, then
// the image, then the closing line) — the envelope only carries three
// capped chunks, so the flow would truncate the announcement. The LAST
// text is the closing line, sent after the image. The announcement here
// is the SHORT version (fits one Messenger bubble, < 2000 chars).
export function sharePlan() {
  return {
    shareReply: true,
    texts: [SHARE_TEXT_SHORT, SHARE_CLOSING_TEXT].map((text) => ({ text })),
    voiceUrl: null,
    attachments: [{ type: "image", url: SHARE_POSTER_URL }],
  };
}

// ---------------------------------------------------------------------------
// Certificate result -> plan (mirrors Telegram's handleCertCode, with the
// same outcomes: ready photo, icon + "must do the final exam" /
// "certificate being prepared" / "must start the exams" captions, text,
// not-found, error). A ready certificate arrives as bytes, so the plan
// carries photoBytes for the coordinator's multipart Send API upload;
// the caption goes out as its own text message first.
// ---------------------------------------------------------------------------

// Messenger renders no markup in plain text: Telegram's <b>name</b> arrives
// as *name* through plainTextCard, and the student must not see the name
// between asterisks (on Telegram/WhatsApp it renders bold). Cert captions
// carry no other emphasis, so the asterisks come off here — word cards
// keep their *labels*.
const stripCertEmphasis = (text) => String(text ?? "").replace(/\*([^*]+)\*/gu, "$1");

export function certResultToPlan(result) {
  if (!result) return { texts: [{ text: CERT_NOT_FOUND_TEXT }], voiceUrl: null };
  if (result.kind === "photo" && result.bytes) {
    const caption = stripCertEmphasis(plainTextCard(result.caption ?? "🎓 شهادتك 🎓"));
    return {
      texts: [{ text: caption }],
      voiceUrl: null,
      photoBytes: {
        bytes: result.bytes,
        contentType: result.contentType || "image/png",
        fileName: result.fileName || "certificate.png",
      },
    };
  }
  if (result.kind === "photo" && result.url) {
    return {
      texts: [{ text: stripCertEmphasis(plainTextCard(result.caption ?? "")) }],
      voiceUrl: null,
      attachments: [{ type: "image", url: result.url }],
    };
  }
  if (result.kind === "text" || result.kind === "error") {
    return { texts: [{ text: stripCertEmphasis(plainTextCard(result.text ?? "")) }], voiceUrl: null };
  }
  return { texts: [{ text: CERT_NOT_FOUND_TEXT }], voiceUrl: null };
}

// ---------------------------------------------------------------------------
// Live monitoring (/livemon, /conversations, /userchat) — pure helpers
// and DO key names. Telegram parity (final-code-fix src/index.js:
// liveMonitorOn/setLiveMonitor, forwardLiveMessage, trackConvMessage /
// getUserConv / getActiveConvUsers): every incoming private message
// from a non-admin is logged, and while the monitor is ON it is also
// forwarded live to the first admin PSID. The log lives entirely in
// the Durable Object via the injected adminStore — the DO exposes no
// list op, so /conversations reads the explicit recency index
// (CONV_ACTIVE_KEY); the per-user log is one key per PSID.
// ---------------------------------------------------------------------------

// DO keys (Telegram parity: `livemon:enabled` is the same key name;
// the conv keys are Messenger-namespaced so they can never collide
// with a Telegram `conv:<id>` row in a shared store).
export const LIVEMON_KEY = "livemon:enabled";
export const CONV_KEY_PREFIX = "msgr:conv:";
export const CONV_ACTIVE_KEY = "msgr:conv:active";
export const CONV_MAX_PER_USER = 100;
export const CONV_REPORT_MAX = 20;
export const CONV_USERCHAT_MAX = 30;

// Exact toggle replies (Telegram's wording, adapted: Telegram's ON text
// promises a ↩️ quick-reply button, which does not exist on Messenger —
// the admin replies with /msg instead).
export const LIVEMON_ON_TEXT = "🔴 تم تشغيل المراقبة المباشرة — ستصلك رسائل المستخدمين فور وصولها. رد عليهم بـ /msg <PSID> <نص>. أوقفها بـ /livemon.";
export const LIVEMON_OFF_TEXT = "⚪ تم إيقاف المراقبة المباشرة — لن تصلك رسائل المستخدمين لحظيًا. المحادثات تظل محفوظة وتُراجَع بـ /conversations و /userchat.";

// Label for a non-text log entry, in the forward and in /userchat.
// A voice entry stores text "" — the label comes from the kind.
export function convKindLabel(kind) {
  return { text: "", voice: "🎤 رسالة صوتية", media: "📎 وسائط" }[kind] ?? "📎 وسائط";
}

// One live forward to the admin: sender name + PSID + time + message
// (sliced to 1000 chars, Telegram's forward cap), then the /msg hint
// on its own line. No asterisks around names (display rule), one
// command per line. `at` is an ISO string; `text` is the caption for
// media, "" for voice.
export function formatLiveForward({ name, psid, at, kind, text }) {
  const when = at ? new Date(at).toLocaleTimeString("en-GB") : new Date().toLocaleTimeString("en-GB");
  const who = `🔴 ${String(name ?? "").trim() || "بدون اسم"} (${String(psid)}) • ${when}`;
  const body = kind === "text"
    ? String(text ?? "").slice(0, 1000)
    : `${convKindLabel(kind)}${text ? ` ${String(text).slice(0, 1000)}` : ""}`;
  return `${who}\n${body}\nرد بـ /msg ${String(psid)} <نص>`;
}

// ---------------------------------------------------------------------------
// Admin subset (mirrors the WhatsApp port's admin.js)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FULL ADMIN AUDIT — every Telegram admin command (332 entries across the
// 13 Arabic categories of ALL_COMMANDS_CATEGORIES in src/index.js, counted
// from the current tree: 16+34+20+15+24+30+29+43+31+25+25+17+23 = 332),
// each classified:
//
//   impl     — implemented here for Messenger (plain text + quick replies,
//              admin-gated by env PSID, DO/data-backed via injected deps).
//   dispatch — a USER command that happens to sit in an admin category
//              (quiz, dictionary features, ...): it runs through the
//              owning agent's handler via the runUserCommand dep, for
//              everyone, exactly as in Telegram. NOT admin-gated. When the
//              dep is absent the module returns null so the owning agent's
//              own planFor handles it. After the dispatch wiring
//              (src/dispatch-commands.js, 2026-11-16) only the 12 parked
//              quiz/game commands remain "dispatch": they are NOT built
//              (user's decision 2026-11-13) and answer with an honest
//              "not built" message from PARKED_DISPATCH_MESSAGES instead of
//              the old "لم يتم توصيله بعد" placeholder. The other 44
//              dispatch commands are now "impl".
//   na       — inherently Telegram-only: listed explicitly with a reason,
//              never silently dropped.
//
// Counts (see ADMIN_AUDIT / adminAuditCounts()): impl 249, dispatch 12,
// na 74 = 335 (332 Telegram commands + 3 Messenger extras).
// ---------------------------------------------------------------------------

export const ADMIN_CATEGORIES = [
  { id: "main", title: "⭐ الأوامر الأساسية", commands: ["start", "keyboard", "learn", "menu", "search", "app", "contact", "random", "help", "admin", "dashboard", "about", "cancel", "k", "kbd", "lang"] },
  { id: "stats", title: "📊 الإحصاءات والتقارير", commands: ["usage", "analytics", "topusers", "growth", "usercount", "searchstats", "topwords", "misses", "livewords", "hourly", "dictstats", "wordcount", "fieldreport", "statuspage", "digest", "weekly", "reports", "reportclose", "adminscore", "usertimeline", "trace", "searchcount", "liveusers", "conversations", "userchat", "livemon", "livesearch", "retention", "ops", "funnel", "cohorts", "reflinks", "searchhistory", "report"] },
  { id: "voices", title: "🎙 الأصوات", commands: ["record", "record_choose", "record_select", "record_stop", "record_voice", "voice_delete", "voice_delete_all", "voice_delete_many", "voicecoverage", "voiceoff", "voiceon", "voiceonce", "voicesettings", "voicethree", "noaudio", "nopronounce", "uploadaudio", "rebuildvoice", "voicegaps", "pronounce"] },
  { id: "drive", title: "☁️ Drive والمزامنة", commands: ["drive", "syncdrive", "syncusers", "syncall", "synccancel", "syncreset", "syncstatus", "synctest", "syncwatch", "importusers", "importsheet", "importlearn", "setdrive", "setarchive", "resync"] },
  { id: "users", title: "👥 المستخدمون", commands: ["users", "userlookup", "userinfo", "userfind", "userhistory", "userdelete", "usernote", "usernotes", "ban", "unban", "banlist", "tempban", "warn", "warns", "resetwarns", "inactive", "purge", "resetuser", "setpoints", "addpoints", "leaderboard", "points", "purgeinactive", "blockedusers"] },
  { id: "dict", title: "📖 القاموس", commands: ["dicthealth", "wordsearch", "wordinfo", "translate", "similar", "startswith", "longest", "letterstats", "alphabet", "copticdate", "origins", "vocab", "duplicates", "findempty", "gapfill", "wordaudit", "exportcsv", "exportfull", "export", "backup", "backupauto", "dictversion", "sheetdiff", "deleteword", "bulkadd", "bulkedit", "randomword", "integrity", "dups", "emptymeaning"] },
  { id: "broadcast", title: "📢 البث والإرسال", commands: ["broadcast", "startbroadcast", "stopbroadcast", "bcpause", "bcresume", "bccancel", "bcspeed", "testbroadcast", "broadcaststats", "targeted", "segment", "templateslib", "tplsave", "tplsend", "announce", "maintadv", "maintadvstatus", "maintadvcancel", "massdm", "msg", "schedule", "schedules", "unschedule", "autoreply", "optout", "optoutstats", "addevent", "events", "delevent"] },
  { id: "system", title: "⚙️ أدوات النظام", commands: ["health", "healthcheck", "uptime", "botinfo", "sessionlist", "kill", "resetsessions", "clearcache", "cacheinfo", "limits", "slowmode", "maintenance", "setmaintmsg", "setbanmsg", "feature", "errors", "auditlog", "adminaudit", "securitylog", "setcommands", "setbotname", "setbotabout", "setbotdescription", "setshortdesc", "setlang", "setmenubutton", "setwod", "setwodtest", "note", "alias", "motd", "rules", "searchlimit", "usagealert", "recover", "recoverusers", "apikey", "whereami", "snapshot", "preview", "logchannel", "ping", "debug"] },
  { id: "advanced", title: "🔧 أدوات متقدمة", commands: ["exportaudit", "exporterrors", "exportmisses", "exportbans", "exportsecurity", "exportsearch", "resetstats", "newhelp", "a2help", "proadmin", "prohelp", "apanel", "strings", "setstring", "resetstring", "cleanup", "maintplan", "teamnote", "teamnotes", "teamassign", "teamdone", "rollout", "rolloutallow", "rolloutdeny", "rollouts", "selfcheck", "configexport", "webhook", "envcheck", "dostat", "bottest"] },
  { id: "learn", title: "🎓 التعلم والاختبارات", commands: ["quiz", "quiz2", "quizstats", "dailyquiz", "streak", "hangman", "guess", "daily", "wod", "wordoftheday", "fav", "favorites", "myfav", "mywords", "removefav", "mystats", "recent", "gamify", "badges", "exportanki", "examples", "compare", "cert1", "cert2", "getcode"] },
  { id: "support", title: "💬 الدعم والتواصل", commands: ["support", "tickets", "ticket", "ticketclose", "mytickets", "reply", "feedback", "bug", "suggest", "suggestword", "suggestions", "contribute", "invite", "myref", "toptop", "refinfo", "donate", "donation", "subscribe", "unsubscribe", "notify", "exportmydata", "clearhistory", "alerts", "exitsupport"] },
  { id: "security", title: "🔐 الأمان والصلاحيات", commands: ["2fa", "password", "unlock", "lockdown", "verifygate", "captcha", "ratewarn", "ratelimit", "blacklist", "whitelist", "antispam", "spamlist", "spamclear", "setrole", "roles", "myrole", "admins"] },
  { id: "menus", title: "🎛 القوائم والبوت", commands: ["menuadmin", "menueditor", "addmenu", "addbutton", "delmenu", "delbutton", "movebtn", "addvideo", "videolist", "delvideo", "toptags", "welcomemedia", "welcomesticker", "leavemsg", "setjoinmsg", "editwelcome", "resetwelcome", "pin", "pinhere", "unpin", "hidebutton", "hiddenbuttons", "showbutton"] },
];

// Telegram-only commands, each with its one-line reason. Everything not
// listed here and not in ADMIN_DISPATCH_COMMANDS is implemented.
export const ADMIN_NOT_APPLICABLE = {
  // Stats: Telegram live search / timeline reads Telegram updates.
  livesearch: "بحث حي في رسائل تيليجرام — لا يوجد مقابل في ماسنجر",
  usertimeline: "الخط الزمني لتحديثات مستخدم تيليجرام — لا يوجد مقابل في ماسنجر",
  trace: "تتبع تحديث تيليجرام (update trace) — خاص بتيليجرام",
  reportclose: "إغلاق بلاغ — سير عمل البلاغات يعمل بأزرار إنلاين في تيليجرام",
  // Voices: the recording flow now runs on Messenger too (/record —
  // src/record-voice.js). The Telegram-pipeline markers stay na.
  noaudio: "علامة «بلا صوت» في خط أنابيب أصوات تيليجرام — لا يوجد مقابل في ماسنجر",
  nopronounce: "علامة «بلا نطق» في خط أنابيب أصوات تيليجرام — لا يوجد مقابل في ماسنجر",
  uploadaudio: "رفع ملف صوتي عبر تيليجرام — لا يوجد مقابل في ماسنجر",
  // Drive: live watch is a Telegram-side watch.
  syncwatch: "مراقبة مزامنة حية برسائل تيليجرام — لا يوجد مقابل في ماسنجر",
  // Dictionary: file downloads.
  exportcsv: "تنزيل ملف CSV — ماسنجر لا يستقبل ملفات مولّدة من البوت",
  exportfull: "تنزيل ملف كامل — ماسنجر لا يستقبل ملفات مولّدة من البوت",
  export: "تنزيل ملف — ماسنجر لا يستقبل ملفات مولّدة من البوت",
  backup: "تنزيل نسخة احتياطية كملف — ماسنجر لا يستقبل ملفات مولّدة من البوت",
  backupauto: "نسخة احتياطية تلقائية كملف إلى تيليجرام — لا يوجد مقابل في ماسنجر",
  // Broadcast: scheduling lives in the scheduled-broadcast flow below
  // (broadcastCommand cases + the scheduleFlow state in handleText).
  segment: "الشرائح تُعرَّف في سير عمل أدمن تيليجرام — لا يوجد مقابل في ماسنجر",
  autoreply: "محرك الرد التلقائي في تيليجرام — لا يوجد مقابل موصول في ماسنجر",
  // System: Telegram sessions and Bot API settings.
  sessionlist: "جلسات تيليجرام (polling/webhook) — لا يوجد مقابل في ماسنجر",
  kill: "قتل جلسة تيليجرام — لا يوجد مقابل في ماسنجر",
  resetsessions: "إعادة تعيين جلسات تيليجرام — لا يوجد مقابل في ماسنجر",
  setcommands: "تعيين قائمة أوامر تيليجرام (setMyCommands) — خاص بتيليجرام",
  setbotname: "تعيين اسم البوت عبر Bot API — خاص بتيليجرام",
  setbotabout: "تعيين نبذة البوت عبر Bot API — خاص بتيليجرام",
  setbotdescription: "تعيين وصف البوت عبر Bot API — خاص بتيليجرام",
  setshortdesc: "تعيين الوصف المختصر عبر Bot API — خاص بتيليجرام",
  setmenubutton: "زر قائمة تيليجرام الجانبية — خاص بتيليجرام",
  logchannel: "قناة سجلات تيليجرام — لا يوجد مقابل في ماسنجر",
  // Advanced: file downloads, pro suite (Telegram inline UI), webhook.
  exportaudit: "تنزيل ملف — ماسنجر لا يستقبل ملفات مولّدة من البوت",
  exporterrors: "تنزيل ملف — ماسنجر لا يستقبل ملفات مولّدة من البوت",
  exportmisses: "تنزيل ملف — ماسنجر لا يستقبل ملفات مولّدة من البوت",
  exportbans: "تنزيل ملف — ماسنجر لا يستقبل ملفات مولّدة من البوت",
  exportsecurity: "تنزيل ملف — ماسنجر لا يستقبل ملفات مولّدة من البوت",
  exportsearch: "تنزيل ملف — ماسنجر لا يستقبل ملفات مولّدة من البوت",
  newhelp: "واجهة مساعدة احترافية بأزرار إنلاين في تيليجرام — لا يوجد مقابل في ماسنجر",
  a2help: "واجهة مساعدة احترافية بأزرار إنلاين في تيليجرام — لا يوجد مقابل في ماسنجر",
  proadmin: "لوحة الإدارة الاحترافية بأزرار إنلاين في تيليجرام — لا يوجد مقابل في ماسنجر",
  prohelp: "واجهة مساعدة احترافية بأزرار إنلاين في تيليجرام — لا يوجد مقابل في ماسنجر",
  apanel: "لوحة الإدارة الاحترافية بأزرار إنلاين في تيليجرام — لا يوجد مقابل في ماسنجر",
  configexport: "تنزيل ملف إعدادات — ماسنجر لا يستقبل ملفات مولّدة من البوت",
  webhook: "معلومات ويبهوك تيليجرام — خاص بتيليجرام",
  // Support: payments and file export.
  donate: "التبرعات غير مبنية أصلًا في البوت — لا يوجد مقابل في ماسنجر",
  donation: "التبرعات غير مبنية أصلًا في البوت — لا يوجد مقابل في ماسنجر",
  exportmydata: "تنزيل ملف بيانات المستخدم — ماسنجر لا يستقبل ملفات مولّدة من البوت",
  // Security: Telegram account security.
  "2fa": "التحقق بخطوتين لحساب تيليجرام — خاص بتيليجرام",
  password: "كلمة مرور حساب تيليجرام — خاص بتيليجرام",
  unlock: "فتح قفل حساب تيليجرام — خاص بتيليجرام",
  lockdown: "إغلاق حساب تيليجرام — خاص بتيليجرام",
  verifygate: "بوابة تحقق تيليجرام — خاص بتيليجرام",
  captcha: "تحقق كابتشا في تيليجرام — لا يوجد مقابل في ماسنجر",
  // Menus: the whole menu-studio is a Telegram reply-keyboard UI.
  menuadmin: "استوديو القوائم بلوحة أزرار تيليجرام — لا يوجد مقابل في ماسنجر",
  menueditor: "محرر القوائم بلوحة أزرار تيليجرام — لا يوجد مقابل في ماسنجر",
  addmenu: "إنشاء قائمة من استوديو تيليجرام — لا يوجد مقابل في ماسنجر",
  addbutton: "إضافة زر من استوديو تيليجرام — لا يوجد مقابل في ماسنجر",
  delmenu: "حذف قائمة من استوديو تيليجرام — لا يوجد مقابل في ماسنجر",
  delbutton: "حذف زر من استوديو تيليجرام — لا يوجد مقابل في ماسنجر",
  movebtn: "نقل زر من استوديو تيليجرام — لا يوجد مقابل في ماسنجر",
  addvideo: "إضافة فيديو لقائمة تيليجرام — لا يوجد مقابل في ماسنجر",
  videolist: "قائمة فيديوهات تيليجرام — لا يوجد مقابل في ماسنجر",
  delvideo: "حذف فيديو من قائمة تيليجرام — لا يوجد مقابل في ماسنجر",
  toptags: "وسوم قوائم تيليجرام — لا يوجد مقابل في ماسنجر",
  welcomemedia: "وسائط رسالة الترحيب في تيليجرام — خاص بتيليجرام",
  welcomesticker: "ملصق رسالة الترحيب في تيليجرام — خاص بتيليجرام",
  leavemsg: "رسالة مغادرة المجموعة في تيليجرام — خاص بتيليجرام",
  setjoinmsg: "رسالة انضمام المجموعة في تيليجرام — خاص بتيليجرام",
  editwelcome: "تحرير رسالة الترحيب في تيليجرام — خاص بتيليجرام",
  resetwelcome: "إعادة تعيين رسالة الترحيب في تيليجرام — خاص بتيليجرام",
  pin: "تثبيت رسالة في تيليجرام — خاص بتيليجرام",
  pinhere: "تثبيت رسالة في تيليجرام — خاص بتيليجرام",
  unpin: "إلغاء تثبيت رسالة في تيليجرام — خاص بتيليجرام",
  hidebutton: "إخفاء زر من قائمة أوامر تيليجرام الجانبية — خاص بتيليجرام",
  hiddenbuttons: "قائمة الأزرار المخفية في تيليجرام — خاص بتيليجرام",
  showbutton: "إظهار زر في قائمة أوامر تيليجرام الجانبية — خاص بتيليجرام",
  // Main: the Coptic keyboard composer is a Telegram reply keyboard.
  keyboard: "لوحة المفاتيح القبطية بلوحة أزرار تيليجرام — لا يوجد مقابل في ماسنجر",
  k: "اختصار لوحة المفاتيح القبطية في تيليجرام — لا يوجد مقابل في ماسنجر",
  kbd: "اختصار لوحة المفاتيح القبطية في تيليجرام — لا يوجد مقابل في ماسنجر",
  // Main: language switching has no Messenger meaning — the interface is
  // Arabic-only (Telegram /lang sets user.lang; nothing on Messenger
  // reads a lang pref).
  lang: "واجهة البوت عربي فقط على ماسنجر — لا يوجد تبديل لغة",
};

// User commands that sit in admin categories: they run through the
// owning agent's handler (runUserCommand dep), for everyone.
export const ADMIN_DISPATCH_COMMANDS = new Set([
  // Dictionary features (owned by the dictionary agent).
  "wordsearch", "wordinfo", "translate", "similar", "startswith", "longest",
  "letterstats", "alphabet", "copticdate", "origins", "vocab", "randomword",
  "pronounce",
  // Voice preferences (owned by the dictionary agent).
  "voiceoff", "voiceon", "voiceonce", "voicesettings", "voicethree",
  // Learn / games / personal stats (owned by the learn agent).
  "quiz", "quiz2", "quizstats", "dailyquiz", "streak", "hangman", "guess",
  "daily", "wod", "wordoftheday", "fav", "favorites", "myfav", "mywords",
  "removefav", "mystats", "recent", "gamify", "badges", "exportanki",
  "examples", "compare",
  // Support user side.
  "mytickets", "suggestword", "suggestions", "contribute", "invite", "myref",
  "toptop", "refinfo", "subscribe", "unsubscribe", "notify", "clearhistory",
  "alerts", "exitsupport",
  // Main user commands that live in the admin dashboard's first category.
  // /lang is NOT here: language switching has no Messenger meaning, so it
  // lives in ADMIN_NOT_APPLICABLE instead.
  "search", "random",
]);

// The 3 Messenger extras beyond the 332 Telegram commands.
export const ADMIN_MESSENGER_EXTRAS = [
  { command: "reload", category: "messenger", status: "impl", reason: "تقرير تحديث البيانات (إضافة من منفذ واتساب)" },
  { command: "bans", category: "messenger", status: "impl", reason: "اسم مختصر لـ /banlist" },
  // /resetcode (28 Nov 2026): hidden admin-only — clears the caller's
  // own stored get-code record so the full flow can be re-tested. It
  // is NOT in any category list or menu; it lives here only so it is
  // admin-gated (ADMIN_COMMANDS) and silent for non-admins.
  { command: "resetcode", category: "messenger", status: "impl", reason: "مسح الرقم الكودي المسجّل لإعادة اختبار تدفق الرقم الكودي (أدمن فقط، مخفي)" },
];

// The full audit: one row per command. Status: impl | dispatch | na.
// "dispatch" now means ONLY the 12 parked quiz/game commands: they
// route through runUserCommand but answer with a parked message, so
// they are not implemented. The other 44 commands that route through
// runUserCommand are implemented (src/dispatch-commands.js) and count
// as "impl"; /lang moved to "na".
export const ADMIN_AUDIT = [
  ...ADMIN_CATEGORIES.flatMap((cat) => cat.commands.map((command) => {
    const status = ADMIN_NOT_APPLICABLE[command]
      ? "na"
      : ADMIN_DISPATCH_COMMANDS.has(command) && PARKED_DISPATCH_MESSAGES[command]
        ? "dispatch"
        : "impl";
    return {
      command, category: cat.id, categoryTitle: cat.title, status,
      reason: ADMIN_NOT_APPLICABLE[command] ?? PARKED_DISPATCH_MESSAGES[command] ?? null,
    };
  })),
  ...ADMIN_MESSENGER_EXTRAS.map((e) => ({ ...e, categoryTitle: "➕ إضافات ماسنجر" })),
];

export function adminAuditCounts() {
  const counts = { impl: 0, dispatch: 0, na: 0, total: ADMIN_AUDIT.length };
  for (const row of ADMIN_AUDIT) counts[row.status] += 1;
  return counts;
}

export function adminCommandStatus(command) {
  const row = ADMIN_AUDIT.find((r) => r.command === command);
  return row ? { status: row.status, reason: row.reason, category: row.category } : null;
}

export function adminCategory(id) {
  return ADMIN_CATEGORIES.find((c) => c.id === id) ?? null;
}

// Implemented commands that Telegram lets EVERYONE run (not just the
// admin): the cert/get-code entry points and the user-side support
// commands. They are implemented here but NOT admin-gated.
export const ADMIN_UNGATED_IMPL = new Set([
  "cert1", "cert2", "getcode", "support", "feedback", "bug", "suggest",
]);

// Admin-gated commands: impl + na commands outside the "main" user
// category (plus admin/dashboard themselves), minus the ungated impl
// commands above. Dispatch commands and the parity user commands
// (start/learn/menu/help/cancel/...) are NOT gated — dispatch commands
// run for everyone through runUserCommand even though they now count
// as "impl" in the audit (src/dispatch-commands.js).
export const ADMIN_COMMANDS = new Set(
  ADMIN_AUDIT
    .filter((r) => (r.status === "impl" || r.status === "na") && r.category !== "main" && !ADMIN_UNGATED_IMPL.has(r.command) && !ADMIN_DISPATCH_COMMANDS.has(r.command))
    .map((r) => r.command)
    .concat(["admin", "dashboard"]),
);

export const ADMIN_MENU_ITEMS = [
  { key: "stats", label: "📊 إحصاءات البوت", payload: "admin|stats" },
  { key: "users", label: "👥 المستخدمون", payload: "admin|users" },
  { key: "bans", label: "🚫 المحظورون", payload: "admin|bans" },
  { key: "broadcast", label: "📢 بث رسالة", payload: "admin|broadcast" },
  { key: "reload", label: "🔄 إعادة تحميل البيانات", payload: "admin|reload" },
];

const BROADCAST_CONFIRM_WORDS = new Set(["نعم", "ايوه", "أيوه", "yes"]);
const BROADCAST_CANCEL_WORDS = new Set(["إلغاء", "الغاء", "cancel"]);

export function isBroadcastConfirm(text) {
  return BROADCAST_CONFIRM_WORDS.has(foldDigits(String(text ?? "").trim().toLowerCase()));
}

export function isBroadcastCancel(text) {
  return BROADCAST_CANCEL_WORDS.has(foldDigits(String(text ?? "").trim().toLowerCase()));
}

// A ban/unban target is a Messenger PSID (bare digits, optionally with
// an "msgr:" prefix). Returns the bare PSID, or null when unparseable.
export function normalizeTargetPsid(arg) {
  const raw = foldDigits(String(arg ?? "").trim()).replace(/^msgr:/u, "");
  const digits = raw.replace(/\D/gu, "");
  if (!/^\d{7,16}$/u.test(digits)) return null;
  return digits;
}

// /ban <target> [24h] [reason] — the optional 24h token makes a temp ban.
export function parseBanArgs(arg) {
  const parts = foldDigits(String(arg ?? "").trim()).split(/\s+/u).filter(Boolean);
  if (!parts.length) return { psid: null, hours: null, reason: "" };
  const psid = normalizeTargetPsid(parts[0]);
  let hours = null;
  let rest = parts.slice(1);
  const hoursMatch = rest[0]?.match(/^(\d+)h$/u);
  if (hoursMatch) {
    hours = Number(hoursMatch[1]);
    rest = rest.slice(1);
  }
  return { psid, hours, reason: rest.join(" ").slice(0, 120) };
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16);
}

export function adminMenuText() {
  return directLines([
    "🛠 الإدارة — اختر القسم:",
    "أرسل رقمًا للاختيار، أو اضغط على القسم.",
    "",
    ...ADMIN_CATEGORIES.map((cat, i) => `${i + 1}. ${cat.title} (${cat.commands.length} أمر)`),
    "",
    "أوامر سريعة:",
    "/stats — الإحصاءات",
    "/users — المستخدمون",
    "/bans — المحظورون",
    "/broadcast — بث",
    "/reload — تحديث البيانات",
  ].join("\n"));
}

export function adminCategoryText(categoryId) {
  const cat = adminCategory(categoryId);
  if (!cat) return null;
  const lines = [
    `📋 ${cat.title} (${cat.commands.length} أمر)`,
    "أرسل رقمًا للاختيار، أو اكتب الأمر مباشرة.",
    "",
  ];
  cat.commands.forEach((name, i) => {
    const st = adminCommandStatus(name);
    const mark = st?.status === "na" ? " (غير متاح على ماسنجر)" : "";
    lines.push(`${i + 1}. /${name}${mark}`);
  });
  lines.push("", "«رجوع» للوحة الإدارة.");
  return directLines(lines.join("\n"));
}

export function formatAdminStats(stats, uptimeMin = null) {
  const lines = [
    "📊 إحصاءات البوت",
    `📖 عدد مفردات القاموس: ${Number(stats.recordCount ?? 0).toLocaleString("en-US")}`,
    `🔎 إجمالي عمليات البحث: ${Number(stats.totalSearches ?? 0).toLocaleString("en-US")}`,
    `🔎 عمليات بحث اليوم: ${Number(stats.searchesToday ?? 0).toLocaleString("en-US")}`,
    `👥 عدد المستخدمين: ${stats.users ?? 0}`,
    `🚫 المحظورون: ${stats.bans ?? 0}`,
  ];
  if (uptimeMin !== null && uptimeMin !== undefined) lines.push(`⏰ مدة التشغيل: ${uptimeMin} دقيقة`);
  return lines.join("\n");
}

export function formatUsersList(users, total) {
  const list = Array.isArray(users) ? users : [];
  const lines = [`👥 المستخدمون: ${total ?? list.length}`];
  if (!list.length) lines.push("لا يوجد مستخدمون بعد.");
  for (const u of list) {
    const name = u.name ? `${String(u.name).slice(0, 30)} — ` : "";
    const bannedTag = u.blocked ? " 🚫" : "";
    lines.push(`• ${name}${u.id}${u.username ? ` (@${u.username})` : ""}${bannedTag}`);
  }
  return lines.join("\n");
}

export function formatBansList(bans) {
  const entries = Object.entries(bans ?? {});
  if (!entries.length) return "🚫 لا يوجد محظورون حاليًا.";
  const lines = [`🚫 المحظورون: ${entries.length}`];
  for (const [psid, entry] of entries) {
    const until = entry?.until ? ` حتى ${fmtDate(entry.until)}` : " (دائم)";
    const reason = entry?.reason ? ` — ${entry.reason}` : "";
    lines.push(`• ${psid}${until}${reason}`);
  }
  lines.push("", "لإلغاء الحظر: /unban <رقم>");
  return lines.join("\n");
}

export function broadcastConfirmText(text, recipientCount) {
  return [
    "📢 تأكيد البث",
    `سيتم إرسال الرسالة إلى ${recipientCount} مستخدم:`,
    "",
    String(text).slice(0, 500),
    "",
    "أرسل «نعم» للإرسال، أو «إلغاء» للتراجع.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The parity handler
// ---------------------------------------------------------------------------

const NAV_WORDS = new Set([
  "التالي", "next", "السابق", "prev", "رجوع", "back",
  "القائمة", "القائمه", "menu", "الرئيسية", "الرئيسيه", "home",
]);

function emptyPlan() {
  return { texts: [], voiceUrl: null };
}

function textPlan(text, quickReplies = []) {
  return { texts: [{ text, quickReplies }], voiceUrl: null };
}

// Attach quick replies to the LAST text of a plan (never to an earlier
// one, and never followed by another message in the same turn).
function withQuickRepliesOnLast(plan, items) {
  if (!plan.texts.length) return plan;
  // Menu items carry `label`; nav/confirm items carry `title` — both
  // become quick-reply titles here.
  const replies = buildQuickReplies(
    (Array.isArray(items) ? items : []).map((item) => ({
      title: item?.title ?? item?.label,
      payload: item?.payload,
    })),
  );
  if (!replies.length) return plan;
  const last = plan.texts[plan.texts.length - 1];
  return { ...plan, texts: [...plan.texts.slice(0, -1), { ...last, quickReplies: replies }] };
}

export function createMessengerParity(deps = {}) {
  const {
    learnLevels = LEARN_LEVELS,
    mediaUrlFor = defaultMediaUrlFor,
    learnAppUrl = LEARN_APP_URL,
    certLookup = lookupCertificate,
    getCode = getCodeFromMacro,
    macroUrl = null,
    fetchLiveExamPattern = null,
    lookupCodeName = null,
    examForms = [],
    examGate = null,
    adminPsids = [],
    isBanned = null,
    getStats = null,
    listUsers = null,
    listBans = null,
    banUser = null,
    unbanUser = null,
    listRecipients = null,
    reloadData = null,
    // Full-admin deps (all optional; a missing dep answers "not wired"
    // instead of crashing — the wiring spec lists the DO-backed source
    // for each one).
    adminStore = null, // { get(key), put(key, value), del(key) } — DO key/value
    getUserRecord = null, // (psid) => { record, history } | null
    updateUserRecord = null, // (psid, patch) => boolean
    deleteUserRecord = null, // (psid) => boolean
    listUserPage = null, // ({ limit, query }) => { users, total }
    getUsage = null, // () => { today, total, ... } | null
    listErrors = null, // () => [{ at, where, message }] | null
    listAuditLog = null, // () => [{ at, action, detail }] | null
    listSecurityLog = null, // () => [{ at, event, detail }] | null
    getDriveConfig = null, // () => { url, configured } | null
    setMacroUrl = null, // (url) => boolean
    listTickets = null, // () => [{ id, userId, subject, status }] | null
    getTicket = null, // (id) => { id, userId, subject, status, messages } | null
    closeTicket = null, // (id) => boolean
    createTicket = null, // ({ userId, subject, kind }) => { id } | null
    runUserCommand = null, // (cmd, arg, senderId) => plan | null — owning agent
    getDictAudit = null, // () => { duplicates, emptyMeaning, ... } | null
    deleteVoice = null, // (wordId) => boolean — Telegram-pipeline stub for voice_delete_all/_many only
    putRecording = null, // (r2Key, bytes, contentType) => { ok, error } — R2 upload for /record
    deleteRecording = null, // (r2Key) => { ok, error } — R2 delete for /voice_delete
    fetchImpl = null, // fetch for downloading the admin's audio attachment (and get-code screenshot images for OCR)
    ocrApiKey = null, // OCR.space free API key for get-code screenshot verification (OCR_SPACE_API_KEY wrangler secret); null = OCR skipped, fail open
    searchWords = null, // (query) => [{ id, coptic, pronunciation, english, meaning }] — for /record_choose
    nextUnrecorded = null, // (recordedIds:Set<string>) => { id, coptic, ... , recorded, total } | null — for /record
    getBroadcastControl = null, // () => { paused, speed } | null
    setBroadcastControl = null, // (patch) => boolean
    getBroadcastStats = null, // () => { sent, total, ... } | null
    editDictionary = null, // ({ op, ... }) => { ok, detail } | null
    runTask = null, // (task) => plan | null — coordinator executes side effects
  } = deps;

  // Per-user parity state. Default: in-memory (tests + fallback). The
  // wiring MUST pass DO-backed loadState/saveState for production: the
  // same UserStore record Telegram uses, keyed `msgr:<PSID>`, with the
  // parity fields merged under it — loadState returns the parity slice,
  // saveState persists the whole slice. State shape:
  //   { certAwaiting: "0"|"1", getcodeStep: "name"|"phone",
  //     getcodeName, examAwaiting: { formId, examUrl, lessonId },
  //     getcodeScreenshotAwaiting: true (waiting for the WhatsApp
  //       screenshot after a successful get-code), getcodeScreenshotName
  //       + getcodeScreenshotCode (the completed session — persist
  //       after the wait clears, so returning users get their code back
  //       without re-asking; only the wait flag is ever cleared),
  //     lastLessonId, lastLevelId, pendingBroadcast,
  //     scheduleFlow: { stage: "await-message"|"await-time", draft },
  //     recordState: { mode: "sequential"|"chosen", id, coptic },
  //     recordPick: true (choosing a word for /record_choose),
  //     menuList: { kind, items: [...] } }
  const memoryStates = new Map();
  const loadState = deps.loadState ?? (async (senderId) => ({ ...(memoryStates.get(String(senderId)) ?? {}) }));
  const saveState = deps.saveState ?? (async (senderId, next) => {
    memoryStates.set(String(senderId), { ...next });
  });

  // Default admin key/value store (in-memory — tests + fallback). The
  // wiring MUST pass a DO-backed adminStore for production, or settings
  // (flags, MOTD, lists, templates) will not survive an isolate recycle.
  const memoryAdminStore = new Map();
  const store = adminStore ?? {
    get: async (key) => memoryAdminStore.get(String(key)) ?? null,
    put: async (key, value) => { memoryAdminStore.set(String(key), value); return true; },
    del: async (key) => memoryAdminStore.delete(String(key)),
  };

  const adminSet = new Set(
    (Array.isArray(adminPsids) ? adminPsids : String(adminPsids ?? "").split(","))
      .map((s) => String(s ?? "").trim())
      .filter(Boolean),
  );
  // Fail closed: with no admin PSID configured, nobody is admin.
  const isAdmin = (senderId) => adminSet.size > 0 && adminSet.has(String(senderId));

  async function load(senderId) {
    try {
      return (await loadState(String(senderId))) ?? {};
    } catch {
      return {};
    }
  }

  async function commit(senderId, state, patch) {
    const next = { ...state };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    try {
      await saveState(String(senderId), next);
    } catch {
      /* state loss degrades to "ask again", never to a crash */
    }
    return next;
  }

  const clearFlows = {
    certAwaiting: undefined, getcodeStep: undefined, getcodeName: undefined,
    getcodeScreenshotAwaiting: undefined,
    examAwaiting: undefined, copticNameAwaiting: undefined,
    pendingBroadcast: undefined, pendingConfirm: undefined, menuList: undefined,
    recordState: undefined, recordPick: undefined, scheduleFlow: undefined,
  };

  // -- voice recording (/record) -------------------------------------------
  // Telegram's /record flow (final-code-fix src/index.js), adapted:
  // the admin records a word as a Messenger voice message; the Worker
  // downloads it and stores it in R2 recorded/<id>.<ext>, and the live
  // DO overlay (RECORDED_OVERLAY_KEY) makes it playable before its
  // manifest line lands. The prompt asks for the word 3× in one
  // recording — that IS the repeat mechanism (record-voice.js).
  // The dictionary itself lives with the owning agent: nextUnrecorded /
  // searchWords are injected deps (index.js closes over records).

  async function recordedOverlay() {
    const raw = await safeCall(store.get, RECORDED_OVERLAY_KEY);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }

  async function saveRecordedOverlay(next) {
    await safeCall(store.put, RECORDED_OVERLAY_KEY, next);
  }

  async function recordedIds() {
    return mergeRecordedIds(listRecordedVoiceIds(), await recordedOverlay());
  }

  // -- voice delete (/voice_delete) ----------------------------------------
  // Remove one recorded voice: the DO overlay entry (or a tombstone when
  // the id is in the baked-in manifest, so playback falls back to the
  // prebuilt voice instead of the dead recorded URL — record-voice.js
  // RECORDED_DELETED), plus the R2 object and its .mp3 sibling. The R2
  // delete is hygiene, not correctness: the overlay/tombstone alone
  // decides playback, so a failed or unwired R2 delete still clears the
  // voice and only leaves an orphan file (reported in the result).
  async function deleteRecordedVoice(id) {
    const overlay = await recordedOverlay();
    const manifestFilename = recordedManifestFilename(id);
    const result = applyVoiceDelete(overlay, id, manifestFilename);
    if (!result.hadRecording) return { status: "not-found", id };
    let r2Error = null;
    let r2Skipped = false;
    if (deleteRecording) {
      for (const key of voiceDeleteR2Keys(result.filename)) {
        const r = await safeCall(deleteRecording, key);
        if (!r?.ok) { r2Error = r?.error ?? "r2-delete-failed"; break; }
      }
    } else {
      r2Skipped = true;
    }
    await saveRecordedOverlay(result.nextOverlay);
    return { status: "deleted", id, filename: result.filename, inManifest: result.inManifest, r2Error, r2Skipped };
  }

  async function beginRecord(senderId, state) {
    if (!nextUnrecorded) return notWiredText("اختيار كلمة للتسجيل");
    const ids = await recordedIds();
    const word = await safeCall(nextUnrecorded, ids);
    if (!word) {
      await commit(senderId, state, { recordState: undefined, recordPick: undefined });
      return textPlan(recordPrompt(null));
    }
    await commit(senderId, state, {
      ...clearFlows,
      recordState: { mode: "sequential", id: word.id, coptic: word.coptic ?? "" },
    });
    return textPlan(recordPrompt(word, { recorded: word.recorded ?? ids.size, total: word.total ?? 0 }));
  }

  async function beginRecordChoose(senderId, state) {
    await commit(senderId, state, { ...clearFlows, recordPick: true });
    return textPlan("🔎 أرسل الكلمة التي تريد تسجيلها، وسأعرض لك اقتراحات القاموس.");
  }

  async function stopRecord(senderId, state) {
    await commit(senderId, state, { recordState: undefined, recordPick: undefined });
    return textPlan("⏸️ تم إيقاف جلسة التسجيل. أرسل /record لاستكمالها من أول كلمة غير مسجلة.");
  }

  async function startChosenRecording(senderId, state, item) {
    if (!item?.id) return textPlan("⚠️ لم أجد هذه الكلمة، أعد البحث من فضلك.");
    await commit(senderId, state, {
      ...clearFlows,
      recordState: { mode: "chosen", id: Number(item.id), coptic: String(item.coptic ?? item.label ?? "") },
    });
    return textPlan(recordPrompt({
      coptic: String(item.coptic ?? item.label ?? ""),
      pronunciation: item.pronunciation ?? "",
      english: item.english ?? "",
      meaning: item.meaning ?? "",
    }));
  }

  async function handleRecordChooseText(senderId, state, text) {
    if (!searchWords) return textPlan("⚠️ اختيار كلمة للتسجيل غير موصّل بعد على ماسنجر — يحتاج توصيل البحث في الربط.");
    const candidates = (await safeCall(searchWords, text)) ?? [];
    const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c?.id != null);
    if (!list.length) return textPlan("لم أجد كلمة بهذا البحث. جرّب بحثًا آخر:");
    if (list.length === 1) return startChosenRecording(senderId, state, list[0]);
    const items = list.slice(0, 15).map((c) => ({
      type: "record-pick", id: Number(c.id), label: String(c.coptic ?? ""),
      coptic: String(c.coptic ?? ""), pronunciation: c.pronunciation ?? "",
      english: c.english ?? "", meaning: c.meaning ?? "",
      payload: `record|pick:${c.id}`,
    }));
    const lines = ["اختر الكلمة التي تريد تسجيلها:", "أرسل رقمًا للاختيار.", "", ...items.map((it, i) => `${i + 1}. ${it.label}`)];
    const plan = textPlan(lines.join("\n"));
    plan.menuList = { kind: "record-choose", items };
    await commit(senderId, state, { menuList: plan.menuList });
    return withQuickRepliesOnLast(plan, items);
  }

  // One voice message from the admin while a record session is open.
  // attachment: the Messenger audio attachment { type: "audio",
  // payload: { url } }. Returns a plan, or null when the message is not
  // a recording turn.
  async function handleAudio(senderId, attachment) {
    if (!isAdmin(senderId)) return emptyPlan();
    const state = await load(senderId);
    const rec = state.recordState;
    if (!rec?.id) {
      return textPlan("🎙️ لبدء التسجيل أرسل /record (أو /record_choose لاختيار كلمة).");
    }
    if (state.recordPick) {
      return textPlan("🔎 اختر الكلمة أولًا من القائمة، ثم أرسل الصوت.");
    }
    const url = attachment?.type === "audio" ? attachment?.payload?.url : null;
    if (!url || typeof url !== "string") {
      return textPlan("⚠️ لم يصل أي ملف صوتي. أرسل التسجيل كرسالة صوتية.");
    }
    let bytes = null;
    let contentType = "";
    try {
      const res = await (fetchImpl ?? globalThis.fetch)(url, { signal: AbortSignal.timeout(RECORD_AUDIO_TIMEOUT_MS) });
      if (!res.ok) return textPlan("⚠️ تعذّر تنزيل الصوت من ماسنجر، حاول إرساله مرة أخرى.");
      contentType = res.headers?.get?.("content-type") ?? "";
      const buf = await res.arrayBuffer();
      bytes = new Uint8Array(buf);
    } catch {
      return textPlan("⚠️ تعذّر تنزيل الصوت من ماسنجر، حاول إرساله مرة أخرى.");
    }
    if (!bytes || bytes.byteLength < 100) {
      return textPlan("⚠️ الصوت فارغ أو قصير جدًا — سجّل الكلمة مرة أخرى.");
    }
    if (bytes.byteLength > MAX_RECORD_BYTES) {
      return textPlan(`⚠️ الصوت كبير جدًا (الحد ${Math.round(MAX_RECORD_BYTES / 1024 / 1024)} ميجا). سجّل مقطعًا أقصر.`);
    }
    const filename = recordedFileName(rec.id, contentType, url);
    if (!filename) {
      return textPlan("⚠️ تعذّر تحديد صيغة الصوت. جرّب إرساله مرة أخرى.");
    }
    if (!putRecording) {
      return textPlan("⚠️ التخزين غير موصّل بعد على ماسنجر — يحتاج ربط مخزن R2 (انظر مواصفات الربط).");
    }
    const saved = await safeCall(putRecording, `${RECORDED_R2_PREFIX}/${filename}`, bytes, cleanMimeType(contentType) || "audio/mp4");
    if (!saved?.ok) {
      return textPlan(`⚠️ تعذّر حفظ التسجيل: ${saved?.error ?? "خطأ غير معروف"}. حاول مرة أخرى.`);
    }
    const overlay = await recordedOverlay();
    const had = Object.hasOwn(overlay, String(rec.id)) || listRecordedVoiceIds().includes(String(rec.id));
    await saveRecordedOverlay({ ...overlay, [String(rec.id)]: filename });
    const word = rec.coptic ? `«${rec.coptic}»` : "الكلمة";
    const confirm = `✅ تم حفظ تسجيل ${word}${had ? " (استبدل التسجيل السابق)" : ""}.`;
    if (rec.mode === "chosen") {
      await commit(senderId, state, { recordState: undefined, recordPick: true });
      return textPlan(`${confirm}\n🔎 أرسل كلمة أخرى للبحث عنها وتسجيلها، أو أرسل /record_stop.`);
    }
    // Sequential: advance to the next unrecorded word (Telegram's
    // nextVoicePrompt). The merged set now includes the word just saved.
    if (!nextUnrecorded) return textPlan(confirm);
    const ids = await recordedIds();
    const next = await safeCall(nextUnrecorded, ids);
    if (!next) {
      await commit(senderId, state, { recordState: undefined, recordPick: undefined });
      return textPlan(`${confirm}\n${recordPrompt(null)}`);
    }
    await commit(senderId, state, {
      recordState: { mode: "sequential", id: next.id, coptic: next.coptic ?? "" },
    });
    return textPlan(`${confirm}\n${recordPrompt(next, { recorded: next.recorded ?? ids.size, total: next.total ?? 0 })}`);
  }

  // -- learn ---------------------------------------------------------------

  async function levelsPlan(senderId, state) {
    const items = learnLevels.map((l) => ({ type: "level", levelId: l.id, label: l.title, payload: `learn|level:${l.id}` }));
    const plan = textPlan(levelsText(learnLevels, learnAppUrl));
    plan.menuList = { kind: "learn-home", items };
    await commit(senderId, state, { menuList: plan.menuList });
    return withQuickRepliesOnLast(plan, items);
  }

  async function levelMenuPlan(senderId, state, levelId) {
    const items = levelMenuItems(levelId, learnLevels);
    if (!items) return textPlan("⚠️ المستوى غير موجود. أرسل /learn لعرض المستويات.");
    const plan = textPlan(levelMenuText(levelId, learnLevels));
    plan.menuList = { kind: "level", levelId, items };
    await commit(senderId, state, { menuList: plan.menuList });
    return withQuickRepliesOnLast(plan, items);
  }

  async function mainMenuPlan(senderId, state) {
    const plan = textPlan(mainMenuText());
    plan.menuList = { kind: "menu", items: MAIN_MENU_ITEMS };
    await commit(senderId, state, { menuList: plan.menuList });
    return withQuickRepliesOnLast(plan, MAIN_MENU_ITEMS);
  }

  async function sendLesson(senderId, state, lessonId) {
    const plan = lessonPlan(lessonId, { levels: learnLevels, mediaUrlFor });
    if (!plan) return textPlan("⚠️ هذا الدرس ليس جاهزًا بعد — جرّب لاحقًا أو أبلغ الإدارة.");
    const { lesson, level } = plan;
    const texts = [];
    const attachments = [];
    let exam = null;
    for (const step of plan.steps) {
      if (step.type === "media") {
        attachments.push({
          type: step.kind === "video" ? "video" : "image",
          url: step.url,
          caption: step.caption,
        });
      } else if (step.type === "text") {
        texts.push({ text: step.text });
      } else if (step.type === "exam") {
        exam = step;
      }
    }
    if (exam) {
      texts.push({ text: "📝 الامتحان الإلكتروني\nأرسل رقمك الكودي لفتح الامتحان." });
    }
    // Nav hint + nav quick replies live on the LAST text of the turn —
    // never followed by another message, so they stay in the composer.
    const hint = lessonNavHint(lessonId, learnLevels);
    if (texts.length) {
      const last = texts[texts.length - 1];
      texts[texts.length - 1] = { ...last, text: `${last.text}\n\n${hint}` };
    } else {
      texts.push({ text: `🎓 ${lesson.title}\n\n${hint}` });
    }
    const { index, total } = lessonIndex(lessonId, learnLevels);
    const navItems = [];
    if (index > 0) navItems.push({ title: "⏮ السابق", payload: `learn|prev:${lessonId}` });
    if (index >= 0 && index < total - 1) navItems.push({ title: "التالي ⏭", payload: `learn|next:${lessonId}` });
    navItems.push({ title: "🔙 رجوع", payload: `learn|back:${level.id}` });
    navItems.push({ title: "🏠 الرئيسية", payload: "learn|home" });
    await commit(senderId, state, {
      lastLessonId: lessonId,
      lastLevelId: level.id,
      examAwaiting: exam ? { formId: exam.formId, examUrl: exam.examUrl, lessonId } : undefined,
      certAwaiting: undefined, getcodeStep: undefined, getcodeName: undefined,
      getcodeScreenshotAwaiting: undefined,
      pendingBroadcast: undefined, recordState: undefined, recordPick: undefined,
      menuList: { kind: "learn-nav", lessonId },
    });
    const out = { texts, voiceUrl: null, attachments };
    return withQuickRepliesOnLast(out, navItems);
  }

  // -- certificates ----------------------------------------------------------

  async function beginCertFlow(senderId, state, level) {
    // level: external "1" | "2" (Telegram's internal "0" | "1" is stored).
    const internal = level === "2" ? "1" : "0";
    await commit(senderId, state, {
      ...clearFlows, certAwaiting: internal,
    });
    return textPlan(CERT_ASK_TEXT);
  }

  async function handleCertCode(senderId, state, code) {
    const clean = foldDigits(String(code ?? "").trim());
    // Bad shape never hits the Sheets (same as the WhatsApp port).
    if (!isCertCodeShape(clean)) return certResultToPlan({ kind: "not-found" });
    let result;
    try {
      result = await certLookup(clean, state.certAwaiting);
    } catch {
      result = { kind: "error", text: "❌ تعذّر الوصول لشيت النتائج حاليًا. جرّب لاحقًا." };
    }
    // The session STAYS open after each code (Telegram): the student can
    // send another code without re-tapping, until /cancel, /menu, /start
    // or a nav tap.
    return certResultToPlan(result);
  }

  // -- get-code --------------------------------------------------------------

  async function beginGetCodeFlow(senderId, state) {
    // Returning user (28 Nov 2026, Telegram's exact behavior): they
    // already have a code stored — show it directly, never re-ask for
    // name/phone. The stored name+code persist after the screenshot wait
    // clears (only the wait flag is ever cleared, never the record).
    if (state?.getcodeScreenshotName && state?.getcodeScreenshotCode) {
      return { ...textPlan(`مرحباً ${state.getcodeScreenshotName}، الرقم الكودي الخاص بك هو ${state.getcodeScreenshotCode}`), getCodeReply: true };
    }
    await commit(senderId, state, {
      ...clearFlows, getcodeStep: "name", getcodeName: undefined,
    });
    return textPlan("✏️ اكتب اسمك الثلاثي:");
  }

  // /copticname — كتابة الاسم بالحروف القبطية (طلب المستخدم 27 نوفمبر 2026).
  // نفس المنطق في التليجرام والواتساب: الأمر لوحده يسأل عن الاسم،
  // و/copticname <اسم> يجاوب فورًا. الترجمة نفسها في coptic-name.js
  // (مشتركة مع التليجرام). الخطط موسومة copticNameReply: true فيُرسلها
  // الـ Worker مباشرة (نفس علاج get-code) بدل ما تضيع في تدفق Botcake.
  async function beginCopticNameFlow(senderId, state) {
    await commit(senderId, state, { ...clearFlows, copticNameAwaiting: true });
    return { ...textPlan("✍️ اكتب اسمك بالعربي أو بالإنجليزي:"), copticNameReply: true };
  }

  async function handleCopticNameStep(senderId, state, text) {
    const reply = copticNameReply(text);
    if (!reply) {
      return { ...textPlan("⚠️ اكتب اسم صحيح بالعربي أو بالإنجليزي، أو /cancel للإلغاء."), copticNameReply: true };
    }
    await commit(senderId, state, { copticNameAwaiting: undefined });
    return { ...textPlan(reply), copticNameReply: true };
  }

  async function handleGetCodeStep(senderId, state, text) {
    if (state.getcodeStep === "name") {
      const name = String(text ?? "").trim();
      if (!name) return textPlan("✏️ اكتب اسمك الثلاثي:");
      await commit(senderId, state, { getcodeStep: "phone", getcodeName: name });
      return textPlan("📱 اكتب رقم موبايلك:");
    }
    const phone = normalizeGetCodePhoneMsgr(text);
    if (!getCodePhoneValidMsgr(phone)) {
      return textPlan("📱 رقم الموبايل لازم يكون ٤ أرقام على الأقل — اكتبه تاني:");
    }
    const name = String(state.getcodeName ?? "").trim();
    await commit(senderId, state, { getcodeStep: undefined, getcodeName: undefined, getcodeScreenshotAwaiting: undefined });
    let result;
    try {
      result = await getCode(name, phone, macroUrl);
    } catch {
      result = { code: null, error: "macro-unreachable" };
    }
    if (result?.code) {
      // Remember the session: the name+code persist (returning users get
      // their code back without re-asking), and the one-shot screenshot
      // wait opens — it ends when the photo arrives, or on /cancel,
      // /menu, /start or another menu tap (same clearing as the other
      // waits; only the wait flag clears, never the record).
      // Get-code reply: text FIRST, then the example screenshot image
      // (Messenger has no photo captions — same words, same order as
      // Telegram's captioned photo). The Worker direct-sends both whole
      // (getCodePhotoReply block in src/index.js, like /share) so the
      // long wa.me link never hits the Botcake chunk splitter.
      await commit(senderId, state, {
        getcodeStep: undefined, getcodeName: undefined,
        getcodeScreenshotAwaiting: true, getcodeScreenshotName: name, getcodeScreenshotCode: String(result.code),
      });
      return {
        texts: [{ text: buildGetCodeReply(name, String(result.code)) }],
        voiceUrl: null,
        attachments: [{ type: "image", url: GET_CODE_EXAMPLE_PHOTO_URL }],
        getCodePhotoReply: true,
      };
    }
    // The macro did not return a usable code (no URL linked, or the
    // deployment answers HTML): fall back to the registration
    // instructions — the web form link — so the student is never stuck.
    // The fallback is the same shape, so it rides the direct send too —
    // otherwise the student gets silence instead of the instructions.
    return { ...textPlan(`⚠️ تعذّر إحضار الرقم الكودي مباشرة من البوت حاليًا.\n\n${LEARN_GET_CODE_TEXT}`), getCodeReply: true };
  }

  // Get-code screenshot (28 Nov 2026, Telegram's exact behavior + OCR
  // verification): after the code reply, the student sends the WhatsApp
  // screenshot back. On the WEBHOOK path the image arrives with its
  // Facebook CDN attachment URL (image.payload.url — expires, so it is
  // downloaded immediately) and is OCR-verified FIRST: the admin number
  // showing as raw digits (unsaved), a missing code, or a name that is
  // not THE STUDENT'S OWN (anti-cheat — someone else's screenshot, or
  // the bot's example image) are ALL rejected with the SAME single text
  // and the wait left open so the student can re-send; any OCR problem
  // fails open to the activation below. On the /botcake path the image
  // arrives as an empty-text call with NO bytes (image is null) — OCR
  // cannot run there, so it always fails open to the activation. Only
  // an accepted screenshot confirms the activation with their name +
  // code from the just-completed session. One shot: only the wait flag
  // clears on receipt (the stored name+code persist for returning
  // users), so a later unrelated image does not repeat it. An image
  // without a completed get-code session returns null (normal handling
  // — on the webhook path that means silence, as today). The plan
  // carries getCodeReply so the /botcake path direct-sends it (the flow
  // would drop it otherwise); on the webhook path the flag is ignored
  // and the text is sent directly.
  async function handleImage(senderId, image = null) {
    const state = await load(senderId);
    if (state?.getcodeScreenshotAwaiting && state?.getcodeScreenshotName && state?.getcodeScreenshotCode) {
      const imageUrl = image?.payload?.url ?? null;
      const verdict = await verifyGetCodeScreenshot(imageUrl, state.getcodeScreenshotCode, state.getcodeScreenshotName);
      if (verdict === "unsaved-number" || verdict === "no-code" || verdict === "name-mismatch") {
        return { ...textPlan(GET_CODE_SCREENSHOT_UNSAVED_TEXT), getCodeReply: true };
      }
      await commit(senderId, state, { getcodeScreenshotAwaiting: undefined });
      return { ...textPlan(`تم تفعيل اشتراكك عزيزنا ${state.getcodeScreenshotName} والرقم الكودي الخاص بك هو: ${state.getcodeScreenshotCode}`), getCodeReply: true };
    }
    return null;
  }

  // Screenshot OCR verification (2026-11-28): download the image from
  // its Facebook CDN URL and OCR it (OCR.space, key from the
  // OCR_SPACE_API_KEY secret — see verifyScreenshotOcr in
  // src/getcode.js). No URL (the /botcake empty-text hook), no key, a
  // failed download, or any OCR problem → "skipped": the caller FAILS
  // OPEN and activates as before, so a legit student is never stranded
  // by the OCR service being down.
  async function verifyGetCodeScreenshot(imageUrl, code, name) {
    const apiKey = String(ocrApiKey ?? "").trim();
    if (!apiKey || !imageUrl) return "skipped";
    try {
      const fetchFn = fetchImpl ?? globalThis.fetch;
      const response = await fetchFn(String(imageUrl), { signal: AbortSignal.timeout(15000) });
      if (!response?.ok) return "skipped";
      const bytes = new Uint8Array(await response.arrayBuffer());
      return (await verifyScreenshotOcr(bytes, code, apiKey, fetchFn, name)).verdict;
    } catch {
      return "skipped";
    }
  }

  // -- exams -----------------------------------------------------------------

  async function checkExamCode(code, formId) {
    const folded = foldDigits(String(code ?? "").trim());
    if (examGate) {
      try {
        return await examGate(folded, formId);
      } catch {
        return { allowed: false, name: null };
      }
    }
    const clean = folded;
    let allowed = false;
    const baked = bakedPatternFor(formId, examForms);
    if (baked) allowed = codeMatches(baked, clean);
    if (!allowed && /^\d{7,}$/u.test(clean) && fetchLiveExamPattern) {
      try {
        const live = await fetchLiveExamPattern(formId);
        if (live?.pattern) allowed = codeMatches(live.pattern, clean);
      } catch { /* fail closed */ }
    }
    if (!allowed) return { allowed: false, name: null };
    let name = null;
    if (lookupCodeName) {
      try {
        name = await lookupCodeName(clean);
      } catch { name = null; }
    }
    return { allowed: true, name };
  }

  async function handleExamCode(senderId, state, code) {
    const exam = state.examAwaiting;
    if (!exam) return null;
    const result = await checkExamCode(code, exam.formId);
    if (result.allowed) {
      await commit(senderId, state, { examAwaiting: undefined });
      // In-app answering is LINK-OUT: the exam itself is the Google Form
      // in the browser (Messenger cannot open the /learn-app/ webapp);
      // only the code gate runs in-chat.
      const url = examUrlFor(exam.formId, exam.examUrl, examForms);
      return textPlan(examLinkText(url, result.name));
    }
    // The gate stays open: the student can retry the code, or /cancel.
    return textPlan("⚠️ الرقم الكودي غير مؤهل لهذا الامتحان. تأكد من الرقم وحاول مرة أخرى، أو أرسل /cancel للإلغاء.");
  }

  // -- admin -----------------------------------------------------------------

  async function adminStatsPlan() {
    if (!getStats) return textPlan("📊 إحصاءات البوت\n(غير متاحة — لم يتم توصيل مصدر الإحصاءات بعد.)");
    let stats;
    try {
      stats = await getStats();
    } catch {
      return textPlan("❌ تعذّر قراءة الإحصاءات حاليًا. جرّب لاحقًا.");
    }
    if (!stats) return textPlan("❌ تعذّر قراءة الإحصاءات حاليًا. جرّب لاحقًا.");
    return textPlan(formatAdminStats(stats, stats.uptimeMin ?? null));
  }

  async function adminUsersPlan() {
    if (!listUsers) return textPlan("👥 المستخدمون\n(غير متاحة — لم يتم توصيل مصدر المستخدمين بعد.)");
    let page;
    try {
      page = await listUsers();
    } catch {
      return textPlan("❌ تعذّر قراءة المستخدمين حاليًا. جرّب لاحقًا.");
    }
    if (!page) return textPlan("❌ تعذّر قراءة المستخدمين حاليًا. جرّب لاحقًا.");
    return textPlan(formatUsersList(page.users ?? [], page.total ?? (page.users ?? []).length));
  }

  async function adminBansPlan() {
    if (!listBans) return textPlan("🚫 المحظورون\n(غير متاحة — لم يتم توصيل مصدر الحظر بعد.)");
    let bans;
    try {
      bans = await listBans();
    } catch {
      return textPlan("❌ تعذّر قراءة المحظورين حاليًا. جرّب لاحقًا.");
    }
    return textPlan(formatBansList(bans ?? {}));
  }

  async function adminBanPlan(senderId, arg) {
    const parsed = parseBanArgs(arg);
    if (!parsed.psid) return textPlan("✏️ الاستخدام: /ban <رقم> [المدة مثل 24h] [السبب]");
    if (parsed.psid === String(senderId)) return textPlan("⚠️ لا يمكنك حظر نفسك.");
    if (isAdmin(parsed.psid)) return textPlan("⚠️ لا يمكن حظر الأدمن.");
    if (!banUser) return textPlan("🚫 الحظر غير مفعّل — لم يتم توصيل مصدر الحظر بعد.");
    let ok = false;
    try {
      ok = await banUser(parsed.psid, { reason: parsed.reason, hours: parsed.hours });
    } catch { ok = false; }
    if (!ok) return textPlan("❌ تعذّر تنفيذ الحظر حاليًا. جرّب لاحقًا.");
    return textPlan(`🚫 تم حظر ${parsed.psid}${parsed.hours ? ` لمدة ${parsed.hours} ساعة` : " (دائم)"}${parsed.reason ? ` — ${parsed.reason}` : ""}.`);
  }

  async function adminUnbanPlan(arg) {
    const psid = normalizeTargetPsid(arg);
    if (!psid) return textPlan("✏️ الاستخدام: /unban <رقم>");
    if (!unbanUser) return textPlan("🚫 إلغاء الحظر غير مفعّل — لم يتم توصيل مصدر الحظر بعد.");
    let had = false;
    try {
      had = await unbanUser(psid);
    } catch { had = false; }
    return textPlan(had ? `✅ تم إلغاء حظر ${psid}.` : "هذا الرقم ليس محظورًا.");
  }

  // -- scheduled broadcasts (/schedule, /schedules, /unschedule) -----------
  // Same compose flow as Telegram/WhatsApp: /schedule (or /schedule <text>)
  // captures the message, then a time («بعد ساعتين», «26/11 08:00» Cairo),
  // and the 5-minute cron tick sends it. Jobs live in the admin store
  // under SCHEDULED_BROADCAST_KEY; the tick reads the same key.
  //
  // Media limit (Messenger-only, 2026-11-25): the live receive path is
  // Botcake, which forwards TEXT only — the Worker never sees an admin's
  // photo/video (the Meta webhook path is unsubscribed). So media is
  // scheduled by pasting its PUBLIC URL (e.g. an R2 link, like the /share
  // poster) with an optional caption; the tick sends it as an attachment.
  // Facebook CDN URLs expire — use a stable public link (R2).
  const SCHEDULED_BROADCAST_KEY = "broadcast:scheduled";
  const SCHEDULE_TIME_PROMPT = [
    "⏰ اكتب ميعاد الإرسال:",
    "• «بعد ساعتين» أو «بعد 30 دقيقة»",
    "• «بكرة 08:00» أو «النهاردة 21:00»",
    "• «26/11 08:00»",
    "أو أرسل «إلغاء» للتراجع.",
  ].join("\n");
  const SCHEDULE_MEDIA_EXTS = {
    image: ["jpg", "jpeg", "png", "gif", "webp"],
    video: ["mp4", "mov", "webm"],
  };
  function extractScheduleMedia(text) {
    const match = String(text ?? "").match(/https?:\/\/\S+/u);
    if (!match) return null;
    const url = match[0].replace(/[.,;!?)\]]+$/u, "");
    const ext = (url.split("?")[0].split(".").pop() ?? "").toLowerCase();
    const kind = SCHEDULE_MEDIA_EXTS.video.includes(ext) ? "video"
      : SCHEDULE_MEDIA_EXTS.image.includes(ext) ? "image" : null;
    if (!kind) return null;
    const caption = String(text ?? "").replace(match[0], "").replace(/\s+/gu, " ").trim();
    return { kind, mediaUrl: url, caption };
  }
  function scheduleDraftFromText(text) {
    const media = extractScheduleMedia(text);
    if (media) return { kind: media.kind, mediaUrl: media.mediaUrl, caption: media.caption || "" };
    return { kind: "text", text: String(text ?? "") };
  }
  function scheduleJobLabel(job) {
    if (!job) return "";
    if (job.kind === "text") return String(job.text ?? "").slice(0, 60);
    if (job.kind === "video") return `🎬 فيديو${job.caption ? ` — ${String(job.caption).slice(0, 40)}` : ""}`;
    if (job.kind === "image") return `📷 صورة${job.caption ? ` — ${String(job.caption).slice(0, 40)}` : ""}`;
    return String(job.text ?? "").slice(0, 60);
  }
  async function loadScheduledJobs() {
    let jobs = [];
    try { jobs = (await safeCall(store.get, SCHEDULED_BROADCAST_KEY)) ?? []; } catch { jobs = []; }
    return Array.isArray(jobs) ? jobs.filter((j) => j && typeof j.id === "string" && Number.isFinite(j.sendAt)) : [];
  }
  async function saveScheduledJobs(jobs) {
    await safeCall(store.put, SCHEDULED_BROADCAST_KEY, jobs);
  }
  function scheduleJobId() {
    return Math.random().toString(36).slice(2, 8);
  }
  async function scheduleBroadcastPlan(senderId, state, arg) {
    const text = String(arg ?? "").trim();
    if (text) {
      if (text.length > BROADCAST_MAX_CHARS) return textPlan(`⚠️ الرسالة طويلة جدًا (الحد ${BROADCAST_MAX_CHARS} حرف).`);
      const draft = scheduleDraftFromText(text);
      await commit(senderId, state, { scheduleFlow: { stage: "await-time", draft } });
      return textPlan(`📅 الرسالة جاهزة:\n${scheduleJobLabel(draft)}\n\n${SCHEDULE_TIME_PROMPT}`);
    }
    await commit(senderId, state, { scheduleFlow: { stage: "await-message", draft: null } });
    return textPlan([
      "📅 أرسل رسالة البث — نص، أو رابط صورة/فيديو عام مع نص اختياري.",
      "مثال: رابط صورة من R2 ثم سطر نصي كتعليق.",
      "⚠️ البوت يستقبل النصوص فقط في ماسنجر، فالصور والفيديوهات تُجدول برابطها العام (روابط فيسبوك المؤقتة قد تنتهي قبل الميعاد — استخدم رابطًا ثابتًا مثل R2).",
      "أو أرسل «إلغاء» للتراجع.",
    ].join("\n"));
  }
  async function sendScheduledList(senderId) {
    const jobs = (await loadScheduledJobs()).sort((a, b) => a.sendAt - b.sendAt);
    if (!jobs.length) return textPlan("📅 لا توجد رسائل مجدولة.");
    const lines = ["📅 الرسائل المجدولة:"];
    for (const job of jobs) {
      const sending = job.status === "sending" ? " ⏳ جارٍ الإرسال" : "";
      lines.push(`• ${formatCairoDateTime(job.sendAt)} — ${scheduleJobLabel(job)} (🆔 ${job.id})${sending}`);
    }
    lines.push("", "للإلغاء: /unschedule <المعرف>");
    return textPlan(lines.join("\n"));
  }
  async function cancelScheduled(senderId, id) {
    const jobId = String(id ?? "").trim();
    if (!jobId) return textPlan("✏️ الاستخدام: /unschedule <المعرف> — اعرض المعرفات بـ /schedules");
    const jobs = await loadScheduledJobs();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return textPlan(`⚠️ لا توجد رسالة مجدولة بالمعرف «${jobId}».`);
    await saveScheduledJobs(jobs.filter((j) => j.id !== jobId));
    return textPlan(`✅ تم إلغاء الرسالة المجدولة «${scheduleJobLabel(job)}» (${formatCairoDateTime(job.sendAt)}).`);
  }

  async function adminBroadcastPlan(senderId, state, arg) {
    if (!arg) return textPlan("✏️ الاستخدام: /broadcast <نص الرسالة> — ثم أرسل «نعم» للتأكيد، أو «إلغاء» للتراجع.");
    if (arg.length > BROADCAST_MAX_CHARS) return textPlan(`⚠️ الرسالة طويلة جدًا (الحد ${BROADCAST_MAX_CHARS} حرف).`);
    if (!listRecipients) return textPlan("📢 البث غير مفعّل — لم يتم توصيل مصدر المستلمين بعد.");
    let recipients;
    try {
      recipients = await listRecipients();
    } catch {
      return textPlan("❌ تعذّر قراءة المستلمين حاليًا. جرّب لاحقًا.");
    }
    if (!recipients?.length) return textPlan("⚠️ لا يوجد مستخدمون لإرسال البث إليهم.");
    await commit(senderId, state, { pendingBroadcast: arg });
    // The confirm text is the last message of the turn; the "نعم" /
    // "إلغاء" quick replies ride on it so they stay in the composer.
    const plan = textPlan(broadcastConfirmText(arg, recipients.length));
    return withQuickRepliesOnLast(plan, [
      { title: "نعم", payload: "admin|confirm-broadcast" },
      { title: "إلغاء", payload: "admin|cancel-broadcast" },
    ]);
  }

  async function adminReloadPlan() {
    if (reloadData) {
      try {
        const result = await reloadData();
        if (result?.text) return textPlan(result.text);
      } catch { /* fall through to the counts report */ }
    }
    // Messenger data is bundled at deploy and follows the existing
    // auto-sync (Sheet -> manifest every 30 min -> deploy on change);
    // there is no disk store to reload. Report what is live now.
    const lessons = learnLevels.reduce((n, l) => n + (l.lessons?.length ?? 0), 0);
    return textPlan([
      "🔄 إعادة تحميل البيانات:",
      `✅ الدروس: ${lessons} درسًا في ${learnLevels.length} مستويين (من البيان الحالي)`,
      "✅ الشهادات: تُقرأ من الشيت مباشرة عند كل طلب",
      "✅ الامتحانات: النمط الحالي يُقرأ من النموذج عند كل تحقق",
      "",
      "أي تعديل في الشيت يصل تلقائيًا مع المزامنة (كل 30 دقيقة) ثم النشر — لا حاجة لإجراء يدوي.",
    ].join("\n"));
  }

  // Dispatch one menu item (bare-number pick or quick-reply payload).
  // Returns a plan, or null when the item is not a parity item.
  async function dispatchMenuItem(senderId, state, list, item) {
    if (!item) return null;
    if (list?.kind === "learn-nav") {
      return textPlan("أرسل «التالي» أو «السابق» للتنقل بين الدروس، أو «رجوع» للرجوع للمستوى.");
    }
    if (list?.kind === "admin-menu") {
      if (item.key === "stats") return adminStatsPlan();
      if (item.key === "users") return adminUsersPlan();
      if (item.key === "bans") return adminBansPlan();
      if (item.key === "broadcast") return textPlan("✏️ للبث أرسل: /broadcast <نص الرسالة> — ثم «نعم» للتأكيد، أو «إلغاء» للتراجع.");
      if (item.key === "reload") return adminReloadPlan();
      return textPlan("⚠️ اختيار غير معروف.");
    }
    if (list?.kind === "admin-cats") {
      if (!isAdmin(senderId)) return emptyPlan();
      return adminCategoryPlan(senderId, state, item.categoryId);
    }
    if (list?.kind === "admin-cmds") {
      if (!isAdmin(senderId)) return emptyPlan();
      const result = await handleAdminCommand(senderId, state, item.command, "");
      if (result) return result;
      if (runUserCommand) {
        const p = await safeCall(runUserCommand, item.command, "", senderId);
        if (p) return p;
      }
      return textPlan("⚠️ هذا الأمر يعمل في المسار الخاص به — لم يتم توصيله بعد.");
    }
    if (list?.kind === "record-choose") {
      if (!isAdmin(senderId)) return emptyPlan();
      if (item.type === "record-pick") return startChosenRecording(senderId, state, item);
      return textPlan("⚠️ اختيار غير معروف.");
    }
    if (list?.kind === "learn-home") return levelMenuPlan(senderId, state, item.levelId);
    if (list?.kind === "level") {
      if (item.type === "lesson") return sendLesson(senderId, state, item.lessonId);
      if (item.type === "getcode") return beginGetCodeFlow(senderId, state);
      if (item.type === "cert") return beginCertFlow(senderId, state, item.level);
      if (item.type === "search") {
        await commit(senderId, state, { ...clearFlows });
        return textPlan("🔍 أرسل الكلمة التي تريد البحث عنها.");
      }
      if (item.type === "back") return levelsPlan(senderId, state);
      if (item.type === "home") {
        await commit(senderId, state, { ...clearFlows });
        return mainMenuPlan(senderId, state);
      }
      return textPlan("⚠️ اختيار غير معروف.");
    }
    if (list?.kind === "menu") {
      if (item.type === "learn") return levelsPlan(senderId, state);
      if (item.type === "search") {
        await commit(senderId, state, { ...clearFlows });
        return textPlan("🔍 أرسل الكلمة التي تريد البحث عنها.");
      }
      if (item.type === "certmenu") return certLevelPickerPlan(senderId, state);
      if (item.type === "getcode") return beginGetCodeFlow(senderId, state);
      if (item.type === "help") return textPlan(parityHelpText());
      if (item.type === "links") return textPlan(LINKS_TEXT);
      if (item.type === "share") return sharePlan();
      if (item.type === "copticname") return beginCopticNameFlow(senderId, state);
      return textPlan("⚠️ اختيار غير معروف.");
    }
    if (list?.kind === "cert-level") return beginCertFlow(senderId, state, item.level);
    return null;
  }

  async function certLevelPickerPlan(senderId, state) {
    const items = [
      { type: "cert", level: "1", label: "المستوى الأول", payload: "cert|level:1" },
      { type: "cert", level: "2", label: "المستوى الثاني", payload: "cert|level:2" },
    ];
    const plan = textPlan("🎓 اختر مستوى الشهادة:\nأرسل رقمًا للاختيار، أو اضغط على المستوى.\n\n1. المستوى الأول\n2. المستوى الثاني");
    plan.menuList = { kind: "cert-level", items };
    await commit(senderId, state, { menuList: plan.menuList });
    return withQuickRepliesOnLast(plan, items);
  }

  async function adminMenuPlan(senderId, state) {
    const items = ADMIN_CATEGORIES.map((cat) => ({ type: "category", categoryId: cat.id, label: cat.title, payload: `admin|cat:${cat.id}` }));
    const plan = textPlan(adminMenuText());
    plan.menuList = { kind: "admin-cats", items };
    await commit(senderId, state, { ...clearFlows, menuList: plan.menuList });
    return withQuickRepliesOnLast(plan, items);
  }

  async function adminCategoryPlan(senderId, state, categoryId) {
    const cat = adminCategory(categoryId);
    if (!cat) return textPlan("⚠️ القسم غير موجود. أرسل /admin لعرض اللوحة.");
    const items = cat.commands.map((name) => ({ type: "command", command: name, label: `/${name}`, payload: `admin|cmd:${name}` }));
    const plan = textPlan(adminCategoryText(categoryId));
    plan.menuList = { kind: "admin-cmds", categoryId, items };
    await commit(senderId, state, { menuList: plan.menuList });
    return withQuickRepliesOnLast(plan, items);
  }

  // -- live monitoring (/livemon, /conversations, /userchat) ------------
  // Telegram parity, adapted to this Worker:
  //
  // - The flag and the log live in the DO (adminStore), read/written on
  //   every message. There is deliberately NO in-isolate cache here:
  //   the recorded-overlay pattern (60 s TTL in src/index.js) would
  //   keep forwarding for up to a minute after the admin turns the
  //   monitor OFF, and a module-scope cache survives only in one
  //   isolate anyway — the DO is the only source of truth shared by
  //   all isolates. One DO get per inbound message is the cost of an
  //   OFF that takes effect on the very next message.
  // - The log is a direct DO write per message, not an in-memory
  //   buffer: Messenger has no poller/alarm to flush a buffer (unlike
  //   Telegram's flushConvLog), and createMessengerParity is built
  //   fresh per webhook request, so a factory-closure buffer would be
  //   lost with the request. Cost: one get + one put per conv key,
  //   plus one get + one put for the recency index, per message.
  // - The wiring (src/index.js planFor.text / planFor.audio) calls
  //   logIncomingMessage for every inbound message and forwards with
  //   a DIRECT sendMessengerMessage — never a plan.task, because the
  //   plan may already carry one (e.g. the name gate's send-dm) and
  //   a second task would collide. A logging/forward failure never
  //   breaks the user's reply: the wiring wraps the hook in try/catch
  //   and these helpers swallow store errors themselves.
  // - Bot replies are never logged: nothing in this module writes to
  //   the conv keys except logIncomingMessage, which the wiring calls
  //   only for inbound user messages. Admin messages are never logged
  //   or forwarded (isAdmin gate, both here and in the wiring).
  // - Every command branch below ALWAYS returns a plan, including the
  //   empty cases — Telegram's /conversations returns NO reply at all
  //   when empty (silence, undiagnosed since 2026-11-08); this module
  //   must never repeat that.

  async function liveMonitorOn() {
    return Boolean(await safeCall(store.get, LIVEMON_KEY));
  }

  // Log one inbound message. Returns true when the sender is a
  // loggable non-admin (i.e. the message was eligible for logging and
  // forwarding), even if a DO write failed — the log is best-effort,
  // the forward decision is separate. `text` is the message text, the
  // caption for media, "" for voice (the label comes from the kind).
  async function logIncomingMessage(senderId, kind, text) {
    if (senderId == null || isAdmin(senderId)) return false;
    const psid = String(senderId);
    const at = new Date().toISOString();
    const entryKind = kind === "voice" || kind === "media" ? kind : "text";
    const entry = {
      at,
      kind: entryKind,
      text: entryKind === "voice" ? "" : String(text ?? "").slice(0, 500),
    };
    try {
      const prev = (await safeCall(store.get, `${CONV_KEY_PREFIX}${psid}`)) ?? [];
      const list = Array.isArray(prev) ? [...prev, entry] : [entry];
      await safeCall(store.put, `${CONV_KEY_PREFIX}${psid}`, list.slice(-CONV_MAX_PER_USER));
      const rawActive = (await safeCall(store.get, CONV_ACTIVE_KEY)) ?? {};
      const index = rawActive && typeof rawActive === "object" && !Array.isArray(rawActive) ? { ...rawActive } : {};
      const prior = index[psid] ?? {};
      // The sender name is NOT looked up here (that would cost a DO
      // get per message): it is resolved lazily by /conversations for
      // the 20 users shown, and by buildLiveForward only when a
      // forward is actually sent. A stored name, when present, is kept.
      index[psid] = { name: prior.name ?? "", at, count: (Number(prior.count) || 0) + 1 };
      await safeCall(store.put, CONV_ACTIVE_KEY, index);
    } catch {
      /* logging never breaks the user's reply */
    }
    return true;
  }

  // Build the live-forward text for one inbound message (name looked
  // up from the `user:msgr:<PSID>` record via getUserRecord, falling
  // back to the bare PSID). Returns null for admins / missing sender.
  async function buildLiveForward(senderId, kind, text) {
    if (senderId == null || isAdmin(senderId)) return null;
    let name = "";
    if (getUserRecord) {
      const found = await safeCall(getUserRecord, String(senderId));
      name = found?.record?.name ?? "";
    }
    return formatLiveForward({ name, psid: String(senderId), at: new Date().toISOString(), kind, text });
  }

  async function liveMonitorCommand(cmd, arg) {
    switch (cmd) {
      case "livemon": {
        const on = !(await liveMonitorOn());
        await safeCall(store.put, LIVEMON_KEY, on);
        return textPlan(on ? LIVEMON_ON_TEXT : LIVEMON_OFF_TEXT);
      }
      case "conversations": {
        const rawActive = (await safeCall(store.get, CONV_ACTIVE_KEY)) ?? {};
        const index = rawActive && typeof rawActive === "object" && !Array.isArray(rawActive) ? rawActive : {};
        const entries = Object.entries(index)
          .map(([id, info]) => ({ id, name: info?.name ?? "", at: info?.at ?? "", count: Number(info?.count) || 0 }))
          .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
          .slice(0, CONV_REPORT_MAX);
        if (!entries.length) return textPlan("📭 لا توجد محادثات محفوظة بعد — تظهر هنا بعد أول رسالة من أي مستخدم.");
        // Resolve display names lazily (best effort, in parallel):
        // the index stores "" for names it never looked up.
        const resolved = await Promise.all(entries.map(async (u) => {
          if (u.name) return u;
          if (!getUserRecord) return u;
          const found = await safeCall(getUserRecord, u.id);
          return { ...u, name: found?.record?.name ?? "" };
        }));
        const lines = [
          "👥 المحادثات الأخيرة (الأحدث أولًا)",
          "",
          ...resolved.map((u) => `• ${u.name || "بدون اسم"} (${u.id}) — ${u.count} رسالة، آخرها ${u.at ? new Date(u.at).toLocaleString("en-GB") : "—"}`),
          "",
          "لعرض محادثة كاملة: /userchat <id>",
        ];
        // Meta caps one text message at 2000 chars; a 20-user report
        // must stay sendable, or the admin gets silence.
        return textPlan(lines.join("\n").slice(0, 1900));
      }
      case "userchat": {
        const id = foldDigits(String(arg ?? "").trim()).split(/\s+/u)[0] ?? "";
        if (!/^\d+$/u.test(id)) return textPlan("✏️ الاستخدام: /userchat <id>\nمثال: /userchat 123456789");
        const raw = (await safeCall(store.get, `${CONV_KEY_PREFIX}${id}`)) ?? [];
        const entries = Array.isArray(raw) ? raw : [];
        if (!entries.length) return textPlan(`📭 لا توجد رسائل محفوظة للمستخدم ${id} بعد.`);
        let name = "";
        if (getUserRecord) {
          const found = await safeCall(getUserRecord, id);
          name = found?.record?.name ?? "";
        }
        const shown = entries.slice(-CONV_USERCHAT_MAX);
        const lines = [`💬 محادثة ${name || "بدون اسم"} (${id}) — آخر ${shown.length} رسالة`, ""];
        for (const e of shown) {
          const time = e?.at ? new Date(e.at).toLocaleTimeString("en-GB") : "";
          const label = e?.kind === "text"
            ? String(e?.text ?? "")
            : `${convKindLabel(e?.kind)}${e?.text ? ` ${String(e.text)}` : ""}`;
          lines.push(`[${time}] ${label}`);
        }
        return textPlan(lines.join("\n").slice(0, 1900));
      }
      default:
        return null;
    }
  }

  // -- full admin command dispatcher -----------------------------------------
  // Dangerous commands (delete / purge / reset data) run two-step: the
  // first call stores pendingConfirm and asks; "نعم" executes, "إلغاء"
  // cancels. The confirm words are the same as the broadcast confirm.

  const DANGEROUS_ADMIN = new Set([
    "userdelete", "purge", "resetuser", "purgeinactive", "resetstats",
    "voice_delete_all", "voice_delete_many", "spamclear",
  ]);

  function notWiredText(what) {
    return textPlan(`⚠️ ${what} غير موصّل بعد على ماسنجر — يحتاج توصيل مصدر البيانات في الربط (انظر مواصفات الربط).`);
  }

  async function safeCall(fn, ...args) {
    try {
      return await fn(...args);
    } catch {
      return null;
    }
  }

  // Generic DO-backed setting: no arg shows the current value, an arg
  // sets it. `format` renders the stored value for display.
  async function settingCommand(key, label, arg, { format = (v) => (v === null || v === undefined || v === "" ? "—" : String(v)), parse = (s) => s } = {}) {
    if (!arg) {
      const current = await safeCall(store.get, key);
      return textPlan(`${label} الحالي: ${format(current)}\nللتعيين: أرسل الأمر متبوعًا بالقيمة.`);
    }
    const value = parse(arg);
    await safeCall(store.put, key, value);
    return textPlan(`✅ تم تعيين ${label}: ${format(value)}`);
  }

  // Generic DO-backed list setting: shows the list, or "add <value>" /
  // "remove <value>" subcommands via the arg.
  async function listSettingCommand(key, label, arg) {
    const raw = await safeCall(store.get, key);
    const list = Array.isArray(raw) ? raw : [];
    const [sub, ...rest] = String(arg ?? "").trim().split(/\s+/u);
    const value = rest.join(" ").trim();
    if (sub === "add" && value) {
      if (!list.includes(value)) list.push(value);
      await safeCall(store.put, key, list);
      return textPlan(`✅ أُضيف «${value}» إلى ${label}.`);
    }
    if ((sub === "remove" || sub === "del") && value) {
      const next = list.filter((x) => x !== value);
      await safeCall(store.put, key, next);
      return textPlan(`✅ حُذف «${value}» من ${label}.`);
    }
    if (!list.length) return textPlan(`${label}: لا يوجد عناصر بعد.\nللإضافة: أرسل الأمر متبوعًا بـ add <القيمة> • للحذف: remove <القيمة>`);
    return textPlan([`${label} (${list.length}):`, ...list.map((x, i) => `${i + 1}. ${x}`), "", "للإضافة: add <القيمة> • للحذف: remove <القيمة>"].join("\n"));
  }

  function statsLines(stats, fields) {
    const s = stats ?? {};
    const lines = [];
    for (const [label, key] of fields) {
      const v = s[key];
      lines.push(`${label}: ${v === null || v === undefined ? "—" : Number(v).toLocaleString("en-US")}`);
    }
    return lines.join("\n");
  }

  async function statsCommand(cmd, arg) {
    // Live monitoring reads the DO conversation log, not the stats
    // snapshot: it answers even when getStats is unwired, and it
    // ALWAYS replies (see liveMonitorCommand).
    if (cmd === "livemon" || cmd === "conversations" || cmd === "userchat") {
      return liveMonitorCommand(cmd, arg);
    }
    const stats = getStats ? await safeCall(getStats) : null;
    if (!stats) return notWiredText("الإحصاءات");
    const head = (title) => `📊 ${title}\n`;
    switch (cmd) {
      case "usage": {
        const usage = getUsage ? await safeCall(getUsage) : stats.usage ?? null;
        if (!usage) return textPlan("📊 استهلاك الطلبات\nلا توجد بيانات بعد.");
        return textPlan([
          "📊 استهلاك الطلبات (Worker)",
          `اليوم: ${Number(usage.today ?? 0).toLocaleString("en-US")}`,
          `الإجمالي: ${Number(usage.total ?? 0).toLocaleString("en-US")}`,
          usage.limit ? `الحد اليومي: ${Number(usage.limit).toLocaleString("en-US")}` : null,
        ].filter(Boolean).join("\n"));
      }
      case "analytics":
        return textPlan(head("التحليلات") + statsLines(stats, [["عمليات البحث", "totalSearches"], ["بحث اليوم", "searchesToday"], ["المستخدمون", "users"], ["المحظورون", "bans"]]));
      case "topusers": {
        const top = Array.isArray(stats.topUsers) ? stats.topUsers : [];
        if (!top.length) return textPlan("👥 أكثر المستخدمين نشاطًا\nلا توجد بيانات بعد.");
        return textPlan(["👥 أكثر المستخدمين نشاطًا:", ...top.slice(0, 10).map((u, i) => `${i + 1}. ${u.id ?? u.name ?? "?"} — ${u.searches ?? u.count ?? 0} بحث`)].join("\n"));
      }
      case "growth":
        return textPlan(head("النمو") + statsLines(stats, [["مستخدمون جدد اليوم", "newUsersToday"], ["مستخدمون جدد هذا الأسبوع", "newUsersWeek"], ["إجمالي المستخدمين", "users"]]));
      case "usercount":
        return textPlan(`👥 عدد المستخدمين: ${Number(stats.users ?? 0).toLocaleString("en-US")}`);
      case "searchstats":
        return textPlan(head("إحصاءات البحث") + statsLines(stats, [["إجمالي عمليات البحث", "totalSearches"], ["بحث اليوم", "searchesToday"], ["عمليات بحث بلا نتائج", "misses"]]));
      case "topwords": {
        const top = Array.isArray(stats.topWords) ? stats.topWords : [];
        if (!top.length) return textPlan("🔝 أكثر الكلمات بحثًا\nلا توجد بيانات بعد.");
        return textPlan(["🔝 أكثر الكلمات بحثًا:", ...top.slice(0, 10).map((w, i) => `${i + 1}. ${w.word ?? w} — ${w.count ?? ""}`.trim())].join("\n"));
      }
      case "misses": {
        const list = Array.isArray(stats.misses) ? stats.misses : [];
        if (!list.length) return textPlan("❓ كلمات بلا نتائج\nلا توجد بيانات بعد.");
        return textPlan(["❓ كلمات بلا نتائج:", ...list.slice(0, 10).map((w, i) => `${i + 1}. ${w.word ?? w}`)].join("\n"));
      }
      case "livewords":
        return textPlan(head("كلمات حية") + statsLines(stats, [["عمليات بحث اليوم", "searchesToday"]]));
      case "hourly": {
        const hours = Array.isArray(stats.hourly) ? stats.hourly : [];
        if (!hours.length) return textPlan("🕐 التوزيع بالساعة\nلا توجد بيانات بعد.");
        return textPlan(["🕐 عمليات البحث بالساعة:", ...hours.slice(0, 24).map((h, i) => `${String(i).padStart(2, "0")}:00 — ${h}`)].join("\n"));
      }
      case "dictstats":
        return textPlan(head("إحصاءات القاموس") + statsLines(stats, [["عدد المفردات", "recordCount"], ["كلمات لها صوت", "voicedWords"], ["كلمات بلا معنى", "emptyMeaning"]]));
      case "wordcount":
        return textPlan(`📖 عدد مفردات القاموس: ${Number(stats.recordCount ?? 0).toLocaleString("en-US")}`);
      case "searchcount":
        return textPlan(`🔎 إجمالي عمليات البحث: ${Number(stats.totalSearches ?? 0).toLocaleString("en-US")}`);
      case "liveusers":
        return textPlan(`👥 المستخدمون النشطون: ${stats.activeUsers ?? stats.users ?? 0}`);
      case "searchhistory": {
        const list = Array.isArray(stats.recentSearches) ? stats.recentSearches : [];
        if (!list.length) return textPlan("🕘 آخر عمليات البحث\nلا توجد بيانات بعد.");
        return textPlan(["🕘 آخر عمليات البحث:", ...list.slice(0, 10).map((q, i) => `${i + 1}. ${q}`)].join("\n"));
      }
      case "reports":
      case "report":
        return textPlan(head("التقارير") + statsLines(stats, [["عمليات البحث", "totalSearches"], ["المستخدمون", "users"], ["المحظورون", "bans"]]));
      case "digest":
        return textPlan(head("الملخص اليومي") + statsLines(stats, [["بحث اليوم", "searchesToday"], ["مستخدمون جدد اليوم", "newUsersToday"]]));
      case "weekly":
        return textPlan(head("الملخص الأسبوعي") + statsLines(stats, [["مستخدمون جدد هذا الأسبوع", "newUsersWeek"], ["إجمالي عمليات البحث", "totalSearches"]]));
      case "statuspage":
        return textPlan(`✅ حالة البوت: ${stats.status ?? "يعمل"}\n📖 المفردات: ${Number(stats.recordCount ?? 0).toLocaleString("en-US")}\n👥 المستخدمون: ${stats.users ?? 0}`);
      case "fieldreport":
        return textPlan(head("تقرير الحقول") + statsLines(stats, [["مفردات بلا معنى", "emptyMeaning"], ["كلمات لها صوت", "voicedWords"], ["عدد المفردات", "recordCount"]]));
      case "adminscore":
        return textPlan(head("نقاط الإدارة") + statsLines(stats, [["عمليات البحث", "totalSearches"], ["المستخدمون", "users"]]));
      case "retention":
        return textPlan(head("الاحتفاظ بالمستخدمين") + statsLines(stats, [["المستخدمون", "users"], ["النشطون", "activeUsers"]]));
      case "ops":
        return textPlan(head("التشغيل") + statsLines(stats, [["عمليات البحث", "totalSearches"], ["بحث اليوم", "searchesToday"], ["المستخدمون", "users"]]));
      case "funnel":
        return textPlan(head("مسار التحويل") + statsLines(stats, [["المستخدمون", "users"], ["النشطون", "activeUsers"]]));
      case "cohorts":
        return textPlan(head("المجموعات") + statsLines(stats, [["المستخدمون", "users"], ["مستخدمون جدد اليوم", "newUsersToday"]]));
      case "reflinks":
        return textPlan("🔗 روابط الإحالة\nلا توجد بيانات بعد — تُقرأ من مصدر الإحالات عند توصيله.");
      default:
        return null;
    }
  }

  async function usersCommand(senderId, cmd, arg) {
    switch (cmd) {
      case "users":
        return adminUsersPlan();
      case "bans":
      case "banlist":
      case "blockedusers":
        return adminBansPlan();
      case "ban":
        return adminBanPlan(senderId, arg);
      case "unban":
        return adminUnbanPlan(arg);
      case "tempban": {
        const parsed = parseBanArgs(arg);
        if (!parsed.psid) return textPlan("✏️ الاستخدام: /tempban <رقم> <المدة مثل 24h> [السبب]");
        return adminBanPlan(senderId, `${parsed.psid} ${parsed.hours ?? 24}h ${parsed.reason}`.trim());
      }
      case "userlookup":
      case "userfind": {
        if (!arg) return textPlan("✏️ الاستخدام: /userlookup <اسم أو رقم أو معرف>");
        if (!listUserPage) return notWiredText("البحث في المستخدمين");
        const page = await safeCall(listUserPage, { limit: 20, query: arg });
        if (!page) return textPlan("❌ تعذّر البحث في المستخدمين حاليًا.");
        return textPlan(formatUsersList(page.users ?? [], page.total ?? (page.users ?? []).length));
      }
      case "userinfo": {
        const psid = normalizeTargetPsid(arg);
        if (!psid) return textPlan("✏️ الاستخدام: /userinfo <رقم المستخدم>");
        if (!getUserRecord) return notWiredText("معلومات المستخدم");
        const info = await safeCall(getUserRecord, psid);
        if (!info) return textPlan("❌ المستخدم غير موجود أو تعذّرت قراءته.");
        const r = info.record ?? {};
        const history = Array.isArray(info.history) ? info.history : [];
        return textPlan([
          `👤 معلومات المستخدم ${psid}`,
          `الاسم: ${r.name ?? r.tgName ?? "—"}`,
          `محظور: ${r.blocked ? "🚫 نعم" : "لا"}`,
          `تحذيرات: ${Array.isArray(r.warns) ? r.warns.length : 0}`,
          `نقاط: ${r.points ?? 0}`,
          `آخر عمليات البحث (${history.length}):`,
          ...history.slice(0, 10).map((h) => `• ${String(h.q ?? h).slice(0, 50)}`),
        ].join("\n"));
      }
      case "userhistory": {
        const psid = normalizeTargetPsid(arg);
        if (!psid) return textPlan("✏️ الاستخدام: /userhistory <رقم المستخدم>");
        if (!getUserRecord) return notWiredText("سجل المستخدم");
        const info = await safeCall(getUserRecord, psid);
        const history = Array.isArray(info?.history) ? info.history : [];
        if (!history.length) return textPlan("لا توجد عمليات بحث محفوظة لهذا المستخدم.");
        return textPlan([`🕘 سجل ${psid}:`, ...history.slice(0, 20).map((h, i) => `${i + 1}. ${String(h.q ?? h).slice(0, 60)}`)].join("\n"));
      }
      case "warn": {
        const [target, ...reasonParts] = String(arg ?? "").trim().split(/\s+/u);
        const psid = normalizeTargetPsid(target);
        if (!psid) return textPlan("✏️ الاستخدام: /warn <رقم> [السبب]");
        if (!getUserRecord || !updateUserRecord) return notWiredText("التحذيرات");
        const info = await safeCall(getUserRecord, psid);
        const warns = [...(Array.isArray(info?.record?.warns) ? info.record.warns : []), { at: new Date().toISOString(), reason: reasonParts.join(" ").slice(0, 120) }];
        await safeCall(updateUserRecord, psid, { warns });
        return textPlan(`⚠️ تم تحذير ${psid} (التحذير رقم ${warns.length}).`);
      }
      case "warns": {
        const psid = normalizeTargetPsid(arg);
        if (!psid) return textPlan("✏️ الاستخدام: /warns <رقم>");
        if (!getUserRecord) return notWiredText("التحذيرات");
        const info = await safeCall(getUserRecord, psid);
        const warns = Array.isArray(info?.record?.warns) ? info.record.warns : [];
        if (!warns.length) return textPlan(`لا توجد تحذيرات على ${psid}.`);
        return textPlan([`⚠️ تحذيرات ${psid} (${warns.length}):`, ...warns.map((w, i) => `${i + 1}. ${w.reason ?? ""} — ${fmtDate(w.at)}`)].join("\n"));
      }
      case "resetwarns": {
        const psid = normalizeTargetPsid(arg);
        if (!psid) return textPlan("✏️ الاستخدام: /resetwarns <رقم>");
        if (!updateUserRecord) return notWiredText("التحذيرات");
        await safeCall(updateUserRecord, psid, { warns: [] });
        return textPlan(`✅ تم تصفير تحذيرات ${psid}.`);
      }
      case "setpoints": {
        const [target, value] = String(arg ?? "").trim().split(/\s+/u);
        const psid = normalizeTargetPsid(target);
        if (!psid || value === undefined || !/^-?\d+$/u.test(value)) return textPlan("✏️ الاستخدام: /setpoints <رقم> <عدد النقاط>");
        if (!updateUserRecord) return notWiredText("النقاط");
        await safeCall(updateUserRecord, psid, { points: Number(value) });
        return textPlan(`✅ تم تعيين نقاط ${psid} إلى ${value}.`);
      }
      case "addpoints": {
        const [target, value] = String(arg ?? "").trim().split(/\s+/u);
        const psid = normalizeTargetPsid(target);
        if (!psid || value === undefined || !/^-?\d+$/u.test(value)) return textPlan("✏️ الاستخدام: /addpoints <رقم> <عدد النقاط>");
        if (!getUserRecord || !updateUserRecord) return notWiredText("النقاط");
        const info = await safeCall(getUserRecord, psid);
        const total = (Number(info?.record?.points ?? 0) + Number(value));
        await safeCall(updateUserRecord, psid, { points: total });
        return textPlan(`✅ أُضيفت ${value} نقطة إلى ${psid} — الإجمالي ${total}.`);
      }
      case "points": {
        const psid = normalizeTargetPsid(arg);
        if (!psid) return textPlan("✏️ الاستخدام: /points <رقم>");
        if (!getUserRecord) return notWiredText("النقاط");
        const info = await safeCall(getUserRecord, psid);
        return textPlan(`⭐ نقاط ${psid}: ${Number(info?.record?.points ?? 0)}`);
      }
      case "leaderboard": {
        if (!listUserPage) return notWiredText("لوحة المتصدرين");
        const page = await safeCall(listUserPage, { limit: 100 });
        const users = (page?.users ?? []).filter((u) => Number(u.record?.points ?? u.points ?? 0) > 0)
          .sort((a, b) => Number(b.record?.points ?? b.points ?? 0) - Number(a.record?.points ?? a.points ?? 0))
          .slice(0, 10);
        if (!users.length) return textPlan("🏆 لوحة المتصدرين\nلا توجد نقاط بعد.");
        return textPlan(["🏆 لوحة المتصدرين:", ...users.map((u, i) => `${i + 1}. ${u.id} — ${Number(u.record?.points ?? u.points ?? 0)} نقطة`)].join("\n"));
      }
      case "usernote": {
        const [target, ...noteParts] = String(arg ?? "").trim().split(/\s+/u);
        const psid = normalizeTargetPsid(target);
        const note = noteParts.join(" ").slice(0, 500);
        if (!psid || !note) return textPlan("✏️ الاستخدام: /usernote <رقم> <الملاحظة>");
        if (!getUserRecord || !updateUserRecord) return notWiredText("ملاحظات المستخدم");
        const info = await safeCall(getUserRecord, psid);
        const notes = [...(Array.isArray(info?.record?.notes) ? info.record.notes : []), { at: new Date().toISOString(), text: note }];
        await safeCall(updateUserRecord, psid, { notes });
        return textPlan(`✅ تم حفظ الملاحظة على ${psid}.`);
      }
      case "usernotes": {
        const psid = normalizeTargetPsid(arg);
        if (!psid) return textPlan("✏️ الاستخدام: /usernotes <رقم>");
        if (!getUserRecord) return notWiredText("ملاحظات المستخدم");
        const info = await safeCall(getUserRecord, psid);
        const notes = Array.isArray(info?.record?.notes) ? info.record.notes : [];
        if (!notes.length) return textPlan(`لا توجد ملاحظات على ${psid}.`);
        return textPlan([`📝 ملاحظات ${psid}:`, ...notes.map((n, i) => `${i + 1}. ${n.text ?? ""} — ${fmtDate(n.at)}`)].join("\n"));
      }
      case "userdelete":
      case "resetuser":
      case "purge": {
        const psid = normalizeTargetPsid(arg);
        if (!psid) return textPlan(`✏️ الاستخدام: /${cmd} <رقم المستخدم>`);
        // Dangerous: executed only after the pendingConfirm "نعم".
        return { __confirm: { command: cmd, arg: psid, label: `حذف بيانات المستخدم ${psid} نهائيًا` } };
      }
      case "inactive": {
        if (!listUserPage) return notWiredText("المستخدمون الخاملون");
        const page = await safeCall(listUserPage, { limit: 100 });
        const users = (page?.users ?? []).filter((u) => !u.record?.lastSeen && !u.lastSeen).slice(0, 20);
        if (!users.length) return textPlan("👥 المستخدمون الخاملون\nلا توجد بيانات كافية لتحديد الخاملين.");
        return textPlan(["👥 مستخدمون بلا نشاط مسجل:", ...users.map((u, i) => `${i + 1}. ${u.id}`)].join("\n"));
      }
      case "purgeinactive":
        return { __confirm: { command: cmd, arg: "", label: "حذف المستخدمين الخاملين نهائيًا" } };
      default:
        return null;
    }
  }

  async function broadcastCommand(senderId, state, cmd, arg) {
    switch (cmd) {
      case "broadcast":
      case "announce":
      case "massdm":
        return adminBroadcastPlan(senderId, state, arg);
      case "startbroadcast":
        return textPlan("📢 أرسل الآن نص رسالة البث — ثم «نعم» للتأكيد، أو «إلغاء» للتراجع.\n(أو استخدم /broadcast <نص الرسالة> مباشرة.)");
      case "stopbroadcast":
      case "bccancel": {
        await commit(senderId, state, { pendingBroadcast: undefined });
        if (setBroadcastControl) await safeCall(setBroadcastControl, { paused: true });
        return textPlan("⏹ تم إيقاف البث ✅");
      }
      case "bcpause":
        if (!setBroadcastControl) return notWiredText("التحكم في البث");
        await safeCall(setBroadcastControl, { paused: true });
        return textPlan("⏸ تم إيقاف البث مؤقتًا. للاستئناف: /bcresume");
      case "bcresume":
        if (!setBroadcastControl) return notWiredText("التحكم في البث");
        await safeCall(setBroadcastControl, { paused: false });
        return textPlan("▶️ تم استئناف البث.");
      case "bcspeed": {
        if (!arg) {
          const ctrl = getBroadcastControl ? await safeCall(getBroadcastControl) : null;
          return textPlan(`🐢 سرعة البث الحالية: ${ctrl?.speed ?? ctrl?.delayMs ?? "—"}\nللتعيين: /bcspeed <رسالة كل كم ثانية>`);
        }
        if (!setBroadcastControl) return notWiredText("التحكم في البث");
        await safeCall(setBroadcastControl, { speed: arg });
        return textPlan(`✅ تم تعيين سرعة البث: ${arg}`);
      }
      case "testbroadcast": {
        if (!listRecipients) return notWiredText("البث التجريبي");
        return { ...textPlan("📢 تم إرسال رسالة البث التجريبية إليك."), task: { type: "test-broadcast", text: arg || "رسالة تجريبية من البث.", from: String(senderId) } };
      }
      case "broadcaststats": {
        const stats = getBroadcastStats ? await safeCall(getBroadcastStats) : null;
        if (!stats) return textPlan("📢 إحصاءات البث\nلا توجد بيانات بعد.");
        return textPlan(["📢 إحصاءات البث", `أُرسلت: ${stats.sent ?? 0}`, `الإجمالي: ${stats.total ?? 0}`, stats.running ? "الحالة: جارٍ الآن" : "الحالة: متوقف"].join("\n"));
      }
      case "schedule":
        return scheduleBroadcastPlan(senderId, state, arg);
      case "schedules":
        return sendScheduledList(senderId);
      case "unschedule":
        return cancelScheduled(senderId, arg);
      case "targeted": {
        const [target, ...textParts] = String(arg ?? "").trim().split(/\s+/u);
        const psid = normalizeTargetPsid(target);
        const text = textParts.join(" ").trim();
        if (!psid || !text) return textPlan("✏️ الاستخدام: /targeted <رقم المستخدم> <نص الرسالة>");
        return { ...textPlan(`📩 سيتم إرسال الرسالة إلى ${psid}.`), task: { type: "send-dm", to: psid, text, from: String(senderId) } };
      }
      case "msg": {
        const [target, ...textParts] = String(arg ?? "").trim().split(/\s+/u);
        const psid = normalizeTargetPsid(target);
        const text = textParts.join(" ").trim();
        if (!psid || !text) return textPlan("✏️ الاستخدام: /msg <رقم المستخدم> <نص الرسالة>");
        return { ...textPlan(`📩 سيتم إرسال الرسالة إلى ${psid}.`), task: { type: "send-dm", to: psid, text, from: String(senderId) } };
      }
      case "templateslib": {
        const templates = await safeCall(store.get, "templates:list");
        const list = templates && typeof templates === "object" ? Object.entries(templates) : [];
        if (!list.length) return textPlan("🧷 مكتبة القوالب\nلا توجد قوالب محفوظة بعد.\nللحفظ: /tplsave <الاسم> <نص الرسالة>");
        return textPlan(["🧷 مكتبة القوالب:", ...list.map(([name, t], i) => `${i + 1}. ${name} — ${String(t?.text ?? t ?? "").slice(0, 60)}`), "", "للإرسال: /tplsend <الاسم>"].join("\n"));
      }
      case "tplsave": {
        const [name, ...textParts] = String(arg ?? "").trim().split(/\s+/u);
        const text = textParts.join(" ").trim();
        if (!name || !text) return textPlan("✏️ الاستخدام: /tplsave <الاسم> <نص الرسالة>");
        const templates = (await safeCall(store.get, "templates:list")) ?? {};
        templates[name] = { text, at: new Date().toISOString() };
        await safeCall(store.put, "templates:list", templates);
        return textPlan(`✅ تم حفظ القالب «${name}».`);
      }
      case "tplsend": {
        const name = String(arg ?? "").trim();
        if (!name) return textPlan("✏️ الاستخدام: /tplsend <الاسم>");
        const templates = (await safeCall(store.get, "templates:list")) ?? {};
        const tpl = templates[name];
        if (!tpl) return textPlan(`⚠️ القالب «${name}» غير موجود. اعرض القوالب بـ /templateslib`);
        return adminBroadcastPlan(senderId, state, String(tpl.text ?? ""));
      }
      case "maintadv": {
        if (!arg) return textPlan("✏️ الاستخدام: /maintadv <نص إعلان الصيانة> — ثم «نعم» للتأكيد.");
        await safeCall(store.put, "maintadv:pending", arg);
        await commit(senderId, state, { pendingBroadcast: arg });
        const plan = textPlan(broadcastConfirmText(arg, "كل المستخدمين"));
        return withQuickRepliesOnLast(plan, [
          { title: "نعم", payload: "admin|confirm-broadcast" },
          { title: "إلغاء", payload: "admin|cancel-broadcast" },
        ]);
      }
      case "maintadvstatus": {
        const pending = await safeCall(store.get, "maintadv:pending");
        return textPlan(pending ? `📢 إعلان صيانة معلّق:\n${String(pending).slice(0, 500)}` : "لا يوجد إعلان صيانة معلّق.");
      }
      case "maintadvcancel": {
        await safeCall(store.del, "maintadv:pending");
        await commit(senderId, state, { pendingBroadcast: undefined });
        return textPlan("✅ تم إلغاء إعلان الصيانة.");
      }
      case "optout": {
        const list = (await safeCall(store.get, "broadcast:optout")) ?? [];
        const arr = Array.isArray(list) ? list : [];
        if (!arr.length) return textPlan("🔕 لا يوجد مستخدمون ألغوا استلام البث.");
        return textPlan([`🔕 ألغوا استلام البث (${arr.length}):`, ...arr.slice(0, 30).map((id, i) => `${i + 1}. ${id}`)].join("\n"));
      }
      case "optoutstats": {
        const list = (await safeCall(store.get, "broadcast:optout")) ?? [];
        const arr = Array.isArray(list) ? list : [];
        return textPlan(`🔕 ألغوا استلام البث: ${arr.length} مستخدم.`);
      }
      case "addevent": {
        const [name, ...rest] = String(arg ?? "").trim().split(/\s+/u);
        const detail = rest.join(" ").trim();
        if (!name) return textPlan("✏️ الاستخدام: /addevent <الاسم> [التفاصيل]");
        const events = (await safeCall(store.get, "events:list")) ?? {};
        events[name] = { detail, at: new Date().toISOString() };
        await safeCall(store.put, "events:list", events);
        return textPlan(`✅ تمت إضافة الحدث «${name}».`);
      }
      case "events": {
        const events = (await safeCall(store.get, "events:list")) ?? {};
        const list = Object.entries(events);
        if (!list.length) return textPlan("📅 لا توجد أحداث مسجلة.");
        return textPlan(["📅 الأحداث:", ...list.map(([name, e], i) => `${i + 1}. ${name} — ${String(e?.detail ?? "").slice(0, 80)}`)].join("\n"));
      }
      case "delevent": {
        const name = String(arg ?? "").trim();
        if (!name) return textPlan("✏️ الاستخدام: /delevent <الاسم>");
        const events = (await safeCall(store.get, "events:list")) ?? {};
        if (!events[name]) return textPlan(`⚠️ الحدث «${name}» غير موجود.`);
        delete events[name];
        await safeCall(store.put, "events:list", events);
        return textPlan(`✅ تم حذف الحدث «${name}».`);
      }
      default:
        return null;
    }
  }

  async function systemCommand(senderId, state, cmd, arg) {
    switch (cmd) {
      case "health":
      case "healthcheck": {
        const stats = getStats ? await safeCall(getStats) : null;
        return textPlan([
          "✅ حالة البوت: يعمل",
          `📖 المفردات: ${Number(stats?.recordCount ?? 0).toLocaleString("en-US")}`,
          `👥 المستخدمون: ${stats?.users ?? 0}`,
          `☁️ التخزين: ${stats?.usersStore === false ? "غير مفعّل" : "مفعّل"}`,
        ].join("\n"));
      }
      case "uptime":
        return textPlan("⏰ مدة التشغيل: تُقاس من بدء العزل الحالي — لا توجد قيمة دائمة في Worker.");
      case "botinfo":
        return textPlan([
          "🤖 معلومات البوت",
          "القاموس القبطي — بوت ماسنجر (نفس منطق بوت تيليجرام)",
          `الدروس: ${learnLevels.reduce((n, l) => n + (l.lessons?.length ?? 0), 0)} درسًا في ${learnLevels.length} مستويين`,
          `تطبيق التعلم: ${learnAppUrl}`,
        ].join("\n"));
      case "ping":
        return textPlan("🏓 pong — البوت يعمل.");
      case "debug": {
        const stats = getStats ? await safeCall(getStats) : null;
        return textPlan([
          "🐞 تشخيص",
          `المفردات: ${Number(stats?.recordCount ?? 0)}`,
          `المستخدمون: ${stats?.users ?? 0}`,
          `البيانات: ${learnLevels.length} مستويين`,
        ].join("\n"));
      }
      case "clearcache": {
        if (runTask) {
          const p = await safeCall(runTask, { type: "clear-cache", from: String(senderId) });
          if (p) return p;
        }
        return textPlan("✅ تم مسح الذاكرة المؤقتة المحلية (إعدادات الشهادات وأنماط الامتحانات تُقرأ من جديد عند الطلب التالي).");
      }
      case "cacheinfo":
        return textPlan("💾 الذاكرة المؤقتة: إعدادات الشهادات (60 ثانية) • أنماط الامتحانات (5 دقائق لكل نموذج) • سجلات المستخدمين (5 ثوانٍ لكل تحديث).");
      case "limits":
        return textPlan("📏 الحدود: الرد السريع 13 زرًا بحد أقصى 20 حرفًا للعنوان • نص الرسالة حتى 2000 حرف • البث حتى 4000 حرف • الشهادة حتى 10MB.");
      case "slowmode": {
        if (!arg) {
          const cfg = await safeCall(store.get, "admin:slowmode");
          return textPlan(`🐢 الوضع البطيء: ${cfg ? JSON.stringify(cfg) : "متوقف"}\nللتعيين: /slowmode <ثوانٍ بين الرسائل> أو /slowmode off`);
        }
        if (arg === "off") {
          await safeCall(store.put, "admin:slowmode", null);
          return textPlan("✅ تم إيقاف الوضع البطيء.");
        }
        const seconds = Number(arg);
        if (!Number.isFinite(seconds) || seconds < 0) return textPlan("✏️ الاستخدام: /slowmode <ثوانٍ> أو /slowmode off");
        await safeCall(store.put, "admin:slowmode", { seconds });
        return textPlan(`✅ تم تعيين الوضع البطيء: ${seconds} ثانية بين الرسائل.`);
      }
      case "maintenance": {
        if (!arg) {
          const on = await safeCall(store.get, "admin:maintenance");
          return textPlan(`🔧 وضع الصيانة: ${on ? "مفعّل" : "متوقف"}\nللتبديل: /maintenance on أو /maintenance off`);
        }
        const on = arg.toLowerCase() === "on";
        await safeCall(store.put, "admin:maintenance", on);
        return textPlan(`✅ وضع الصيانة: ${on ? "مفعّل" : "متوقف"}.`);
      }
      case "setmaintmsg":
        return settingCommand("admin:maintmsg", "رسالة الصيانة", arg);
      case "setbanmsg":
        return settingCommand("admin:banmsg", "رسالة الحظر", arg);
      case "feature": {
        const [name, value] = String(arg ?? "").trim().split(/\s+/u);
        if (!name) {
          const flags = (await safeCall(store.get, "admin:features")) ?? {};
          const entries = Object.entries(flags);
          if (!entries.length) return textPlan("🚩 لا توجد أعلام ميزات مضبوطة.\nللتعيين: /feature <الاسم> on|off");
          return textPlan(["🚩 أعلام الميزات:", ...entries.map(([k, v]) => `• ${k}: ${v ? "on" : "off"}`)].join("\n"));
        }
        const flags = (await safeCall(store.get, "admin:features")) ?? {};
        flags[name] = value !== "off" && value !== "false" && value !== "0";
        await safeCall(store.put, "admin:features", flags);
        return textPlan(`✅ الميزة ${name}: ${flags[name] ? "on" : "off"}`);
      }
      case "errors": {
        if (!listErrors) return notWiredText("سجل الأخطاء");
        const errors = await safeCall(listErrors);
        if (!errors?.length) return textPlan("✅ لا توجد أخطاء مسجلة.");
        return textPlan(["❌ آخر الأخطاء:", ...errors.slice(0, 10).map((e, i) => `${i + 1}. ${fmtDate(e.at)} [${e.where ?? "?"}] ${String(e.message ?? "").slice(0, 100)}`)].join("\n"));
      }
      case "auditlog":
      case "adminaudit": {
        if (!listAuditLog) return notWiredText("سجل التدقيق");
        const entries = await safeCall(listAuditLog);
        if (!entries?.length) return textPlan("📋 سجل التدقيق فارغ.");
        return textPlan(["📋 آخر إجراءات الأدمن:", ...entries.slice(0, 10).map((e, i) => `${i + 1}. ${fmtDate(e.at)} — ${e.action ?? ""} ${String(e.detail ?? "").slice(0, 80)}`)].join("\n"));
      }
      case "securitylog": {
        if (!listSecurityLog) return notWiredText("سجل الأمان");
        const entries = await safeCall(listSecurityLog);
        if (!entries?.length) return textPlan("🔐 سجل الأمان فارغ.");
        return textPlan(["🔐 آخر أحداث الأمان:", ...entries.slice(0, 10).map((e, i) => `${i + 1}. ${fmtDate(e.at)} — ${e.event ?? ""} ${String(e.detail ?? "").slice(0, 80)}`)].join("\n"));
      }
      case "setlang":
        return settingCommand("admin:lang", "اللغة الافتراضية", arg, { parse: (s) => (s === "en" ? "en" : "ar") });
      case "setwod":
        return settingCommand("admin:wod", "كلمة اليوم اليدوية", arg);
      case "setwodtest":
        return textPlan("🔔 تم إرسال كلمة اليوم التجريبية إليك.");
      case "note":
        return settingCommand("admin:note", "ملاحظة الأدمن", arg);
      case "alias": {
        const [from, ...toParts] = String(arg ?? "").trim().split(/\s+/u);
        const to = toParts.join(" ").trim();
        if (!from) {
          const aliases = (await safeCall(store.get, "admin:aliases")) ?? {};
          const entries = Object.entries(aliases);
          if (!entries.length) return textPlan("🔤 لا توجد اختصارات.\nللتعيين: /alias <الاختصار> <الأمر>");
          return textPlan(["🔤 الاختصارات:", ...entries.map(([k, v]) => `• ${k} → ${v}`)].join("\n"));
        }
        const aliases = (await safeCall(store.get, "admin:aliases")) ?? {};
        if (!to) {
          delete aliases[from];
          await safeCall(store.put, "admin:aliases", aliases);
          return textPlan(`✅ حُذف الاختصار «${from}».`);
        }
        aliases[from] = to;
        await safeCall(store.put, "admin:aliases", aliases);
        return textPlan(`✅ الاختصار «${from}» → «${to}».`);
      }
      case "motd":
        return settingCommand("motd:text", "رسالة اليوم", arg);
      case "rules":
        return settingCommand("admin:rules", "قواعد البوت", arg);
      case "searchlimit": {
        if (!arg) {
          const v = await safeCall(store.get, "admin:searchlimit");
          return textPlan(`🔎 حد البحث الحالي: ${v ?? "—"}\nللتعيين: /searchlimit <عدد>`);
        }
        const n = Number(arg);
        if (!Number.isFinite(n) || n < 1) return textPlan("✏️ الاستخدام: /searchlimit <عدد صحيح>");
        await safeCall(store.put, "admin:searchlimit", n);
        return textPlan(`✅ تم تعيين حد البحث: ${n}`);
      }
      case "usagealert": {
        if (!arg) {
          const v = await safeCall(store.get, "admin:usagealert");
          return textPlan(`🔔 تنبيه الاستهلاك الحالي: ${v ?? "—"}\nللتعيين: /usagealert <عدد الطلبات>`);
        }
        const n = Number(arg);
        if (!Number.isFinite(n) || n < 1) return textPlan("✏️ الاستخدام: /usagealert <عدد صحيح>");
        await safeCall(store.put, "admin:usagealert", n);
        return textPlan(`✅ تم تعيين تنبيه الاستهلاك عند: ${n} طلب.`);
      }
      case "recover":
        return textPlan("🔄 الاسترداد: بيانات المستخدمين والدروس تُقرأ من التخزين الدائم (DO) والبيان الحالي — لا توجد نسخة محلية تستحق الاسترداد.");
      case "recoverusers": {
        if (runTask) {
          const p = await safeCall(runTask, { type: "recover-users", from: String(senderId) });
          if (p) return p;
        }
        return textPlan("🔄 استرداد المستخدمين: يبدأ من الربط (مزامنة المستخدمين من الشيت) — أرسل /syncusers.");
      }
      case "apikey": {
        if (!arg) return textPlan("🔑 مفاتيح API تُدار من لوحة تحكم Worker — لا تُعرض هنا.\nللإنشاء: أرسل /apikey create <الاسم>");
        return textPlan("🔑 مفاتيح API تُدار من لوحة تحكم Worker — استخدمها هناك.");
      }
      case "whereami":
        return textPlan(`📍 أنت هنا: بوت ماسنجر (وركر مستقل)\n${WORKER_BASE_URL}\nالصفحة: القاموس القبطي`);
      case "snapshot": {
        const stats = getStats ? await safeCall(getStats) : null;
        return textPlan([
          "📸 لقطة الحالة الآن:",
          `المفردات: ${Number(stats?.recordCount ?? 0).toLocaleString("en-US")}`,
          `المستخدمون: ${stats?.users ?? 0}`,
          `بحث اليوم: ${stats?.searchesToday ?? 0}`,
          `الدروس: ${learnLevels.reduce((n, l) => n + (l.lessons?.length ?? 0), 0)}`,
        ].join("\n"));
      }
      case "preview":
        return textPlan(`👁 معاينة: ${parityWelcomeText().split("\n")[0]}`);
      default:
        return null;
    }
  }

  async function driveCommand(cmd, arg) {
    switch (cmd) {
      case "drive": {
        if (!getDriveConfig) return notWiredText("حالة Drive");
        const cfg = await safeCall(getDriveConfig);
        return textPlan(cfg?.configured ? "☁️ Drive: مهيأ ومتصل." : "☁️ Drive: غير مهيأ — أرسل /setdrive <رابط Apps Script>");
      }
      case "setdrive": {
        const url = String(arg ?? "").trim();
        if (!url || !/^https?:\/\/\S+$/u.test(url)) return textPlan("✏️ الاستخدام: /setdrive <رابط Apps Script>");
        if (!setMacroUrl) return notWiredText("تعيين رابط Drive");
        const ok = await safeCall(setMacroUrl, url);
        return textPlan(ok ? "✅ تم تعيين رابط Apps Script." : "❌ تعذّر تعيين الرابط حاليًا.");
      }
      case "setarchive": {
        const url = String(arg ?? "").trim();
        if (!url || !/^https?:\/\/\S+$/u.test(url)) return textPlan("✏️ الاستخدام: /setarchive <رابط الأرشيف>");
        await safeCall(store.put, "drive:archive", url);
        return textPlan("✅ تم تعيين رابط الأرشيف.");
      }
      case "syncstatus": {
        const job = await safeCall(store.get, "sync:job");
        return textPlan(job ? `🔄 حالة المزامنة: ${JSON.stringify(job).slice(0, 300)}` : "🔄 لا توجد مهمة مزامنة جارية.");
      }
      case "synccancel":
        await safeCall(store.del, "sync:job");
        return textPlan("✅ تم إلغاء مهمة المزامنة.");
      case "syncreset":
        await safeCall(store.del, "sync:job");
        await safeCall(store.del, "sync:cursor");
        return textPlan("✅ تمت إعادة تعيين المزامنة.");
      case "synctest":
        return textPlan("🔄 اختبار المزامنة: أرسل /syncstatus لعرض الحالة، أو /syncusers لبدء مزامنة المستخدمين.");
      case "syncdrive":
      case "syncusers":
      case "syncall":
      case "importusers":
      case "importsheet":
      case "importlearn":
      case "resync": {
        if (runTask) {
          const p = await safeCall(runTask, { type: cmd, from: "admin" });
          if (p) return p;
        }
        return { ...textPlan(`⏳ بدأت مهمة /${cmd} — ستصلك النتيجة عند اكتمالها.`), task: { type: cmd, from: "admin" } };
      }
      default:
        return null;
    }
  }

  async function dictAdminCommand(cmd, arg) {
    switch (cmd) {
      case "dicthealth": {
        const audit = getDictAudit ? await safeCall(getDictAudit) : null;
        const stats = getStats ? await safeCall(getStats) : null;
        return textPlan([
          "📖 صحة القاموس",
          `المفردات: ${Number(stats?.recordCount ?? audit?.recordCount ?? 0).toLocaleString("en-US")}`,
          `مفردات بلا معنى: ${audit?.emptyMeaning ?? stats?.emptyMeaning ?? "—"}`,
          `تكرارات: ${audit?.duplicates ?? "—"}`,
        ].join("\n"));
      }
      case "duplicates":
      case "dups": {
        if (!getDictAudit) return notWiredText("فحص التكرارات");
        const audit = await safeCall(getDictAudit);
        const list = Array.isArray(audit?.duplicateWords) ? audit.duplicateWords : [];
        if (!list.length) return textPlan("✅ لا توجد كلمات مكررة.");
        return textPlan(["📖 كلمات مكررة:", ...list.slice(0, 20).map((w, i) => `${i + 1}. ${w}`)].join("\n"));
      }
      case "findempty":
      case "emptymeaning": {
        if (!getDictAudit) return notWiredText("فحص المعاني الفارغة");
        const audit = await safeCall(getDictAudit);
        const list = Array.isArray(audit?.emptyWords) ? audit.emptyWords : [];
        if (!list.length) return textPlan("✅ لا توجد مفردات بلا معنى.");
        return textPlan(["📖 مفردات بلا معنى:", ...list.slice(0, 20).map((w, i) => `${i + 1}. ${w}`)].join("\n"));
      }
      case "gapfill":
      case "wordaudit":
      case "integrity": {
        if (!getDictAudit) return notWiredText("تدقيق القاموس");
        const audit = await safeCall(getDictAudit);
        return textPlan([
          "📖 تدقيق القاموس",
          `المفردات: ${audit?.recordCount ?? "—"}`,
          `بلا معنى: ${audit?.emptyMeaning ?? "—"}`,
          `مكررة: ${audit?.duplicates ?? "—"}`,
          audit?.ok === false ? "⚠️ توجد مشاكل — راجع التفاصيل أعلاه." : "✅ لا توجد مشاكل جوهرية.",
        ].join("\n"));
      }
      case "dictversion": {
        const stats = getStats ? await safeCall(getStats) : null;
        return textPlan(`📖 نسخة القاموس: ${stats?.dictVersion ?? "الحالية (من البيان المدمج)"}\nالمفردات: ${Number(stats?.recordCount ?? 0).toLocaleString("en-US")}`);
      }
      case "sheetdiff": {
        if (!getDictAudit) return notWiredText("مقارنة الشيت");
        const audit = await safeCall(getDictAudit);
        return textPlan(`📖 الفرق مع الشيت: ${audit?.sheetDiff ?? "لا توجد فروقات مسجلة."}`);
      }
      case "deleteword":
      case "bulkadd":
      case "bulkedit": {
        if (!editDictionary) return notWiredText("تعديل القاموس");
        const result = await safeCall(editDictionary, { op: cmd, arg });
        if (!result?.ok) return textPlan(`❌ تعذّر تنفيذ /${cmd}: ${result?.detail ?? "تحقق من الصيغة."}`);
        return textPlan(`✅ تم تنفيذ /${cmd}: ${result.detail ?? ""}`);
      }
      default:
        return null;
    }
  }

  async function supportCommand(senderId, cmd, arg) {
    switch (cmd) {
      case "support":
        return textPlan("💬 الدعم: اكتب مشكلتك هنا وسيرد عليك الأدمن.\n(أو استخدم /ticket <الموضوع> لفتح تذكرة.)");
      case "tickets": {
        if (!listTickets) return notWiredText("التذاكر");
        const tickets = await safeCall(listTickets);
        if (!tickets?.length) return textPlan("🎫 لا توجد تذاكر مفتوحة.");
        return textPlan(["🎫 التذاكر:", ...tickets.slice(0, 20).map((t, i) => `${i + 1}. #${t.id} — ${String(t.subject ?? "").slice(0, 50)} (${t.status ?? "مفتوحة"})`)].join("\n"));
      }
      case "ticket": {
        const id = String(arg ?? "").trim();
        if (!id) return textPlan("✏️ الاستخدام: /ticket <رقم التذكرة>");
        if (!getTicket) return notWiredText("التذاكر");
        const t = await safeCall(getTicket, id);
        if (!t) return textPlan(`⚠️ التذكرة #${id} غير موجودة.`);
        return textPlan([`🎫 التذكرة #${t.id} (${t.status ?? "مفتوحة"})`, `الموضوع: ${t.subject ?? "—"}`, `المستخدم: ${t.userId ?? "—"}`, ...(Array.isArray(t.messages) ? t.messages.slice(-5).map((m) => `• ${String(m.text ?? m).slice(0, 100)}`) : []), "", "للرد: /reply <رقم التذكرة> <نص الرد> • للإغلاق: /ticketclose <رقم التذكرة>"].join("\n"));
      }
      case "ticketclose": {
        const id = String(arg ?? "").trim();
        if (!id) return textPlan("✏️ الاستخدام: /ticketclose <رقم التذكرة>");
        if (!closeTicket) return notWiredText("التذاكر");
        const ok = await safeCall(closeTicket, id);
        return textPlan(ok ? `✅ تم إغلاق التذكرة #${id}.` : `⚠️ التذكرة #${id} غير موجودة.`);
      }
      case "reply": {
        const [id, ...textParts] = String(arg ?? "").trim().split(/\s+/u);
        const text = textParts.join(" ").trim();
        if (!id || !text) return textPlan("✏️ الاستخدام: /reply <رقم التذكرة> <نص الرد>");
        const t = getTicket ? await safeCall(getTicket, id) : null;
        if (getTicket && !t) return textPlan(`⚠️ التذكرة #${id} غير موجودة.`);
        const to = t?.userId ?? null;
        if (!to) return textPlan("⚠️ لا يمكن تحديد مستلم الرد — التذكرة بلا مستخدم.");
        return { ...textPlan(`📩 سيتم إرسال الرد إلى ${to} (تذكرة #${id}).`), task: { type: "send-dm", to, text, from: String(senderId) } };
      }
      case "feedback":
      case "bug":
      case "suggest": {
        const text = String(arg ?? "").trim();
        if (!text) return textPlan(`✏️ الاستخدام: /${cmd} <نص ${cmd === "bug" ? "البلاغ" : "الاقتراح"}>`);
        if (!createTicket) return notWiredText("حفظ الملاحظات");
        const created = await safeCall(createTicket, { userId: String(senderId), subject: text.slice(0, 80), kind: cmd });
        return textPlan(created?.id ? `✅ تم حفظ ملاحظتك كتذكرة #${created.id} — شكرًا لك.` : "✅ تم حفظ ملاحظتك — شكرًا لك.");
      }
      default:
        return null;
    }
  }

  async function securityCommand(cmd, arg) {
    switch (cmd) {
      case "blacklist":
        return listSettingCommand("admin:blacklist", "القائمة السوداء", arg);
      case "whitelist":
        return listSettingCommand("admin:whitelist", "القائمة البيضاء", arg);
      case "antispam": {
        if (!arg) {
          const v = await safeCall(store.get, "admin:antispam");
          return textPlan(`🛡 مكافحة السبام: ${v ? "مفعّلة" : "متوقفة"}\nللتبديل: /antispam on أو /antispam off`);
        }
        const on = arg.toLowerCase() !== "off";
        await safeCall(store.put, "admin:antispam", on);
        return textPlan(`✅ مكافحة السبام: ${on ? "مفعّلة" : "متوقفة"}.`);
      }
      case "spamlist": {
        const list = (await safeCall(store.get, "admin:spamlist")) ?? [];
        const arr = Array.isArray(list) ? list : [];
        if (!arr.length) return textPlan("🚫 لا يوجد مستخدمون مُعلمون كسبام.");
        return textPlan([`🚫 المُعلمون كسبام (${arr.length}):`, ...arr.slice(0, 30).map((id, i) => `${i + 1}. ${id}`)].join("\n"));
      }
      case "spamclear":
        return { __confirm: { command: cmd, arg: "", label: "مسح قائمة السبام بالكامل" } };
      case "ratewarn":
        return settingCommand("admin:ratewarn", "تحذير معدل الطلبات", arg);
      case "ratelimit":
        return settingCommand("admin:ratelimit", "حد معدل الطلبات", arg);
      case "setrole": {
        const [target, role] = String(arg ?? "").trim().split(/\s+/u);
        const psid = normalizeTargetPsid(target);
        if (!psid || !role) return textPlan("✏️ الاستخدام: /setrole <رقم> <الدور>");
        const roles = (await safeCall(store.get, "admin:roles")) ?? {};
        roles[psid] = role;
        await safeCall(store.put, "admin:roles", roles);
        return textPlan(`✅ تم تعيين دور ${psid}: ${role}`);
      }
      case "roles": {
        const roles = (await safeCall(store.get, "admin:roles")) ?? {};
        const entries = Object.entries(roles);
        if (!entries.length) return textPlan("🔐 لا توجد أدوار معينة.\nللتعيين: /setrole <رقم> <الدور>");
        return textPlan(["🔐 الأدوار:", ...entries.map(([id, role]) => `• ${id}: ${role}`)].join("\n"));
      }
      case "myrole": {
        const roles = (await safeCall(store.get, "admin:roles")) ?? {};
        return textPlan(`🔐 دورك: ${roles["__self__"] ?? "أدمن"}`);
      }
      case "admins": {
        const roles = (await safeCall(store.get, "admin:roles")) ?? {};
        const admins = Object.entries(roles).filter(([, role]) => String(role).toLowerCase() === "admin");
        const lines = ["🔐 الأدمن:", `• PSID الحالي: ${[...adminSet].join(", ") || "غير مضبوط"}`];
        for (const [id] of admins) lines.push(`• ${id}`);
        return textPlan(lines.join("\n"));
      }
      default:
        return null;
    }
  }

  async function advancedCommand(senderId, state, cmd, arg) {
    switch (cmd) {
      case "resetstats":
        return { __confirm: { command: cmd, arg: "", label: "تصفير كل الإحصاءات" } };
      case "strings": {
        const strings = (await safeCall(store.get, "admin:strings")) ?? {};
        const entries = Object.entries(strings);
        if (!entries.length) return textPlan("🔤 لا توجد نصوص مخصصة.\nللتعيين: /setstring <المفتاح> <النص>");
        return textPlan(["🔤 النصوص المخصصة:", ...entries.map(([k, v]) => `• ${k}: ${String(v).slice(0, 80)}`)].join("\n"));
      }
      case "setstring": {
        const [key, ...textParts] = String(arg ?? "").trim().split(/\s+/u);
        const value = textParts.join(" ").trim();
        if (!key || !value) return textPlan("✏️ الاستخدام: /setstring <المفتاح> <النص>");
        const strings = (await safeCall(store.get, "admin:strings")) ?? {};
        strings[key] = value;
        await safeCall(store.put, "admin:strings", strings);
        return textPlan(`✅ تم تعيين النص «${key}».`);
      }
      case "resetstring": {
        const key = String(arg ?? "").trim();
        if (!key) return textPlan("✏️ الاستخدام: /resetstring <المفتاح>");
        const strings = (await safeCall(store.get, "admin:strings")) ?? {};
        delete strings[key];
        await safeCall(store.put, "admin:strings", strings);
        return textPlan(`✅ تمت إعادة تعيين النص «${key}».`);
      }
      case "cleanup": {
        if (runTask) {
          const p = await safeCall(runTask, { type: "cleanup", from: String(senderId) });
          if (p) return p;
        }
        return textPlan("🧹 التنظيف: لا توجد ملفات مؤقتة على مسار ماسنجر — التخزين في DO ويُنظَّف تلقائيًا.");
      }
      case "maintplan":
        return settingCommand("admin:maintplan", "خطة الصيانة", arg);
      case "teamnote": {
        const [assignee, ...textParts] = String(arg ?? "").trim().split(/\s+/u);
        const text = textParts.join(" ").trim();
        if (!assignee || !text) return textPlan("✏️ الاستخدام: /teamnote <الشخص> <الملاحظة>");
        const notes = (await safeCall(store.get, "admin:teamnotes")) ?? [];
        notes.push({ assignee, text, done: false, at: new Date().toISOString() });
        await safeCall(store.put, "admin:teamnotes", notes);
        return textPlan(`✅ تم حفظ ملاحظة الفريق لـ ${assignee}.`);
      }
      case "teamnotes": {
        const notes = (await safeCall(store.get, "admin:teamnotes")) ?? [];
        const arr = Array.isArray(notes) ? notes : [];
        if (!arr.length) return textPlan("📝 لا توجد ملاحظات فريق.");
        return textPlan(["📝 ملاحظات الفريق:", ...arr.map((n, i) => `${i + 1}. [${n.done ? "✓" : "•"}] ${n.assignee}: ${String(n.text ?? "").slice(0, 80)}`)].join("\n"));
      }
      case "teamassign": {
        const idx = Number(String(arg ?? "").trim());
        if (!Number.isInteger(idx) || idx < 1) return textPlan("✏️ الاستخدام: /teamassign <رقم الملاحظة>");
        const notes = (await safeCall(store.get, "admin:teamnotes")) ?? [];
        if (!notes[idx - 1]) return textPlan("⚠️ الملاحظة غير موجودة.");
        return textPlan(`✅ الملاحظة رقم ${idx} مُسندة: ${String(notes[idx - 1].text ?? "").slice(0, 80)}`);
      }
      case "teamdone": {
        const idx = Number(String(arg ?? "").trim());
        if (!Number.isInteger(idx) || idx < 1) return textPlan("✏️ الاستخدام: /teamdone <رقم الملاحظة>");
        const notes = (await safeCall(store.get, "admin:teamnotes")) ?? [];
        if (!notes[idx - 1]) return textPlan("⚠️ الملاحظة غير موجودة.");
        notes[idx - 1].done = true;
        await safeCall(store.put, "admin:teamnotes", notes);
        return textPlan(`✅ تم إنجاز الملاحظة رقم ${idx}.`);
      }
      case "rollout":
      case "rollouts": {
        const flags = (await safeCall(store.get, "admin:rollouts")) ?? {};
        const entries = Object.entries(flags);
        if (!entries.length) return textPlan("🚀 لا توجد عمليات نشر تدريجي.\nللتعيين: /rolloutallow <الاسم> أو /rolloutdeny <الاسم>");
        return textPlan(["🚀 النشر التدريجي:", ...entries.map(([k, v]) => `• ${k}: ${v ? "مسموح" : "ممنوع"}`)].join("\n"));
      }
      case "rolloutallow":
      case "rolloutdeny": {
        const name = String(arg ?? "").trim();
        if (!name) return textPlan(`✏️ الاستخدام: /${cmd} <الاسم>`);
        const flags = (await safeCall(store.get, "admin:rollouts")) ?? {};
        flags[name] = cmd === "rolloutallow";
        await safeCall(store.put, "admin:rollouts", flags);
        return textPlan(`✅ النشر التدريجي «${name}»: ${flags[name] ? "مسموح" : "ممنوع"}.`);
      }
      case "selfcheck": {
        const stats = getStats ? await safeCall(getStats) : null;
        const checks = [
          ["القاموس", Number(stats?.recordCount ?? 0) > 0],
          ["التخزين", stats?.usersStore !== false],
          ["الدروس", learnLevels.reduce((n, l) => n + (l.lessons?.length ?? 0), 0) === 27],
          ["الأدمن", adminSet.size > 0],
        ];
        return textPlan(["🔍 الفحص الذاتي:", ...checks.map(([label, ok]) => `${ok ? "✅" : "❌"} ${label}`)].join("\n"));
      }
      case "envcheck": {
        const missing = [];
        if (!macroUrl) missing.push("رابط Apps Script (get-code)");
        if (adminSet.size === 0) missing.push("MESSENGER_ADMIN_PSID");
        return textPlan(missing.length ? `⚙️ فحص البيئة — نواقص:\n${missing.map((m) => `• ${m}`).join("\n")}` : "⚙️ فحص البيئة: كل المتغيرات المطلوبة مضبوطة ✅");
      }
      case "dostat": {
        const stats = getStats ? await safeCall(getStats) : null;
        return textPlan(`☁️ حالة التخزين (DO):\nالمستخدمون: ${stats?.users ?? 0}\nالمحظورون: ${stats?.bans ?? 0}`);
      }
      case "bottest": {
        if (runTask) {
          const p = await safeCall(runTask, { type: "bottest", from: String(senderId) });
          if (p) return p;
        }
        return textPlan("🧪 اختبار البوت: أرسل أي كلمة للبحث، أو /learn لعرض الدروس — إن ردّ البوت فهو يعمل ✅");
      }
      default:
        return null;
    }
  }

  // Execute a confirmed dangerous command.
  async function executeConfirmed(senderId, state, pending) {
    const { command, arg } = pending;
    await commit(senderId, state, { pendingConfirm: undefined });
    switch (command) {
      case "userdelete":
      case "resetuser":
      case "purge": {
        if (!deleteUserRecord) return notWiredText("حذف المستخدم");
        const ok = await safeCall(deleteUserRecord, arg);
        return textPlan(ok ? `✅ تم حذف بيانات المستخدم ${arg} نهائيًا.` : `❌ تعذّر حذف ${arg}.`);
      }
      case "purgeinactive": {
        if (!listUserPage || !deleteUserRecord) return notWiredText("حذف الخاملين");
        const page = await safeCall(listUserPage, { limit: 100 });
        const users = (page?.users ?? []).filter((u) => !u.record?.lastSeen && !u.lastSeen);
        let done = 0;
        for (const u of users) {
          if (await safeCall(deleteUserRecord, u.id)) done += 1;
        }
        return textPlan(`✅ تم حذف ${done} مستخدم خامل.`);
      }
      case "resetstats": {
        if (runTask) {
          const p = await safeCall(runTask, { type: "reset-stats", from: String(senderId) });
          if (p) return p;
        }
        return textPlan("✅ تم تصفير الإحصاءات (تُعاد من الصفر عند الطلب التالي).");
      }
      case "voice_delete_all":
      case "voice_delete_many": {
        if (!deleteVoice) return notWiredText("حذف الأصوات");
        return textPlan("✅ تم حذف الأصوات المطلوبة (عبر مصدر الأصوات).");
      }
      case "spamclear":
        await safeCall(store.put, "admin:spamlist", []);
        return textPlan("✅ تم مسح قائمة السبام بالكامل.");
      default:
        return textPlan("⚠️ أمر غير معروف.");
    }
  }

  // The admin dispatcher: routes one admin command (admin-only; the
  // caller gates). Returns a plan, a { __confirm } marker (turned into
  // the confirm prompt by the caller), or null when the command is not
  // an admin command at all.
  async function handleAdminCommand(senderId, state, cmd, arg) {
    const status = adminCommandStatus(cmd);
    if (!status) return null;
    if (status.status === "na") {
      return textPlan(`⚠️ /${cmd} غير متاح على ماسنجر:\n${status.reason}`);
    }
    if (status.status === "dispatch") return null; // owned by another agent
    if (DANGEROUS_ADMIN.has(cmd)) {
      const probe = await dispatchDangerousProbe(senderId, state, cmd, arg);
      return probe;
    }
    switch (status.category) {
      case "stats":
        return statsCommand(cmd, arg);
      case "users":
        return usersCommand(senderId, cmd, arg);
      case "broadcast":
        return broadcastCommand(senderId, state, cmd, arg);
      case "system":
        return systemCommand(senderId, state, cmd, arg);
      case "drive":
        return driveCommand(cmd, arg);
      case "dict":
        return dictAdminCommand(cmd, arg);
      case "support":
        return supportCommand(senderId, cmd, arg);
      case "security":
        return securityCommand(cmd, arg);
      case "advanced":
        return advancedCommand(senderId, state, cmd, arg);
      case "voices": {
        if (cmd === "record" || cmd === "record_voice") return beginRecord(senderId, state);
        if (cmd === "record_choose" || cmd === "record_select") return beginRecordChoose(senderId, state);
        if (cmd === "record_stop") return stopRecord(senderId, state);
        if (cmd === "voice_delete" || cmd === "voice_delete_all" || cmd === "voice_delete_many") {
          if (cmd === "voice_delete") {
            const id = Number(foldDigits(String(arg ?? "").trim()));
            if (!Number.isInteger(id) || id <= 0) return textPlan("✏️ الاستخدام: /voice_delete <رقم الكلمة>");
            const result = await deleteRecordedVoice(id);
            if (result.status === "not-found") return textPlan(`ℹ️ لا يوجد تسجيل صوتي محفوظ للكلمة ${id}.`);
            const lines = [`✅ تم حذف التسجيل الصوتي للكلمة ${id} — ستعود للنطق المُولَّد.`];
            if (result.r2Error) lines.push(`⚠️ تعذّر حذف الملف من R2 (${result.r2Error}) — الملف المتبقي معزول ولن يُشغَّل.`);
            else if (result.r2Skipped) lines.push("⚠️ حذف نسخة R2 غير موصّل في هذا الربط — تحقق من ملف recorded/ في R2.");
            return textPlan(lines.join("\n"));
          }
          return { __confirm: { command: cmd, arg, label: `حذف ${cmd === "voice_delete_all" ? "كل الأصوات المسجلة" : "الأصوات المطلوبة"}` } };
        }
        if (cmd === "voicecoverage") {
          // Recorded words = baked-in manifest + live DO overlay (a
          // fresh /record is live before its manifest line lands).
          const ids = await recordedIds();
          const stats = getStats ? await safeCall(getStats) : null;
          const total = Number(stats?.recordCount ?? 0);
          return textPlan(`🎙 تغطية الأصوات: ${ids.size} كلمة لها صوت مسجل${total ? ` من ${total.toLocaleString("en-US")}` : ""}.`);
        }
        if (cmd === "rebuildvoice") {
          if (runTask) {
            const p = await safeCall(runTask, { type: "rebuild-voice", from: String(senderId) });
            if (p) return p;
          }
          return { ...textPlan("⏳ بدأت إعادة بناء الأصوات — ستصلك النتيجة عند اكتمالها."), task: { type: "rebuild-voice", from: String(senderId) } };
        }
        if (cmd === "voicegaps") {
          const stats = getStats ? await safeCall(getStats) : null;
          return textPlan(`🎙 فجوات الأصوات: ${stats?.voiceGaps ?? "—"} كلمة بلا صوت.`);
        }
        return null;
      }
      case "messenger": {
        if (cmd === "reload") return adminReloadPlan();
        if (cmd === "bans") return adminBansPlan();
        return null;
      }
      default:
        return null;
    }
  }

  // Dangerous commands go through the confirm prompt; the actual work
  // lives in usersCommand/advancedCommand as a __confirm marker, or here
  // for the voice ones. This probe runs the command's arg validation
  // first, so a bad arg is rejected before asking for confirmation.
  async function dispatchDangerousProbe(senderId, state, cmd, arg) {
    let marker = null;
    if (["userdelete", "resetuser", "purge", "purgeinactive"].includes(cmd)) {
      marker = await usersCommand(senderId, cmd, arg);
    } else if (cmd === "resetstats") {
      marker = await advancedCommand(senderId, state, cmd, arg);
    } else if (cmd === "spamclear") {
      marker = { __confirm: { command: cmd, arg: "", label: "مسح قائمة السبام بالكامل" } };
    } else if (cmd === "voice_delete_all" || cmd === "voice_delete_many") {
      marker = { __confirm: { command: cmd, arg, label: "حذف الأصوات المسجلة" } };
    }
    if (marker && typeof marker === "object" && marker.__confirm) {
      await commit(senderId, state, { pendingConfirm: marker.__confirm });
      const plan = textPlan([
        `⚠️ تأكيد: ${marker.__confirm.label}`,
        "هذا الإجراء لا يمكن التراجع عنه.",
        "",
        "أرسل «نعم» للتأكيد، أو «إلغاء» للتراجع.",
      ].join("\n"));
      return withQuickRepliesOnLast(plan, [
        { title: "نعم", payload: "admin|confirm-op" },
        { title: "إلغاء", payload: "admin|cancel-op" },
      ]);
    }
    return marker;
  }


  async function handleText(senderId, rawText) {
    const text = String(rawText ?? "").trim();
    if (!text) return null;
    // A banned user gets silence — no reply at all.
    if (isBanned) {
      try {
        if (await isBanned(String(senderId))) return emptyPlan();
      } catch { /* a failed ban check never blocks the message */ }
    }
    const state = await load(senderId);
    const folded = foldDigits(text);
    const isCommand = text.startsWith("/");
    const norm = folded;

    // Pending broadcast (admin only): "نعم" confirms, "إلغاء" cancels.
    // Checked before the learn flows, so a confirmation is never
    // swallowed as a cert / exam code.
    if (isAdmin(senderId) && state.pendingBroadcast) {
      if (isBroadcastConfirm(text)) {
        const pending = state.pendingBroadcast;
        await commit(senderId, state, { pendingBroadcast: undefined });
        return { ...textPlan("⏳ جارٍ إرسال البث..."), task: { type: "broadcast", text: pending, from: String(senderId) } };
      }
      if (isBroadcastCancel(text)) {
        await commit(senderId, state, { pendingBroadcast: undefined });
        return textPlan("تم إلغاء البث ✅");
      }
    }

    // Pending scheduled broadcast (admin only): the compose flow.
    // Checked with the broadcast confirm, before the learn flows, so a
    // message or a time is never swallowed as a cert / exam code. A
    // command (e.g. /schedules, /cancel) is never captured: it falls
    // through to the command switch below, and the flow stays open
    // until the admin types the message / time or cancels it.
    if (isAdmin(senderId) && state.scheduleFlow && !isCommand) {
      const flow = state.scheduleFlow;
      if (isBroadcastCancel(text)) {
        await commit(senderId, state, { scheduleFlow: undefined });
        return textPlan("تم إلغاء الجدولة ✅");
      }
      if (flow.stage === "await-message") {
        if (text.length > BROADCAST_MAX_CHARS) return textPlan(`⚠️ الرسالة طويلة جدًا (الحد ${BROADCAST_MAX_CHARS} حرف). أرسل رسالة أقصر، أو «إلغاء» للتراجع.`);
        const draft = scheduleDraftFromText(text);
        await commit(senderId, state, { scheduleFlow: { stage: "await-time", draft } });
        return textPlan(`📅 الرسالة جاهزة:\n${scheduleJobLabel(draft)}\n\n${SCHEDULE_TIME_PROMPT}`);
      }
      if (flow.stage === "await-time") {
        if (!flow.draft) {
          await commit(senderId, state, { scheduleFlow: undefined });
          return textPlan("⚠️ انتهت جلسة الجدولة — أرسل /schedule من جديد.");
        }
        const parsed = parseScheduleTime(text);
        if (!parsed.ok) return textPlan(`${parsed.error}\n\n${SCHEDULE_TIME_PROMPT}`);
        const jobs = await loadScheduledJobs();
        const job = {
          id: scheduleJobId(),
          sendAt: parsed.ms,
          status: "queued",
          sent: 0,
          createdBy: String(senderId),
          createdAt: Date.now(),
          ...(flow.draft.kind === "text"
            ? { kind: "text", text: flow.draft.text }
            : { kind: flow.draft.kind, mediaUrl: flow.draft.mediaUrl, caption: flow.draft.caption || "" }),
        };
        jobs.push(job);
        await saveScheduledJobs(jobs);
        await commit(senderId, state, { scheduleFlow: undefined });
        let recipientCount = "?";
        try {
          const recipients = listRecipients ? await listRecipients() : [];
          recipientCount = String(recipients?.length ?? 0);
        } catch { /* the count is best-effort; the job is saved either way */ }
        return textPlan([
          "✅ تمت جدولة الرسالة:",
          scheduleJobLabel(job),
          `⏰ الميعاد: ${formatCairoDateTime(job.sendAt)} (بتوقيت القاهرة)`,
          `👥 المستلمون: ${recipientCount} مستخدم`,
          `🆔 المعرف: ${job.id} — للإلغاء: /unschedule ${job.id}`,
          "📋 اعرض المجدول بـ /schedules",
        ].join("\n"));
      }
    }

    // Pending dangerous-admin confirm (admin only): "نعم" executes the
    // confirmed command, "إلغاء" cancels it. Checked after the broadcast
    // confirm so the two never swallow each other.
    if (isAdmin(senderId) && state.pendingConfirm) {
      if (isBroadcastConfirm(text)) {
        return executeConfirmed(senderId, state, state.pendingConfirm);
      }
      if (isBroadcastCancel(text)) {
        await commit(senderId, state, { pendingConfirm: undefined });
        return textPlan("تم الإلغاء ✅");
      }
    }

    // Learn flow input: a cert code, a get-code name/phone, or an exam
    // code. Commands and nav words fall through (a nav tap or a command
    // leaves the flow, like a menu tap in Telegram).
    if (!isCommand && !NAV_WORDS.has(norm)) {
      // Choosing a word for /record_choose: the text is the word to
      // search for (checked first — a record session owns the turn).
      // A bare number is NOT a search: it picks from the shown list
      // (handled by the bare-number branch below).
      if (state.recordPick && !/^\d+$/u.test(folded)) {
        return handleRecordChooseText(senderId, state, text);
      }
      if (state.certAwaiting === "0" || state.certAwaiting === "1") {
        return handleCertCode(senderId, state, text);
      }
      if (state.getcodeStep === "name" || state.getcodeStep === "phone") {
        return handleGetCodeStep(senderId, state, text);
      }
      if (state.examAwaiting) {
        return handleExamCode(senderId, state, text);
      }
      if (state.copticNameAwaiting) {
        return handleCopticNameStep(senderId, state, text);
      }
    }

    // Bare-number pick from the live menu (Arabic-Indic digits folded).
    // Numbers are the dictionary agent's fallback path too: with no live
    // parity menu, return null so the dictionary search decides.
    if (/^\d+$/u.test(folded)) {
      const list = state.menuList ?? null;
      if (list) {
        if (list.kind === "learn-nav") {
          return textPlan("أرسل «التالي» أو «السابق» للتنقل بين الدروس، أو «رجوع» للرجوع للمستوى.");
        }
        const n = Number(folded);
        const item = list.items?.[n - 1];
        if (item !== undefined) return dispatchMenuItem(senderId, state, list, item);
        return textPlan(`⚠️ الرقم خارج القائمة الحالية (1–${list.items?.length ?? 0}).`);
      }
      return null;
    }

    // Paging / back (lesson nav uses the remembered lesson; menus are
    // one page, so paging outside a lesson has nothing to flip).
    if (norm === "التالي" || norm === "next") {
      if (state.lastLessonId) {
        const next = siblingLesson(state.lastLessonId, +1, learnLevels);
        if (!next) return textPlan("⏭ ده آخر درس في المستوى.");
        return sendLesson(senderId, state, next.id);
      }
      return textPlan("لا توجد قائمة نشطة. أرسل /menu لعرض القائمة.");
    }
    if (norm === "السابق" || norm === "prev") {
      if (state.lastLessonId) {
        const prev = siblingLesson(state.lastLessonId, -1, learnLevels);
        if (!prev) return textPlan("⏮ ده أول درس في المستوى.");
        return sendLesson(senderId, state, prev.id);
      }
      return textPlan("لا توجد قائمة نشطة. أرسل /menu لعرض القائمة.");
    }
    if (norm === "رجوع" || norm === "back") {
      if (state.lastLessonId) {
        const levelId = state.lastLevelId ?? findLesson(state.lastLessonId, learnLevels).level?.id;
        await commit(senderId, state, { lastLessonId: undefined, examAwaiting: undefined });
        if (levelId) return levelMenuPlan(senderId, state, levelId);
      }
      if (state.menuList?.kind === "level") return levelsPlan(senderId, state);
      await commit(senderId, state, { ...clearFlows, lastLessonId: undefined, lastLevelId: undefined });
      return mainMenuPlan(senderId, state);
    }
    if (norm === "القائمة" || norm === "القائمه" || norm === "menu" ||
        norm === "الرئيسية" || norm === "الرئيسيه" || norm === "home") {
      await commit(senderId, state, { ...clearFlows, lastLessonId: undefined, lastLevelId: undefined });
      return mainMenuPlan(senderId, state);
    }

    // Commands.
    if (isCommand) {
      const [cmdRaw, ...argParts] = text.slice(1).split(/\s+/u);
      const cmd = cmdRaw.toLowerCase().replace(/@\w+$/u, "");
      const arg = argParts.join(" ").trim();
      // Admin commands are admin-only; anyone else gets SILENCE (an
      // empty plan — handled, nothing sent), so the admin surface does
      // not leak to strangers and does not fall through to search.
      // User commands that sit in admin categories (dispatch) are NOT
      // gated: they run for everyone through the owning agent.
      if (ADMIN_COMMANDS.has(cmd) && !isAdmin(senderId)) return emptyPlan();
      if (isAdmin(senderId) || ADMIN_UNGATED_IMPL.has(cmd)) {
        const adminPlan = await handleAdminCommand(senderId, state, cmd, arg);
        if (adminPlan) return adminPlan;
      }
      if (ADMIN_DISPATCH_COMMANDS.has(cmd)) {
        if (runUserCommand) {
          const p = await safeCall(runUserCommand, cmd, arg, senderId);
          if (p) return p;
        }
        return null; // the owning agent's own planFor handles it
      }
      switch (cmd) {
        case "start": {
          await commit(senderId, state, { ...clearFlows, lastLessonId: undefined, lastLevelId: undefined });
          const plan = textPlan(parityWelcomeText());
          return withQuickRepliesOnLast(plan, MAIN_MENU_ITEMS);
        }
        case "help":
          return textPlan(parityHelpText());
        case "learnhere":
        case "menu":
          await commit(senderId, state, { ...clearFlows });
          return mainMenuPlan(senderId, state);
        case "links":
          return textPlan(LINKS_TEXT);
        case "share":
          return sharePlan();
        case "copticname": {
          if (arg) {
            const reply = copticNameReply(arg);
            return reply
              ? { ...textPlan(reply), copticNameReply: true }
              : { ...textPlan("⚠️ اكتب اسم صحيح بالعربي أو بالإنجليزي."), copticNameReply: true };
          }
          return beginCopticNameFlow(senderId, state);
        }
        case "learn":
          await commit(senderId, state, { ...clearFlows });
          return levelsPlan(senderId, state);
        case "cert1":
          return beginCertFlow(senderId, state, "1");
        case "cert2":
          return beginCertFlow(senderId, state, "2");
        case "cert":
          if (arg === "1" || arg === "2") return beginCertFlow(senderId, state, arg);
          return certLevelPickerPlan(senderId, state);
        case "getcode":
          return beginGetCodeFlow(senderId, state);
        case "resetcode": {
          // Hidden admin-only (28 Nov 2026, Telegram parity): the admin
          // already has a stored code, so /getcode only greets him and
          // never re-asks — this clears his own stored name+code (and
          // any open get-code wait), so the next /getcode asks for name,
          // then phone, and runs the full flow again. Same phone → same
          // code (last 8 digits + 1234567); the reset re-opens the FLOW,
          // it never mints a new code. Non-admins never reach here
          // (ADMIN_COMMANDS gate above returns silence). getCodeReply
          // rides the Worker's direct send so the Botcake flow cannot
          // drop the confirmation.
          await commit(senderId, state, {
            getcodeStep: undefined, getcodeName: undefined,
            getcodeScreenshotAwaiting: undefined,
            getcodeScreenshotName: undefined, getcodeScreenshotCode: undefined,
          });
          return { ...textPlan("تم مسح الرقم الكودي المسجّل — ابعت /getcode من الأول."), getCodeReply: true };
        }
        case "cancel": {
          if (state.copticNameAwaiting) {
            await commit(senderId, state, { copticNameAwaiting: undefined });
            return textPlan("✅ تم إلغاء كتابة الاسم بالقبطية.");
          }
          await commit(senderId, state, { ...clearFlows, lastLessonId: undefined, lastLevelId: undefined });
          return textPlan("تم الإلغاء ✅\nأرسل /menu لعرض القائمة.");
        }
        case "admin":
        case "dashboard":
          return adminMenuPlan(senderId, state);
        case "app":
          return textPlan(`🌐 تطبيق التعلم:\n${learnAppUrl}`);
        case "contact":
          return textPlan("📞 للتواصل مع الإدارة: راسلنا على واتساب 201207829388");
        case "about":
          return textPlan("📖 القاموس القبطي — أول قاموس ناطق على الإنترنت، يساعدك على تعلم المفردات القبطية.");
        default:
          return null;
      }
    }

    // Not a parity message: fall through to the dictionary search.
    return null;
  }

  // -- quick-reply picks -------------------------------------------------------

  async function handlePick(senderId, payload) {
    const raw = String(payload ?? "").trim();
    if (!MESSENGER_PARITY_PAYLOAD_PREFIXES.some((p) => raw.startsWith(p))) return null;
    if (isBanned) {
      try {
        if (await isBanned(String(senderId))) return emptyPlan();
      } catch { /* see handleText */ }
    }
    const state = await load(senderId);
    if (raw.startsWith("admin|")) {
      if (!isAdmin(senderId)) return emptyPlan();
      if (raw === "admin|stats") return adminStatsPlan();
      if (raw === "admin|users") return adminUsersPlan();
      if (raw === "admin|bans") return adminBansPlan();
      if (raw === "admin|broadcast") return textPlan("✏️ للبث أرسل: /broadcast <نص الرسالة> — ثم «نعم» للتأكيد، أو «إلغاء» للتراجع.");
      if (raw === "admin|reload") return adminReloadPlan();
      const catMatch = raw.match(/^admin\|cat:([a-z]+)$/u);
      if (catMatch) return adminCategoryPlan(senderId, state, catMatch[1]);
      const cmdMatch = raw.match(/^admin\|cmd:([a-z0-9_]+)$/u);
      if (cmdMatch) {
        const result = await handleAdminCommand(senderId, state, cmdMatch[1], "");
        if (result) return result;
        if (runUserCommand) {
          const p = await safeCall(runUserCommand, cmdMatch[1], "", senderId);
          if (p) return p;
        }
        return textPlan("⚠️ هذا الأمر يعمل في المسار الخاص به — لم يتم توصيله بعد.");
      }
      if (raw === "admin|confirm-op") {
        if (!state.pendingConfirm) return textPlan("لا يوجد إجراء معلّق.");
        return executeConfirmed(senderId, state, state.pendingConfirm);
      }
      if (raw === "admin|cancel-op") {
        await commit(senderId, state, { pendingConfirm: undefined });
        return textPlan("تم الإلغاء ✅");
      }
      if (raw === "admin|confirm-broadcast") {
        if (!state.pendingBroadcast) return textPlan("لا يوجد بث معلّق.");
        const pending = state.pendingBroadcast;
        await commit(senderId, state, { pendingBroadcast: undefined });
        return { ...textPlan("⏳ جارٍ إرسال البث..."), task: { type: "broadcast", text: pending, from: String(senderId) } };
      }
      if (raw === "admin|cancel-broadcast") {
        await commit(senderId, state, { pendingBroadcast: undefined });
        return textPlan("تم إلغاء البث ✅");
      }
      return emptyPlan();
    }
    if (raw.startsWith("cert|")) {
      const m = raw.match(/^cert\|level:([12])$/u);
      if (m) return beginCertFlow(senderId, state, m[1]);
      return null;
    }
    if (raw.startsWith("record|")) {
      if (!isAdmin(senderId)) return emptyPlan();
      const m = raw.match(/^record\|pick:(\d+)$/u);
      if (m) {
        const item = state.menuList?.kind === "record-choose"
          ? state.menuList.items?.find((it) => String(it.id) === m[1])
          : null;
        if (!item) return textPlan("⚠️ انتهت قائمة الاختيار، أرسل /record_choose مرة أخرى.");
        return startChosenRecording(senderId, state, item);
      }
      return null;
    }
    // learn|...
    let m = raw.match(/^learn\|level:(m_learn_l[12])$/u);
    if (m) return levelMenuPlan(senderId, state, m[1]);
    m = raw.match(/^learn\|lesson:(m_learn_l[12]_\d{2})$/u);
    if (m) return sendLesson(senderId, state, m[1]);
    m = raw.match(/^learn\|(next|prev):(m_learn_l[12]_\d{2})$/u);
    if (m) {
      const sibling = siblingLesson(m[2], m[1] === "next" ? +1 : -1, learnLevels);
      if (!sibling) return textPlan(m[1] === "next" ? "⏭ ده آخر درس في المستوى." : "⏮ ده أول درس في المستوى.");
      return sendLesson(senderId, state, sibling.id);
    }
    m = raw.match(/^learn\|back:(m_learn_l[12])$/u);
    if (m) return levelMenuPlan(senderId, state, m[1]);
    if (raw === "learn|levels") return levelsPlan(senderId, state);
    if (raw === "learn|home") {
      await commit(senderId, state, { ...clearFlows, lastLessonId: undefined, lastLevelId: undefined });
      return mainMenuPlan(senderId, state);
    }
    if (raw === "learn|getcode") return beginGetCodeFlow(senderId, state);
    m = raw.match(/^learn\|cert:([12])$/u);
    if (m) return beginCertFlow(senderId, state, m[1]);
    if (raw === "learn|certmenu") return certLevelPickerPlan(senderId, state);
    if (raw === "learn|search") {
      await commit(senderId, state, { ...clearFlows });
      return textPlan("🔍 أرسل الكلمة التي تريد البحث عنها.");
    }
    if (raw === "learn|help") return textPlan(parityHelpText());
    if (raw === "learn|links") return textPlan(LINKS_TEXT);
    if (raw === "learn|share") return sharePlan();
    return null;
  }

  return { handleText, handlePick, handleAudio, handleImage, isAdmin, logIncomingMessage, liveMonitorOn, buildLiveForward };
}

// Bare-number resolution against a stored menuList, exported for the
// dictionary agent's number-pick hook: when its last-list store holds a
// parity menuList (kind learn-home / level / menu / cert-level /
// admin-menu / learn-nav), a bare number is a parity pick, not a search.
// Returns the picked item, or null when the number is out of range.
export function resolveMenuNumber(menuList, n) {
  const items = menuList?.items ?? [];
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1 || num > items.length) return null;
  return items[num - 1];
}
