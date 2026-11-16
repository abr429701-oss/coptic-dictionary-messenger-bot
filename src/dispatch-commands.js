// src/dispatch-commands.js — the real `runUserCommand` for Messenger.
//
// The 57 ADMIN_DISPATCH_COMMANDS used to fall through to dictionary search
// because the dep was null (src/index.js), so an admin tapping one in the
// admin menu saw "⚠️ هذا الأمر يعمل في المسار الخاص به — لم يتم توصيله
// بعد." This module wires each one to its real handler:
//
//   * Dictionary features — Messenger's own src/features.js (ported from
//     the Telegram repo's src/features.js; same algorithms, same anchor
//     date). Texts are HTML there, so every reply goes through
//     plainTextCard: Messenger renders no markup.
//   * Word of the day / daily summary / random word — Telegram's
//     pro-user2.js wodOfDay algorithm (records[day % len]).
//   * Favorites / voice prefs / WOD subscription / notify — per-PSID
//     state on the `user:msgr:<PSID>` record (loadUser/saveUserRecord
//     deps, DO-backed in production).
//   * Suggest / contribute / tickets / alerts — the DO key/value
//     adminStore (msgr:suggestions, msgr:tickets, msgr:alerts).
//
// PARKED (user's own decision 2026-11-13, audit group 10): in-chat
// quizzes and games (quiz, quiz2, quizstats, dailyquiz, streak, hangman,
// guess, gamify, badges, exportanki, examples, compare). These return an
// honest "not built" message — the wording mirrors the WhatsApp port's
// admin-catalog.js, with "ماسنجر" in place of "واتساب". /daily is NOT a
// quiz: Telegram's /daily is a daily summary (word of the day + counts),
// so it is implemented.
//
// /lang has no Messenger meaning (the interface is Arabic-only, audit
// group 11) and is NOT in the dispatch set — it lives in
// ADMIN_NOT_APPLICABLE instead.
//
// The function returns a plan ({ texts, voiceUrl, task? }) or null. It
// never throws: a dep failure answers with a retry text instead of
// falling through to a dictionary search for "/quiz".

import records from "../data/dictionary.json" with { type: "json" };
import audioManifest from "../data/audio-manifest.json" with { type: "json" };
import {
  quickLookup,
  copticDateNow,
  alphabetText,
  letterStatsText,
  longestText,
  originsText,
  translateText,
  similarText,
  startsWithText,
  vocabText,
} from "./features.js";
import { plainTextCard } from "./messenger.js";

// The Messenger Page the bot lives on (verified 2026-11-16, Page #3):
// profile.php?id=61554907237871, renamed "القاموس القبطي Ⲭⲏⲙⲓ".
export const MESSENGER_PAGE_URL = "https://www.facebook.com/profile.php?id=61554907237871";

const MARKS = /[\u0300-\u036f\u064b-\u065f\u0670\u06d6-\u06ed]/gu;
function stripMarks(value) {
  return String(value ?? "")
    .replace(MARKS, "")
    .replace(/`/gu, "")
    .replace(/\s*\([^)]*\)/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
function splitMeaning(value) {
  return String(value ?? "").split(/\s*[،,]\s*/u).map((part) => part.trim()).filter(Boolean);
}
function firstMeaning(record) {
  return splitMeaning(record?.meaning ?? "")[0] ?? "";
}
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Parked by the user's own decision — never build unless they change
// their mind. Wording mirrors the WhatsApp port's admin-catalog.js.
export const PARKED_DISPATCH_MESSAGES = {
  quiz: "الاختبارات داخل المحادثة غير مبنية في ماسنجر — الامتحانات برابط من /learn",
  quiz2: "الاختبارات داخل المحادثة غير مبنية في ماسنجر",
  quizstats: "الاختبارات داخل المحادثة غير مبنية في ماسنجر",
  dailyquiz: "الاختبار اليومي غير مبني في ماسنجر",
  streak: "السلاسل غير مبنية في ماسنجر",
  hangman: "لعبة الحروف غير مبنية في ماسنجر",
  guess: "لعبة التخمين غير مبنية في ماسنجر",
  gamify: "الألعاب غير مبنية في ماسنجر",
  badges: "الشارات غير مبنية في ماسنجر",
  exportanki: "تصدير أنكي غير مبني في ماسنجر",
  examples: "الأمثلة غير مبنية في ماسنجر",
  compare: "المقارنة غير مبنية في ماسنجر",
};
export const PARKED_DISPATCH_COMMANDS = new Set(Object.keys(PARKED_DISPATCH_MESSAGES));

const COPTIC_TO_LATIN = {
  "ⲁ": "a", "ⲃ": "v", "ⲅ": "g", "ⲇ": "d", "ⲉ": "e", "ⲋ": "s", "ⲍ": "z",
  "ⲏ": "ē", "ⲑ": "th", "ⲓ": "i", "ⲕ": "k", "ⲗ": "l", "ⲙ": "m", "ⲛ": "n",
  "ⲝ": "x", "ⲟ": "o", "ⲡ": "p", "ⲣ": "r", "ⲥ": "s", "ⲧ": "t", "ⲩ": "u",
  "ⲫ": "ph", "ⲭ": "kh", "ⲯ": "ps", "ⲱ": "ō", "ϣ": "š", "ϥ": "f", "ϧ": "ḫ",
  "ϩ": "h", "ϫ": "j", "ϭ": "č", "ϯ": "ti", "ⳉ": "ḫ",
};
function transliterate(coptic) {
  return [...stripMarks(coptic)].map((c) => COPTIC_TO_LATIN[c] ?? c).join("");
}

const FAVORITES_MAX = 50;

function textPlan(text, extra = {}) {
  return { texts: [{ text }], voiceUrl: null, ...extra };
}
function htmlPlan(html, extra = {}) {
  return textPlan(plainTextCard(html), extra);
}

export function wodRecord(now = new Date()) {
  const day = Math.floor(now.getTime() / 86400000);
  return records[((day % records.length) + records.length) % records.length];
}
function randomRecord() {
  for (let tries = 0; tries < 40; tries += 1) {
    const r = records[Math.floor(Math.random() * records.length)];
    if (r && !r._deleted) return r;
  }
  return records.find((r) => !r._deleted) ?? null;
}
function historyQueries(history) {
  return (Array.isArray(history) ? history : [])
    .map((h) => String(h?.q ?? h ?? "").trim())
    .filter(Boolean);
}

export function createDispatchCommands(deps = {}) {
  const {
    getUserRecord = null, // (psid) => { record, history } | null
    saveUserRecord = null, // (psid, record) => boolean
    clearHistory = null, // (psid) => boolean
    wordCard = null, // async (record) => plan
    hasRecordedVoice = null, // async (id) => boolean
    adminStore = null, // { get, put, del } — DO key/value
    isAdmin = null, // (psid) => boolean
    firstAdminPsid = null, // string | null — send-dm target
    listErrors = null, // () => [{ at, where, message }] | null
  } = deps;

  async function loadUser(psid) {
    try {
      const info = await getUserRecord?.(String(psid));
      return info?.record && typeof info.record === "object" ? { ...info.record } : {};
    } catch {
      return {};
    }
  }
  async function saveUser(psid, record) {
    try {
      await saveUserRecord?.(String(psid), record);
      return true;
    } catch {
      return false;
    }
  }
  async function loadHistory(psid) {
    try {
      const info = await getUserRecord?.(String(psid));
      return historyQueries(info?.history);
    } catch {
      return [];
    }
  }
  async function storeGet(key, fallback = null) {
    try {
      const v = await adminStore?.get?.(key);
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }
  async function storePut(key, value) {
    try {
      await adminStore?.put?.(key, value);
      return true;
    } catch {
      return false;
    }
  }
  async function favoritesOf(psid) {
    const record = await loadUser(psid);
    return { record, favs: Array.isArray(record.favorites) ? [...record.favorites] : [] };
  }
  function favKey(word) {
    return stripMarks(word).toLowerCase();
  }

  async function wordInfoPlan(arg) {
    if (!arg) return textPlan("✏️ الاستخدام: /wordinfo <كلمة> — كل الحقول الخام للكلمة ورقم صفها وحالة الصوت.");
    const hit = quickLookup(arg);
    if (!hit) return textPlan("❌ لم أجد هذه الكلمة في القاموس.");
    const row = records.indexOf(hit);
    const recorded = hasRecordedVoice ? await hasRecordedVoice(hit.id).catch(() => false) : null;
    const fields = Object.entries(hit)
      .filter(([k, v]) => k !== "_deleted" && String(v ?? "").trim())
      .slice(0, 15)
      .map(([k, v]) => `• <b>${escapeHtml(k)}:</b> ${escapeHtml(String(v).slice(0, 120))}`);
    const lines = [
      `🔍 <b>معلومات الكلمة</b> (صف ${row + 2})`,
      ...(recorded === null ? [] : [`🔊 صوت مسجل: ${recorded ? "نعم ✅" : "لا ❌"}`]),
      "",
      ...fields,
    ];
    return htmlPlan(lines.join("\n").slice(0, 3800));
  }

  function wordSearchPlan(arg) {
    if (!arg) return textPlan("✏️ الاستخدام: /wordsearch <نص> — يبحث في كل الحقول ويعرض المطابقة مع رقم الصف.");
    const needle = String(arg).toLowerCase();
    const hits = [];
    for (let index = 0; index < records.length && hits.length < 20; index += 1) {
      const record = records[index];
      if (record?._deleted) continue;
      const haystack = ["coptic", "greek", "pronunciation", "english", "meaning", "translation_fr", "translation_de"]
        .map((field) => String(record?.[field] ?? "").toLowerCase())
        .join(" ");
      if (haystack.includes(needle)) hits.push({ index, record });
    }
    if (!hits.length) return textPlan(`📭 لا مطابقة لـ «${arg}».`);
    const lines = [`🔎 <b>نتائج «${escapeHtml(arg)}»</b> (${hits.length}${hits.length >= 20 ? "+" : ""})`, ""];
    for (const { index, record } of hits) {
      lines.push(`• <code>${index}</code> <b>${escapeHtml(stripMarks(record.coptic))}</b> — ${escapeHtml(firstMeaning(record).slice(0, 60))}`);
    }
    lines.push("", "ابحث عن أي كلمة بإرسالها مباشرة.");
    return htmlPlan(lines.join("\n"));
  }

  async function pronouncePlan(arg) {
    if (!arg) return textPlan("✏️ الاستخدام: /pronounce <كلمة> — نطق الكلمة.");
    const hit = quickLookup(arg);
    if (!hit) return textPlan(`❌ لم أجد «${arg}».`);
    const recorded = hasRecordedVoice ? await hasRecordedVoice(hit.id).catch(() => false) : false;
    const prebuilt = Boolean(audioManifest[hit.id] || audioManifest[String(hit.id)]);
    const ipa = String(hit.pronunciation ?? "").trim();
    return textPlan([
      `🔊 النطق: ${stripMarks(hit.coptic)}`,
      "",
      `النطق المكتوب: ${ipa || "غير متوفر"}`,
      `النقل الصوتي (باللاتيني): ${transliterate(hit.coptic)}`,
      `تسجيل صوتي: ${recorded || prebuilt ? "✅ متوفر — ابحث عن الكلمة لسماعها." : "⬜ غير متوفر حاليًا."}`,
    ].join("\n"));
  }

  async function dailyPlan(psid) {
    const { record, favs } = await favoritesOf(psid);
    const history = await loadHistory(psid);
    const w = wodRecord();
    const today = new Date().toISOString().slice(0, 10);
    return textPlan([
      `📅 ملخصك اليومي (${today})`,
      "",
      `كلمة اليوم: ${stripMarks(w.coptic)} — ${firstMeaning(w).slice(0, 60)}`,
      `مفضلتك: ${favs.length}`,
      `عمليات بحث محفوظة: ${history.length}`,
      "ابحث عن كلمة جديدة اليوم!",
      "اسمع نطق كلمة اليوم بالبحث عنها مباشرة.",
    ].join("\n"));
  }

  async function myStatsPlan(psid) {
    const { record, favs } = await favoritesOf(psid);
    const history = await loadHistory(psid);
    const name = String(record.name ?? "").trim();
    return textPlan([
      `📊 إحصاءاتك${name ? ` يا ${name}` : ""}`,
      `⭐ كلماتك المفضلة: ${favs.length} (/myfav لعرضها)`,
      `🕘 عمليات بحث محفوظة: ${history.length} (/recent لعرضها)`,
      `🔔 كلمة اليوم: ${record.wodSub ? "مشترك ✅" : "غير مشترك — /subscribe للاشتراك"}`,
      `🔊 النطق التلقائي: ${record.voiceOff ? "متوقف (/voiceon للتشغيل)" : "يعمل"}`,
      `🔊 تكرار النطق: ${record.voiceRepeats === 1 ? "مرة واحدة" : "3 مرات"}`,
    ].join("\n"));
  }

  function favoritesListText(favs) {
    return [
      "⭐ كلماتك المفضلة",
      "",
      ...favs.slice(0, 20).map((f) => `• ${String(f.word ?? "").slice(0, 40)} — ${String(f.meaning ?? "").slice(0, 40)}\n  حذف: /myfav ${String(f.word ?? "")}`),
    ].join("\n");
  }

  async function myTicketsPlan(psid) {
    const tickets = (await storeGet("msgr:tickets", [])) || [];
    const mine = (Array.isArray(tickets) ? tickets : []).filter((t) => String(t.userId) === String(psid));
    if (!mine.length) return textPlan("📭 ليس لديك تذاكر دعم. افتح واحدة عبر /support.");
    const lines = ["🎫 تذاكر الدعم الخاصة بك", ""];
    for (const t of mine.slice(-10).reverse()) {
      const state = t.status === "open" ? "🟢 مفتوحة" : "⚪ مغلقة";
      const last = [...(Array.isArray(t.replies) ? t.replies : []), { text: t.text }].filter((m) => m?.text).at(-1);
      lines.push(`• ${String(t.id)} — ${state}\n  آخر رسالة: ${String(last?.text ?? t.text ?? "").slice(0, 100)}`);
    }
    lines.push("", "لإنهاء وضع الدعم الحالي: /exitsupport");
    return textPlan(lines.join("\n"));
  }

  async function suggestionsListPlan(psid) {
    if (isAdmin && !isAdmin(psid)) {
      return textPlan("✏️ لاقتراح كلمة جديدة استخدم /suggestword <الكلمة — المعنى>.");
    }
    const list = (await storeGet("msgr:suggestions", [])) || [];
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return textPlan("📭 لا توجد اقتراحات محفوظة بعد.");
    return textPlan([
      `💡 اقتراحات الكلمات (${arr.length}):`,
      ...arr.slice(-20).reverse().map((s, i) => `${i + 1}. ${String(s.text ?? "").slice(0, 100)} — ${String(s.userId ?? "")}`),
    ].join("\n"));
  }

  async function alertsPlan(psid) {
    if (isAdmin && !isAdmin(psid)) return textPlan("⛔ هذا الأمر للأدمن فقط.");
    const state = (await storeGet("msgr:alerts", {})) || {};
    let errCount = null;
    try {
      const errors = await listErrors?.();
      if (Array.isArray(errors)) errCount = errors.length;
    } catch {
      errCount = null;
    }
    const ago = (at) => (at ? `آخر تنبيه منذ ${Math.round((Date.now() - Number(at)) / 60000)} دقيقة` : "لم يُرسل بعد");
    return textPlan([
      "🚨 حالة التنبيهات الذكية",
      "",
      `• errors: ${ago(state.errors)}`,
      `• sync: ${ago(state.sync)}`,
      `• quota: ${ago(state.quota)}`,
      "",
      `أخطاء مسجلة (آخر 50): ${errCount ?? "—"}`,
      "فترة التبريد بين التنبيهات: 30 دقيقة لكل نوع.",
    ].join("\n"));
  }

  async function runUserCommand(cmd, arg = "", senderId = null) {
    const psid = String(senderId ?? "");
    const a = String(arg ?? "").trim();
    try {
      if (PARKED_DISPATCH_COMMANDS.has(cmd)) {
        return textPlan(PARKED_DISPATCH_MESSAGES[cmd]);
      }
      switch (cmd) {
        case "search":
          return textPlan("🔍 أرسل الكلمة التي تريد البحث عنها.");
        case "random":
        case "randomword": {
          const record = randomRecord();
          if (!record) return textPlan("⚠️ لا توجد كلمات متاحة حاليًا.");
          return wordCard ? await wordCard(record, psid) : textPlan(stripMarks(record.coptic));
        }
        case "wordsearch":
          return wordSearchPlan(a);
        case "wordinfo":
          return wordInfoPlan(a);
        case "translate":
          if (!a) return textPlan("✏️ الاستخدام: /translate <كلمة> — كل التراجم.");
          return htmlPlan(translateText(a));
        case "similar":
          if (!a) return textPlan("✏️ الاستخدام: /similar <كلمة> — كلمات شقيقة.");
          return htmlPlan(similarText(a));
        case "startswith":
          if (!a) return textPlan("✏️ الاستخدام: /startswith <حرف أو مقطع> — مثل: /startswith ⲫ");
          return htmlPlan(startsWithText(a));
        case "longest":
          return htmlPlan(longestText());
        case "letterstats":
          return htmlPlan(letterStatsText());
        case "alphabet":
          return htmlPlan(alphabetText());
        case "copticdate":
          return htmlPlan(copticDateNow(new Date()));
        case "origins":
          return htmlPlan(originsText());
        case "vocab":
          return htmlPlan(vocabText());
        case "pronounce":
          return pronouncePlan(a);
        case "voiceoff": {
          const record = await loadUser(psid);
          await saveUser(psid, { ...record, voiceOff: true });
          return textPlan("🔇 لن يُرسل النطق تلقائيًا مع نتائج البحث بعد الآن. للتشغيل: /voiceon");
        }
        case "voiceon": {
          const record = await loadUser(psid);
          const { voiceOff, ...rest } = record;
          void voiceOff;
          await saveUser(psid, rest);
          return textPlan("🔊 سيعود إرسال النطق تلقائيًا مع نتائج البحث.");
        }
        case "voiceonce": {
          const record = await loadUser(psid);
          await saveUser(psid, { ...record, voiceRepeats: 1 });
          return textPlan("🔊 تم: النطق المُولَّد سيُرسل مرة واحدة. (الأصوات المسجلة تبقى كما هي.)");
        }
        case "voicethree": {
          const record = await loadUser(psid);
          await saveUser(psid, { ...record, voiceRepeats: 3 });
          return textPlan("🔊 تم: النطق المُولَّد سيُرسل 3 مرات.");
        }
        case "voicesettings": {
          const record = await loadUser(psid);
          return textPlan([
            "🔊 إعدادات الصوت",
            "",
            `النطق التلقائي: ${record.voiceOff ? "متوقف" : "يعمل"}`,
            `التكرار الحالي للنطق المُولَّد: ${record.voiceRepeats === 1 ? "مرة واحدة" : "3 مرات"}`,
            "(الأصوات البشرية المسجلة تبقى كما هي.)",
            "للتبديل: /voiceon أو /voiceoff • /voiceonce أو /voicethree",
          ].join("\n"));
        }
        case "daily":
          return dailyPlan(psid);
        case "wod":
        case "wordoftheday": {
          const record = wodRecord();
          if (!record) return textPlan("⚠️ كلمة اليوم غير متاحة حاليًا.");
          return wordCard ? await wordCard(record, psid) : textPlan(stripMarks(record.coptic));
        }
        case "fav": {
          const history = await loadHistory(psid);
          const lastQuery = history[0] ?? "";
          const hit = lastQuery ? quickLookup(lastQuery) : null;
          if (!hit) return textPlan("⭐ ابحث عن كلمة أولًا ثم أرسل /fav لحفظها في مفضلتك.");
          const { record, favs } = await favoritesOf(psid);
          const word = stripMarks(hit.coptic);
          if (favs.some((f) => favKey(f.word ?? "") === favKey(word))) {
            return textPlan("⭐ هذه الكلمة في مفضلتك بالفعل.");
          }
          const next = [...favs, { word, meaning: firstMeaning(hit), id: hit.id }];
          await saveUser(psid, { ...record, favorites: next.slice(-FAVORITES_MAX) });
          return textPlan(`⭐ تمت إضافة «${word}» إلى مفضلتك. اعرضها بـ /myfav`);
        }
        case "favorites":
        case "myfav":
        case "mywords": {
          if (a) {
            const { record, favs } = await favoritesOf(psid);
            const target = favKey(a);
            const next = favs.filter((f) => favKey(f.word ?? "") !== target);
            await saveUser(psid, { ...record, favorites: next });
            return textPlan(next.length < favs.length ? `🗑 حُذفت «${a.slice(0, 60)}» من المفضلة.` : "هذه الكلمة ليست في مفضلتك.");
          }
          const { favs } = await favoritesOf(psid);
          if (!favs.length) return textPlan("مفضلتك فارغة. ابحث عن كلمة ثم أرسل /fav لحفظها.");
          return textPlan(favoritesListText(favs));
        }
        case "removefav": {
          if (!a) return textPlan("✏️ الاستخدام: /removefav <الكلمة> — أو من قائمة المفضلة أرسل /myfav <الكلمة>.");
          const { record, favs } = await favoritesOf(psid);
          const target = favKey(a);
          const next = favs.filter((f) => favKey(f.word ?? "") !== target);
          await saveUser(psid, { ...record, favorites: next });
          return textPlan(next.length < favs.length ? `🗑 حُذفت «${a.slice(0, 60)}» من المفضلة.` : "هذه الكلمة ليست في مفضلتك.");
        }
        case "mystats":
          return myStatsPlan(psid);
        case "recent": {
          const history = await loadHistory(psid);
          if (!history.length) return textPlan("لا توجد عمليات بحث محفوظة بعد.");
          return textPlan(["🕘 آخر عمليات بحثك", "", ...history.slice(0, 15).map((q) => `• ${q.slice(0, 60)}`)].join("\n"));
        }
        case "subscribe": {
          const record = await loadUser(psid);
          await saveUser(psid, { ...record, wodSub: true });
          return textPlan("🔔 تم اشتراكك في كلمة اليوم. ستستلمها تلقائيًا.");
        }
        case "unsubscribe": {
          const record = await loadUser(psid);
          await saveUser(psid, { ...record, wodSub: false });
          return textPlan("🔕 تم إلغاء اشتراكك في كلمة اليوم.");
        }
        case "notify": {
          const on = !/off|0|false/i.test(a);
          const record = await loadUser(psid);
          await saveUser(psid, { ...record, notify: on });
          return textPlan(on ? "🔔 فعّلت الإشعارات." : "🔕 أوقفت الإشعارات.");
        }
        case "clearhistory": {
          const history = await loadHistory(psid);
          await clearHistory?.(psid);
          return textPlan(history.length ? "🧹 تم مسح سجل عمليات بحثك." : "سجل بحثك فارغ أصلًا.");
        }
        case "mytickets":
          return myTicketsPlan(psid);
        case "suggestword":
        case "contribute": {
          if (!a) return textPlan("✏️ اكتب اقتراحك: /contribute الكلمة القبطية — المعنى. سيُراجعها الأدمن.");
          const list = (await storeGet("msgr:suggestions", [])) || [];
          const arr = Array.isArray(list) ? list : [];
          arr.push({ userId: psid, text: a.slice(0, 500), at: Date.now() });
          await storePut("msgr:suggestions", arr.slice(-200));
          const extra = firstAdminPsid
            ? { task: { type: "send-dm", to: String(firstAdminPsid), text: `💡 مساهمة جديدة من ${psid}:\n${a.slice(0, 500)}`, from: psid } }
            : {};
          return textPlan("✅ تم استلام مساهمتك وسيُراجعها الأدمن. شكرًا لإثرائك القاموس!", extra);
        }
        case "suggestions":
          return suggestionsListPlan(psid);
        case "invite":
          return textPlan(`🔗 شارك البوت مع أصدقائك:\n${MESSENGER_PAGE_URL}\nافتح الرابط ثم اضغط «مراسلة» لبدء المحادثة.`);
        case "myref":
          return textPlan([
            "🔗 رابط الدعوة الخاص بك",
            MESSENGER_PAGE_URL,
            "شاركه مع الأصدقاء ليتعلموا القبطية معك!",
            "الأصدقاء المدعوون: غير متاح على ماسنجر بعد — الإحالات تُحسب في تيليجرام فقط.",
          ].join("\n"));
        case "toptop":
          return textPlan("🏆 قائمة أفضل الدعاة غير مبنية على ماسنجر — الإحالات تُحسب في تيليجرام فقط.");
        case "refinfo": {
          if (isAdmin && !isAdmin(psid)) return textPlan("⛔ هذا الأمر للأدمن فقط.");
          return textPlan("ℹ️ تفاصيل الإحالات غير متاحة على ماسنجر — لا يوجد سجل إحالات هنا.");
        }
        case "alerts":
          return alertsPlan(psid);
        case "exitsupport": {
          try {
            await adminStore?.del?.(`msgr:supportflow:${psid}`);
          } catch {
            /* already clear */
          }
          return textPlan("✅ تم إنهاء وضع الدعم. يمكنك الآن متابعة استخدام البوت طبيعيًا (البحث في القاموس).");
        }
        default:
          return null;
      }
    } catch {
      return textPlan("⚠️ حدث خطأ أثناء تنفيذ الأمر، جرّب مرة أخرى.");
    }
  }

  return runUserCommand;
}
