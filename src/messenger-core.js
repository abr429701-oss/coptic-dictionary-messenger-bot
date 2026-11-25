// src/messenger-core.js
//
// Shared helpers extracted verbatim from the Telegram bot's
// src/index.js (abr429701-oss/coptic-dictionary-bot, branch
// perf/usage-reduction @ ec2f169) — the Messenger-only Worker
// reuses the same search, card, user-state, Sheets/macro,
// exam-code and usage-counting logic. Only the Messenger
// dependency closure is here; Telegram-only code was left out.
//
// Two deliberate divergences from the original:
//  - notifyAdmins() is a no-op: this Worker has no Telegram admin
//    channel, so usage-alert DMs have nowhere to go.
//  - executeMessengerTask() has no /importlearn branch: that job
//    runs from the Telegram bot (see the generic fallback).

import records from "../data/dictionary.json" with { type: "json" };
import { parseCertCsv } from "./certificates.js";
import { extractCodePattern } from "./exam-pattern.js";
import { translateFieldValue } from "./field-translations.js";
import { GET_CODE_SHEET_ID } from "./getcode.js";
import { messengerTextMessage, messengerAttachmentMessage, sendMessengerMessage } from "./messenger.js";
import { levenshtein } from "./new-features.js";

// Usage-alert DMs go to the Telegram admin in the original bot;
// this Worker has no Telegram channel, so alerts are dropped.
async function notifyAdmins(env, text) { /* no Telegram admin channel on this Worker */ }

export const DEFAULT_ADMIN_IDS = "813894692";

export const ADMIN_AUDIT_KEY = "admin:audit:actions";

export const BROADCAST_CTRL_KEY = "broadcast:control";

// A broadcast is "running" from the moment its loop starts until it ends
// (set by executeMessengerTask, cleared in its finally). The scheduled
// tick reads this key so a due job waits behind a running broadcast
// instead of sending on top of it (queue-after-current).
export const BROADCAST_RUNNING_KEY = "broadcast:running";

// Scheduled broadcasts (see /schedule in messenger-parity.js): jobs live
// under this DO key; the 5-minute cron tick runs the due ones.
export const SCHEDULED_BROADCAST_KEY = "broadcast:scheduled";

export async function readAdminAudit(env) { if (!env.USERS) return []; const v = ((await storeCall(env, { op: "get", key: ADMIN_AUDIT_KEY })).value ?? []); return Array.isArray(v) ? v : []; }

export async function broadcastControlState(env) { if (!env.USERS) return { paused: false }; const v = ((await storeCall(env, { op: "get", key: BROADCAST_CTRL_KEY })).value ?? { paused: false }); return v && typeof v === "object" ? v : { paused: false }; }

export async function setBroadcastControl(env, state) { if (env.USERS) await storeCall(env, { op: "put", key: BROADCAST_CTRL_KEY, value: state }); }

export const FIRST_TIME_TEXT =
  "مرحبًا بك! يبدو أنك تستخدم البوت لأول مرة، الرجاء إدخال اسمك بدون رموز للبدء في استخدام القاموس القبطي الناطق.";

export const NAME_RETRY_TEXT = "الرجاء إدخال اسمك صحيحاً بالحروف فقط بدون رموز ولا أرقام.";

export const ACCENT_MAP = { ὲ: "ⲉ", έ: "ⲉ", ὶ: "ⲓ", ί: "ⲓ", ὸ: "ⲟ", ό: "ⲟ", ὼ: "ⲱ", ώ: "ⲱ", ὴ: "ⲏ", ή: "ⲏ", ὰ: "ⲁ", ά: "ⲁ", ὺ: "ⲩ", ύ: "ⲩ" };

export const ALEF_MAP = { أ: "ا", إ: "ا", آ: "ا", ٱ: "ا", ى: "ي", ة: "ه" };

export const PLAIN_ASCII = /^[\x20-\x5f\x61-\x7e]*$/u;

export const MARK_CHARS = /[\u0300-\u036f\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06edـ]/u;

export const MARK_CHARS_ALL = /[\u0300-\u036f\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06edـ]/gu;

export const FOLD_CHARS = /[أإآٱىةὲέὶίὸόὼώὴήὰάὺύ`]/u;

export const FOLD_CHARS_ALL = /[أإآٱىةὲέὶίὸόὼώὴήὰάὺύ`]/gu;

export const FOLD_MAP = { ...ALEF_MAP, ...ACCENT_MAP, "`": "" };

export const normalizeMemo = new Map();

export function normalize(value) {
  const text = String(value ?? "");
  const hit = normalizeMemo.get(text);
  if (hit !== undefined) return hit;
  const out = normalizeUncached(text);
  if (normalizeMemo.size > 5000) normalizeMemo.clear();
  normalizeMemo.set(text, out);
  return out;
}

export function normalizeUncached(value) {
  const text = String(value ?? "");
  if (PLAIN_ASCII.test(text)) return text.toLowerCase().replace(/\s+/gu, " ").trim();
  let out = text.normalize("NFKC").toLowerCase();
  if (MARK_CHARS.test(out)) out = out.replace(MARK_CHARS_ALL, "");
  if (FOLD_CHARS.test(out)) out = out.replace(FOLD_CHARS_ALL, (char) => FOLD_MAP[char] ?? "");
  return out.replace(/\s+/gu, " ").trim();
}

export const ARABIC_LETTER = /[\u0600-\u06ff]/u;

export const COPTIC_LETTER = /[\u2c80-\u2cff\u03e2-\u03ef]/u;

export const GREEK_LETTER = /[\u0370-\u03ff\u1f00-\u1fff]/u;

export const LATIN_LETTER = /[a-z]/iu;

export function toTokens(normalized) {
  return normalized.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
}

export function tokens(value) {
  return toTokens(normalize(value));
}

export function hasWholeWords(text, needle) {
  return needle !== "" && ` ${text} `.includes(` ${needle} `);
}

export const UI_TEXT = {
  ar: { word: "الكلمة", meaning: "المعنى", kind: "النوع", origin: "الأصل", more: "هناك معنى آخر للكلمة التي بحثت بها", next: "اضغط هنا لعرضه", end: "انتهت المعاني المتاحة لهذه الكلمة", choose: "اختر من الاقتراحات التالية:", previous: "السابق", pageNext: "التالي", noResult: "لا توجد نتائج حالياً لهذه الكلمة.", didYouMean: "🤔 هل تقصد:" },
  en: { word: "Word", meaning: "Meaning", kind: "Part of speech", origin: "Origin", more: "There is another meaning for the word you searched", next: "Click here to view it", end: "No more meanings are available for this word", choose: "Choose from the following suggestions:", previous: "Previous", pageNext: "Next", noResult: "No results are currently available for this word.", didYouMean: "🤔 Did you mean:" },
  fr: { word: "Mot", meaning: "Sens", kind: "Nature", origin: "Origine", more: "Il existe un autre sens pour le mot recherché", next: "Cliquez ici pour l’afficher", end: "Il n’y a plus de sens disponible pour ce mot", choose: "Choisissez parmi les suggestions suivantes :", previous: "Précédent", pageNext: "Suivant", noResult: "Aucun résultat n’est actuellement disponible pour ce mot.", didYouMean: "🤔 Vouliez-vous dire :" },
  de: { word: "Wort", meaning: "Bedeutung", kind: "Wortart", origin: "Herkunft", more: "Es gibt eine weitere Bedeutung für das gesuchte Wort", next: "Hier klicken, um sie anzuzeigen", end: "Für dieses Wort sind keine weiteren Bedeutungen verfügbar", choose: "Wählen Sie aus den folgenden Vorschlägen:", previous: "Zurück", pageNext: "Weiter", noResult: "Derzeit sind keine Ergebnisse für dieses Wort verfügbar.", didYouMean: "🤔 Meinten Sie:" },
};

export function uiLanguage(searchKey = "") {
  const kind = searchKey ? scriptKind(normalize(searchKey)) : "ar";
  if (kind === "el") return "en";
  return UI_TEXT[kind] ? kind : "ar";
}

export function uiTextFor(searchKey = "") {
  return UI_TEXT[uiLanguage(searchKey)] ?? UI_TEXT.ar;
}

export function localizedValue(value, language) {
  return translateFieldValue(value, language);
}

export function splitMeaning(value) {
  return String(value ?? "").split(/\s*[،,]\s*/u).map((part) => part.trim()).filter(Boolean);
}

export const SCRIPT_KIND_CACHE = new Map();

export function matchedPartIndex(record, normalizedQuery) {
  if (!ARABIC_LETTER.test(normalizedQuery)) return -1;
  const needle = tokens(normalizedQuery);
  const parts = splitMeaning(record.meaning);
  const exact = parts.findIndex((part) => tokens(part) === needle);
  if (exact >= 0) return exact;
  return parts.findIndex((part) => normalize(part).startsWith(normalizedQuery) || hasWholeWords(tokens(part), needle));
}

// Meaning options for one word card, Telegram/WhatsApp parity: one
// meaning part per option, starting from the part the query matched
// (or part 0). The card shows options[step] and steps through the
// rest with "معنى آخر" — one meaning at a time, never all parts
// joined on one card. Within one record only.
export function meaningOptions(record, normalizedQuery = "", preferredPart = -1) {
  if (!record) return [];
  const options = [];
  const add = (part) => {
    const partText = splitMeaning(record.meaning)[part] ?? "";
    const key = normalize(partText) || `0:${part}`;
    if (!options.some((item) => item.key === key)) options.push({ key, part });
  };
  const firstPart = preferredPart >= 0 ? preferredPart : matchedPartIndex(record, normalizedQuery);
  if (firstPart >= 0) add(firstPart);
  else if (splitMeaning(record.meaning).length) add(0);
  const parts = splitMeaning(record.meaning);
  for (let part = 0; part < parts.length; part += 1) add(part);
  return options;
}

export function suggestionLabel(record, normalizedQuery) {
  if (ARABIC_LETTER.test(normalizedQuery)) {
    const part = matchedPartIndex(record, normalizedQuery);
    const meanings = splitMeaning(record.meaning);
    return (meanings[part >= 0 ? part : 0] || meanings[0] || record.english || "—").trim().slice(0, 48);
  }
  if (COPTIC_LETTER.test(normalizedQuery)) return String(record.coptic ?? "").replaceAll("`", "").trim().slice(0, 48) || "—";
  const kind = scriptKind(normalizedQuery);
  if (kind === "el") return String(record.greek ?? "").replaceAll("`", "").trim().slice(0, 48) || "—";
  if (kind === "fr") return String(record.translation_fr ?? "").trim().slice(0, 48) || "—";
  if (kind === "de") return String(record.translation_de ?? "").trim().slice(0, 48) || "—";
  if (kind === "en") return String(record.english ?? "").trim().slice(0, 48) || "—";
  return String(record.greek ?? record.coptic ?? record.english ?? "—").replaceAll("`", "").trim().slice(0, 48);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatRecord(record, partIndex = -1, searchedWord = "") {
  const parts = splitMeaning(record.meaning);
  const arabicPart = partIndex >= 0 && parts[partIndex] ? parts[partIndex] : parts.join("، ");
  // Show the user's searched word first. Any non-Coptic search (Arabic,
  // English, Greek, etc.) must show the Coptic headword as its counterpart;
  // only a Coptic search shows the Arabic meaning parts.
  const isCopticSearch = searchedWord === "" || scriptKind(normalize(searchedWord)) === "cop";
  const language = isCopticSearch ? "ar" : uiLanguage(searchedWord);
  const labels = UI_TEXT[language] ?? UI_TEXT.ar;
  // Headword shown to the user:
  //   - Coptic search -> the dictionary Coptic spelling (keeps jinkim/diacritics)
  //   - Arabic search -> the matching Arabic meaning FROM THE SHEET (keeps full tashkeel),
  //     not the user's bare typed query
  //   - other languages -> the user's typed query
  const displayedWord = isCopticSearch
    ? String(record.coptic ?? "").trim() || searchedWord
    : (language === "ar" ? arabicPart : searchedWord) || record.coptic;
  const fields = !isCopticSearch
    ? [
        [labels.word, displayedWord],
        [labels.meaning, record.coptic],
        [labels.kind, localizedValue(record.kind, language)],
        [labels.origin, localizedValue(record.origin, language)],
      ]
    : [
        [UI_TEXT.ar.word, displayedWord],
        [UI_TEXT.ar.meaning, arabicPart],
        [UI_TEXT.ar.kind, record.kind],
        [UI_TEXT.ar.origin, record.origin],
      ];
  const lines = [];
  for (const [label, raw] of fields) {
    const value = String(raw ?? "").trim();
    if (value) lines.push(`<b>${label}:</b> ${escapeHtml(value)}`);
  }
  return lines.join("\n");
}

export function scriptKind(key) {
  if (ARABIC_LETTER.test(key)) return "ar";
  if (COPTIC_LETTER.test(key)) return "cop";
  if (GREEK_LETTER.test(key)) return "el";
  if (LATIN_LETTER.test(key)) {
    const normalized = normalize(key);
    return SCRIPT_KIND_CACHE.get(normalized) ?? "en";
  }
  return "other";
}

export const DRIVE_CONFIG_KEY = "drive-config";

export const perStoreCacheObjects = new Set();

export const driveConfigCaches = new WeakMap();

export function perStoreCache(map, env) {
  if (!env.USERS) return { value: null, at: 0 };
  let slot = map.get(env.USERS);
  if (!slot) { slot = { value: null, at: 0 }; map.set(env.USERS, slot); perStoreCacheObjects.add(slot); }
  return slot;
}

export async function driveConfig(env) {
  // An explicit admin /setdrive URL is an override; the repository secret is only the fallback.
  if (env.USERS) {
    const saved = await cachedDoGet(env, DRIVE_CONFIG_KEY, perStoreCache(driveConfigCaches, env), null);
    if (saved?.url) return saved;
  }
  return env.APPS_SCRIPT_URL ? { url: env.APPS_SCRIPT_URL } : null;
}

export async function callAppsScript(config, payload) {
  const response = await fetch(config.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    // Apps Script answers with an HTML page when the deployment is missing, private or outdated.
    throw new Error(`Apps Script returned ${response.status} (not JSON): check Deploy > New version and "Anyone" access`);
  }
  if (!response.ok || !result.ok) throw new Error(result.error || `Apps Script failed: ${response.status}`);
  return result;
}

export async function inBackground(ctx, work) {
  if (ctx?.waitUntil) {
    ctx.waitUntil(work.catch((error) => console.error("Background task failed", error instanceof Error ? error.message : "unknown error")));
    return;
  }
  await work;
}

export function sameSecret(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export async function storeCall(env, payload) {
  // In-DO direct path (poller): same storage API, no stub.fetch round trip,
  // so no Durable Object request is spent. Every other caller goes through
  // the binding exactly as before.
  if (env.__directStore) return env.__directStore.handle(payload);
  const stub = env.USERS.get(env.USERS.idFromName("users"));
  const response = await stub.fetch("https://user-store/", { method: "POST", body: JSON.stringify(payload) });
  return response.json();
}

export const USER_MEMO_TTL_MS = 5000;

export const userMemoByStore = new WeakMap();

export function userMemoFor(env) {
  if (!env.USERS) return null;
  let memo = userMemoByStore.get(env.USERS);
  if (!memo) { memo = new Map(); userMemoByStore.set(env.USERS, memo); }
  return memo;
}

export async function getUser(env, userId) {
  if (!env.USERS) return null;
  const key = String(userId);
  const memo = userMemoFor(env);
  const hit = memo?.get(key);
  if (hit && Date.now() - hit.at < USER_MEMO_TTL_MS) return hit.record === null ? null : { ...hit.record };
  try {
    const value = (await storeCall(env, { op: "get", key: `user:${key}` })).value ?? null;
    memo?.set(key, { record: value, at: Date.now() });
    return value === null ? null : { ...value };
  } catch (error) {
    console.error("User lookup failed", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

export async function saveUser(env, userId, data) {
  if (!env.USERS) return false;
  try {
    await storeCall(env, { op: "put", key: `user:${userId}`, value: data });
    userMemoFor(env)?.set(String(userId), { record: data, at: Date.now() });
    return true;
  } catch (error) {
    console.error("User save failed", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

export function isValidFullName(value) {
  const name = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (name.length < 2 || name.length > 60) return false;
  // Letters and combining marks only (any language), spaces allowed; no digits, no symbols.
  return /^[\p{L}\p{M} ]+$/u.test(name);
}

export function userSheetRow(id, record, from = {}) {
  const tgName = record?.tgName || displayNameOrEmpty(from);
  return {
    id: String(id),
    name: record?.name || tgName || "",
    username: record?.username || from?.username || "",
    joined_at: record?.firstSeen ?? "",
    registered_at: record?.registeredAt ?? "",
    blocked: record?.blocked === true,
    blocked_at: record?.blockedAt ?? "",
  };
}

export function displayNameOrEmpty(person) {
  return [person?.first_name, person?.last_name].filter(Boolean).join(" ").trim();
}

export const USER_PUSH_CHUNK = 120;

export async function pushUsers(env, rows) {
  const config = await driveConfig(env);
  if (!config || !rows.length) return { ok: false, skipped: true };
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      for (let i = 0; i < rows.length; i += USER_PUSH_CHUNK) {
        await callAppsScript(config, { action: "users", users: rows.slice(i, i + USER_PUSH_CHUNK) });
      }
      return { ok: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown error";
      console.error("User sheet sync failed", lastError);
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  return { ok: false, error: lastError };
}

export const DAILY_REQUEST_LIMIT = 100000;

export const USAGE_FLUSH_EVERY = 20;

export const USAGE_FLUSH_MS = 60000;

export const usageState = { day: "", pending: 0, flushedAt: 0, byPath: {} };

export function usageKindForPath(pathname) {
  const path = String(pathname ?? "");
  if (path === "/cert") return "cert";
  if (path === "/exam-pattern") return "exam";
  if (path === "/checkcode") return "checkcode";
  if (path === "/getcode") return "getcode";
  if (path === "/health") return "health";
  if (path.startsWith("/media/") || path.startsWith("/video/")) return "media";
  if (path === "/webhook") return "webhook";
  if (path === "/messenger-webhook") return "messenger";
  if (path === "/api/dictionary") return "api";
  if (path === "/voice-drive") return "voice";
  if (path === "/export-voices" || path.startsWith("/export-voice/")) return "export";
  if (path === "/__learn-import") return "import";
  if (path === "/__setup") return "setup";
  if (path === "/") return "root";
  return "other";
}

export async function readAnalyticsReport(env) {
  const persisted = env.USERS ? ((await storeCall(env, { op: "get", key: "analytics:snapshot" })).value ?? null) : null;
  const top = new Map(persisted?.topWords ?? []);
  for (const [word, count] of analyticsState.topWords) top.set(word, (top.get(word) ?? 0) + count);
  return {
    searches: (persisted?.searches ?? 0) + analyticsState.searches,
    commands: (persisted?.commands ?? 0) + analyticsState.commands,
    inline: (persisted?.inline ?? 0) + analyticsState.inline,
    topWords: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    updatedAt: persisted?.updatedAt ?? null,
  };
}

export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export const ADMIN_CACHE_TTL = 60000;

export const bansCache = { value: null, at: 0 };

export const welcomeCache = { value: null, at: 0 };

export const SAFETY_CACHE_TTL = 15000;

export const cacheInflight = new Map();

export const cacheVersions = new Map();

export async function cachedDoGet(env, key, cache, fallback = null, ttl = ADMIN_CACHE_TTL) {
  const now = Date.now();
  // A loaded entry stays fresh until its TTL passes — including null. The
  // old guard returned only non-null values, so null settings were re-read
  // from the DO on every call, and non-null values were served stale forever.
  if (cache.at !== 0 && now - cache.at < ttl) return cache.value;
  const pending = cacheInflight.get(cache);
  if (pending) return pending;
  const job = (async () => {
    const version = cacheVersions.get(cache) ?? 0;
    let value = fallback;
    if (env.USERS) { try { value = (await storeCall(env, { op: "get", key })).value ?? fallback; } catch { value = fallback; } }
    if ((cacheVersions.get(cache) ?? 0) === version) { cache.value = value; cache.at = Date.now(); }
    return value;
  })();
  cacheInflight.set(cache, job);
  try { return await job; } finally { cacheInflight.delete(cache); }
}

export function invalidateCache(cache) { cache.value = null; cache.at = 0; cacheVersions.set(cache, (cacheVersions.get(cache) ?? 0) + 1); }

export async function bannedSet(env) {
  const obj = await cachedDoGet(env, "bans:list", bansCache, {}, SAFETY_CACHE_TTL);
  return obj && typeof obj === "object" ? obj : {};
}

export async function isBanned(env, userId) {
  const entry = (await bannedSet(env))[String(userId)];
  if (!entry) return false;
  // Temp bans expire on their own: first check after expiry lifts the ban.
  if (entry.until && new Date(entry.until).getTime() < Date.now()) { await unbanUser(env, userId); return false; }
  return true;
}

export async function unbanUser(env, userId) {
  const set = await bannedSet(env);
  delete set[String(userId)];
  if (env.USERS) await storeCall(env, { op: "put", key: "bans:list", value: set });
  invalidateCache(bansCache);
  const user = (await getUser(env, userId)) ?? {};
  if (env.USERS && user) { const { blocked, blockedReason, bannedAt, ...rest } = user; await saveUser(env, userId, rest); }
}

export const DEFAULT_WELCOME_CAPTION = (name) => `مرحبًا بك ${escapeHtml(name)}، في القاموس القبطي الناطق، تفضل الان بكتابة أي كلمة للبحث عنها.`;

export async function getWelcomeCaption(env, name) {
  const custom = await cachedDoGet(env, "welcome:caption", welcomeCache, null);
  if (typeof custom === "string" && custom.trim()) return custom.replaceAll("{name}", escapeHtml(name));
  return DEFAULT_WELCOME_CAPTION(name);
}

export async function readMisses(env) {
  const persisted = env.USERS ? ((await storeCall(env, { op: "get", key: "misses:snapshot" })).value ?? {}) : {};
  const merged = new Map(Object.entries(persisted));
  for (const [word, count] of missLog) merged.set(word, (merged.get(word) ?? 0) + count);
  return [...merged.entries()].sort((a, b) => b[1] - a[1]);
}

export const errorLog = [];

export const ERROR_LOG_MAX = 50;

export function logError(env, error, context = {}) {
  const entry = { at: new Date().toISOString(), message: error instanceof Error ? error.message : String(error ?? "unknown"), stack: error instanceof Error ? String(error.stack ?? "").slice(0, 400) : "", ...context };
  errorLog.push(entry);
  if (errorLog.length > ERROR_LOG_MAX) errorLog.shift();
  console.error("captured error", JSON.stringify(entry).slice(0, 500));
}

export const userHistory = new Map();

export async function getUserHistory(env, userId) {
  const key = String(userId);
  let persisted = [];
  if (env.USERS) {
    const fresh = ((await storeCall(env, { op: "get", key: `history:${key}` })).value ?? null);
    if (Array.isArray(fresh) && fresh.length) persisted = fresh;
    else {
      // Legacy fallback: entries still in the old global snapshot.
      persisted = ((await storeCall(env, { op: "get", key: "history:snapshot" })).value ?? {})[key] ?? [];
    }
  }
  return [...persisted, ...(userHistory.get(key) ?? [])].slice(-20).reverse();
}

export function dictionaryStats(voiceIds = new Set()) {
  const byKind = new Map(); const byOrigin = new Map(); let missingVoice = 0; let withVoice = 0;
  for (const record of records) {
    if (record._deleted) continue;
    byKind.set(String(record.kind ?? "—"), (byKind.get(String(record.kind ?? "—")) ?? 0) + 1);
    byOrigin.set(String(record.origin ?? "—"), (byOrigin.get(String(record.origin ?? "—")) ?? 0) + 1);
    if (record.id != null && voiceIds.has(Number(record.id))) withVoice += 1; else missingVoice += 1;
  }
  const top = [...records].filter((r) => !r._deleted).sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0)).slice(0, 10);
  return { total: records.filter((r) => !r._deleted).length, byKind: [...byKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8), byOrigin: [...byOrigin.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8), withVoice, missingVoice, recent: top };
}

export function findDuplicates() {
  const byCoptic = new Map();
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record._deleted) continue;
    const key = normalize(record.coptic);
    if (!key) continue;
    (byCoptic.get(key) ?? byCoptic.set(key, []).get(key)).push({ index: i, coptic: record.coptic, meaning: String(record.meaning ?? "").slice(0, 40), row: i + 2 });
  }
  return [...byCoptic.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length).slice(0, 15);
}

export async function flushUsage(env, day, count, byPath) {
  try {
    const result = await storeCall(env, { op: "usage", profile: { day }, limit: count, detail: { byPath: byPath ?? {} } });
    if (result?.alert) {
      const percent = Math.round((result.total / DAILY_REQUEST_LIMIT) * 100);
      await notifyAdmins(env, `⚠️ <b>تنبيه الاستخدام</b>\nوصلت طلبات اليوم إلى ${Number(result.total).toLocaleString("en-US")} من ${DAILY_REQUEST_LIMIT.toLocaleString("en-US")} (${percent}%).\nعند الوصول للحد يتوقف البوت حتى تصفير العدّاد. أرسل /usage للتفاصيل.`);
    }
  } catch (error) {
    console.error("Usage count failed", error instanceof Error ? error.message : "unknown error");
  }
}

export function countRequest(env, ctx, pathname) {
  if (!env.USERS) return;
  const day = utcDay();
  const now = Date.now();
  const kind = usageKindForPath(pathname);
  if (usageState.day && usageState.day !== day && usageState.pending) {
    const previous = { day: usageState.day, count: usageState.pending, byPath: usageState.byPath };
    usageState.pending = 0;
    usageState.byPath = {};
    inBackground(ctx, flushUsage(env, previous.day, previous.count, previous.byPath));
  }
  usageState.day = day;
  usageState.pending += 1;
  usageState.byPath[kind] = (usageState.byPath[kind] ?? 0) + 1;
  if (usageState.pending >= USAGE_FLUSH_EVERY || now - usageState.flushedAt >= USAGE_FLUSH_MS) {
    const count = usageState.pending;
    const byPath = usageState.byPath;
    usageState.pending = 0;
    usageState.byPath = {};
    usageState.flushedAt = now;
    inBackground(ctx, flushUsage(env, day, count, byPath));
  }
}

export const DICTIONARY_LOCAL_FIELDS = ["coptic", "pronunciation", "meaning", "english", "translation_fr", "translation_de", "greek", null, null, "origin", "kind"];

export const DICTIONARY_LOCAL_HEADERS = ["coptic", "ipa", "meaning", "english", "french", "german", "greek", "unused_h", "unused_i", "origin", "kind"];

export function localDictionaryCandidates(word, limit = 8) {
  const wanted = normalize(word);
  if (!wanted) return { ok: false, error: "word is required", candidates: [] };
  const exact = [];
  const partial = [];
  const fuzzy = [];
  const fuzzyMax = wanted.length <= 4 ? 1 : wanted.length <= 8 ? 2 : 3;
  const seenRows = new Set();
  const pushCandidate = (bucket, index, column, values, matchType, score) => {
    const row = index + 2;
    if (seenRows.has(row)) return;
    seenRows.add(row);
    bucket.push({ row, matched_column: column, headers: DICTIONARY_LOCAL_HEADERS, values, matchType, score });
  };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record._deleted) continue;
    const values = DICTIONARY_LOCAL_FIELDS.map((field) => (field ? String(record?.[field] ?? "") : ""));
    for (let column = 0; column < values.length; column += 1) {
      const cell = normalize(values[column]);
      if (!cell) continue;
      if (cell === wanted) { pushCandidate(exact, index, column, values, "exact", 0); break; }
      if (cell.includes(wanted) || wanted.includes(cell)) {
        const score = Math.abs(cell.length - wanted.length);
        pushCandidate(partial, index, column, values, "partial", score);
      } else {
        const dist = levenshtein(cell, wanted, fuzzyMax);
        if (dist !== Infinity) pushCandidate(fuzzy, index, column, values, "fuzzy", dist);
      }
    }
    if (exact.length >= limit) break;
  }
  partial.sort((a, b) => a.score - b.score);
  fuzzy.sort((a, b) => a.score - b.score);
  const candidates = [...exact, ...partial, ...fuzzy].slice(0, limit);
  return { ok: candidates.length > 0, candidates, exactCount: exact.length };
}

export const CODE_SHEET_CACHE_TTL_MS = 60 * 1000;

export let codeSheetCache = null;

export async function lookupCodeName(code) {
  const now = Date.now();
  if (codeSheetCache && now - codeSheetCache.fetchedAt < CODE_SHEET_CACHE_TTL_MS) {
    return codeSheetCache.names.get(code) ?? null;
  }
  let resp;
  try {
    resp = await fetch(`https://docs.google.com/spreadsheets/d/${GET_CODE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=code`, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    if (codeSheetCache) return codeSheetCache.names.get(code) ?? null;
    throw new Error("sheet-unreachable");
  }
  if (!resp.ok) {
    if (codeSheetCache) return codeSheetCache.names.get(code) ?? null;
    throw new Error("sheet-unreachable");
  }
  const rows = parseCertCsv(await resp.text());
  const names = new Map();
  for (const row of rows) {
    const c = String(row[0] ?? "").trim();
    const n = String(row[1] ?? "").trim();
    if (!c || !n) continue;
    if (c === "الرقم الكودي" || n === "الاسم ثلاثي") continue; // header row
    if (!/[A-Za-z\u0600-\u06FF]/u.test(n)) continue; // junk row (no letter in the name)
    names.set(c, n);
  }
  codeSheetCache = { fetchedAt: now, names };
  return names.get(code) ?? null;
}

export const EXAM_FORM_IDS = new Set([
  "1Gts_xgdk3-g7elOTmSXtpouZMvFVLwdQ4fleO3usLYg",
  "1CFJ443YBu6a7oSBHV3vYQtkhJ8whTmKdTTWnf4fybkw",
  "12Sdfv6FQe7Lr7LcXI3PLrxsp1g6ieeZuS94cvEUIgJo",
  "1DAYdD2pdtifeChZP9ChBGo4UV9fdJMkX7cRkwQ7zA7Q",
  "1V8g6OpY12ewvSm2WEbJi2NFs1xu9bUg6AEaBSG0UYjU",
  "1Ag4v_pX0xzh7BlBGFbzeBeAfFe2fo2oh__RkAQw6DUg",
  "1bqoBpekkfa2_6oc-nwCdbOui5LDpRuVDCo7DaC1oi9o",
  "1MiFcNOZwsIAptfRrSjl29Cpccf7SHoaSFBtZCfC1mLc",
  "1ST9Nk2pWFjC_Sf_XfpW3wWgEaEq4gbT6r2fXN8mHqPc",
  "1hU9u45-62silHgZiehAneS0W7Ud6v-kpdEn9KkYYG78",
  "1ZABUJwB07YtSWAWwpbMFWKfAc8krqlomf3bP-MNFDyY",
  "1TF4YmrO2jIgdageOz-YOo9CAWMxheVd1MDnnFkp3vLU",
]);

export const EXAM_PATTERN_CACHE_TTL_MS = 5 * 60 * 1000;

export const examPatternCache = new Map();

export async function fetchLiveExamPattern(formId) {
  const now = Date.now();
  const hit = examPatternCache.get(formId);
  if (hit && now - hit.fetchedAt < EXAM_PATTERN_CACHE_TTL_MS) return hit;
  const resp = await fetch(`https://docs.google.com/forms/d/${formId}/viewform`, {
    headers: { "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error("form-unreachable");
  const found = extractCodePattern(await resp.text());
  if (!found) throw new Error("no-code-question");
  const entry = { fetchedAt: now, ...found };
  examPatternCache.set(formId, entry);
  return entry;
}

export const MESSENGER_BROADCAST_GAP_MS = 2000;

export const MESSENGER_BROADCAST_MAX_FAILURES = 5;

export async function messengerBroadcastRecipients(env) {
  const out = [];
  if (!env.USERS) return out;
  let cursor = null;
  for (;;) {
    const page = await storeCall(env, { op: "userpage", limit: 200, ...(cursor ? { cursor } : {}) }).catch(() => null);
    if (!page) break;
    for (const { id, record } of page.users ?? []) {
      if (!String(id).startsWith("msgr:")) continue;
      if (record?.blocked) continue;
      out.push(String(id).slice("msgr:".length));
    }
    cursor = page.next;
    if (!cursor) break;
  }
  return out;
}

export async function executeMessengerTask(env, task, from, fetchImpl = globalThis.fetch, { gapMs = MESSENGER_BROADCAST_GAP_MS, ctx } = {}) {
  const sendText = (to, text) => sendMessengerMessage(env, to, messengerTextMessage(text), fetchImpl);
  const type = task?.type;
  if (type === "send-dm") {
    if (!task.to || !task.text) return false;
    return (await sendText(task.to, task.text)).ok;
  }
  if (type === "test-broadcast") {
    return (await sendText(task.from ?? from, task.text ?? "رسالة تجريبية من البث.")).ok;
  }
  if (type === "broadcast") {
    const control = await broadcastControlState(env).catch(() => ({ paused: false }));
    if (control?.paused) {
      await sendText(from, "⏸️ البث متوقف مؤقتًا (استخدم /bcresume لاستئنافه).");
      return false;
    }
    // Mark the broadcast running so a scheduled job queued behind it
    // waits (the tick checks BROADCAST_RUNNING_KEY first). Cleared in
    // the finally below, even when the loop breaks early.
    if (env.USERS) {
      await storeCall(env, { op: "put", key: BROADCAST_RUNNING_KEY, value: { startedAt: Date.now(), scheduledId: task.scheduledId ?? null, from: String(from ?? "") } }).catch(() => null);
    }
    const isScheduled = Boolean(task.scheduledId);
    const mediaUrl = typeof task.mediaUrl === "string" && task.mediaUrl ? task.mediaUrl : "";
    const mediaKind = task.mediaKind === "video" ? "video" : "image";
    const bodyText = typeof task.caption === "string" && task.caption
      ? task.caption
      : (typeof task.text === "string" ? task.text : "");
    const resumeFrom = Number.isFinite(task.resumeFrom) && task.resumeFrom > 0 ? Math.floor(task.resumeFrom) : 0;
    const resilient = task.resilient === true;
    const onProgress = typeof task.onProgress === "function" ? task.onProgress : null;
    const recipients = await messengerBroadcastRecipients(env);
    let sent = resumeFrom;
    let consecutiveFailures = 0;
    let loopIndex = 0;
    let completed = true;
    try {
      for (let i = resumeFrom; i < recipients.length; i++) {
        const psid = recipients[i];
        if (!resilient && consecutiveFailures >= MESSENGER_BROADCAST_MAX_FAILURES) { completed = false; break; }
        if (loopIndex > 0 && gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
        loopIndex += 1;
        let ok = true;
        if (mediaUrl) {
          const media = await sendMessengerMessage(env, psid, messengerAttachmentMessage(mediaKind, mediaUrl), fetchImpl);
          ok = media.ok;
        }
        if (ok && bodyText) {
          const result = await sendText(psid, bodyText);
          ok = result.ok;
        }
        if (ok) {
          sent += 1;
          consecutiveFailures = 0;
          if (onProgress && sent % 10 === 0) {
            try { await onProgress(sent); } catch { /* progress is best-effort */ }
          }
        } else {
          consecutiveFailures += 1;
        }
      }
    } finally {
      if (env.USERS) {
        await storeCall(env, { op: "put", key: BROADCAST_RUNNING_KEY, value: null }).catch(() => null);
      }
    }
    if (onProgress && sent % 10 !== 0) {
      try { await onProgress(sent); } catch { /* progress is best-effort */ }
    }
    if (!completed) {
      await sendText(from, `⏸ توقف البث بعد ${sent} من ${recipients.length} (أخطاء متتالية) — سيُستأنف تلقائيًا.`);
      return false;
    }
    await sendText(from, isScheduled
      ? `📢 اكتمل البث المجدول: أُرسل إلى ${sent} من ${recipients.length}.`
      : `📢 تم إرسال البث إلى ${sent} من ${recipients.length}.`);
    return true;
  }
  await sendText(from, `ℹ️ مهمة /${type} تُشغَّل من بوت تيليجرام (وتعمل تلقائيًا كل 30 دقيقة أيضًا).`);
  return false;
}

// Cron tick worker: run the earliest due scheduled broadcast, if any.
// Queue-after-current: when another broadcast is running
// (BROADCAST_RUNNING_KEY set), do nothing this tick — the job waits for
// the next tick. A job whose loop aborts early keeps its sent offset and
// resumes from it on the next tick; a finished job is removed. Returns
// true when a job was started, false otherwise.
export async function runDueScheduledBroadcasts(env, { fetchImpl = globalThis.fetch, gapMs = MESSENGER_BROADCAST_GAP_MS, adminPsid = null } = {}) {
  if (!env.USERS) return false;
  let jobs = [];
  try {
    const stored = (await storeCall(env, { op: "get", key: SCHEDULED_BROADCAST_KEY })).value ?? [];
    jobs = Array.isArray(stored) ? stored.filter((j) => j && typeof j.id === "string" && Number.isFinite(j.sendAt)) : [];
  } catch {
    return false;
  }
  const now = Date.now();
  const due = jobs.filter((j) => j.status !== "done" && j.sendAt <= now).sort((a, b) => a.sendAt - b.sendAt);
  if (!due.length) return false;
  let running = null;
  try { running = (await storeCall(env, { op: "get", key: BROADCAST_RUNNING_KEY })).value ?? null; } catch { running = null; }
  if (running) return false; // a broadcast is running — wait for the next tick
  const control = await broadcastControlState(env).catch(() => ({ paused: false }));
  if (control?.paused) return false; // paused — the job stays queued
  const job = due[0];
  const admin = adminPsid ?? null;
  const jobLabel = job.kind === "text"
    ? String(job.text ?? "").slice(0, 60)
    : job.kind === "video" ? "🎬 فيديو" : "📷 صورة";
  const recipients = await messengerBroadcastRecipients(env).catch(() => []);
  if (!recipients.length) {
    await storeCall(env, { op: "put", key: SCHEDULED_BROADCAST_KEY, value: jobs.filter((j) => j.id !== job.id) }).catch(() => null);
    if (admin) {
      await sendMessengerMessage(env, admin, messengerTextMessage(`⏰ حان ميعاد الرسالة المجدولة «${jobLabel}» — لا يوجد مستخدمون لإرسالها إليهم، فتم إلغاؤها.`), fetchImpl).catch(() => null);
    }
    return true;
  }
  const saveProgress = async (sent) => {
    const current = ((await storeCall(env, { op: "get", key: SCHEDULED_BROADCAST_KEY }).catch(() => null))?.value ?? []);
    const list = Array.isArray(current) ? current : [];
    const target = list.find((j) => j?.id === job.id);
    if (target) {
      target.sent = sent;
      target.status = "sending";
      await storeCall(env, { op: "put", key: SCHEDULED_BROADCAST_KEY, value: list }).catch(() => null);
    }
  };
  // Mark sending before the loop starts, so /schedules shows it.
  await saveProgress(Number(job.sent) || 0);
  let done = false;
  try {
    done = await executeMessengerTask(env, {
      type: "broadcast",
      text: job.kind === "text" ? job.text : "",
      mediaUrl: job.mediaUrl ?? "",
      mediaKind: job.mediaKind ?? "image",
      caption: job.caption ?? "",
      from: admin,
      scheduledId: job.id,
      resilient: true,
      resumeFrom: Number(job.sent) || 0,
      onProgress: saveProgress,
    }, admin, fetchImpl, { gapMs });
  } catch {
    done = false; // the job keeps its saved offset and resumes next tick
  }
  if (done) {
    await storeCall(env, { op: "put", key: SCHEDULED_BROADCAST_KEY, value: jobs.filter((j) => j.id !== job.id) }).catch(() => null);
  }
  return true;
}
