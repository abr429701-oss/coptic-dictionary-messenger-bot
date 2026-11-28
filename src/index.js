// src/index.js
//
// Coptic Dictionary — Messenger / Facebook bot (standalone Worker).
//
// Split out of the Telegram bot (abr429701-oss/coptic-dictionary-bot) on
// 2026-11-16: this Worker serves ONLY the Messenger webhook. The
// dictionary search, word cards, voices, learn, exams, certificates,
// get-code and admin are the same code the Telegram bot runs; the
// Telegram-only routes and modules were left behind (see README.md).
//
// Routes: GET / (ready text), GET /health, GET+POST /messenger-webhook,
// POST /botcake (Botcake flow → brain: same planFor, but the reply comes
// back as a flat JSON envelope instead of being sent). Everything else
// is 404. The learn web app and privacy page still live
// on the Telegram Worker.

import records from "../data/dictionary.json" with { type: "json" };
import { messengerVoiceUrlWithOverlay, recordedFilenameForId } from "./neural-voice.js";
import {
  nextUnrecordedWord,
  mp3Sibling,
  recordedPlaybackUrl,
  RECORDED_OVERLAY_KEY,
} from "./record-voice.js";
import {
  verifyMessengerSignature,
  handleMessengerWebhookBody,
  plainTextCard,
  buildQuickReplies,
  sendMessengerMessage,
  sendMessengerPhotoBytes,
  sendMessengerReaction,
  sendWordVoice,
  messengerAttachmentMessage,
  messengerTextMessage,
  MESSENGER_PICK_PREFIX,
} from "./messenger.js";
import {
  createMessengerParity,
  MESSENGER_PARITY_PAYLOAD_PREFIXES,
  parityHelpText,
  MAIN_MENU_ITEMS,
} from "./messenger-parity.js";
import { createDispatchCommands } from "./dispatch-commands.js";
import { suggestSimilar, recordById, translationInLanguage } from "./new-features.js";
import {
  storeCall,
  getUser,
  saveUser,
  getUserHistory,
  isBanned,
  bannedSet,
  FIRST_TIME_TEXT,
  NAME_RETRY_TEXT,
  isValidFullName,
  pushUsers,
  userSheetRow,
  getWelcomeCaption,
  driveConfig,
  lookupCodeName,
  fetchLiveExamPattern,
  localDictionaryCandidates,
  meaningOptions,
  UI_TEXT,
  formatRecord,
  uiTextFor,
  normalize,
  suggestionLabel,
  scriptKind,
  dictionaryStats,
  findDuplicates,
  readAnalyticsReport,
  readMisses,
  readAdminAudit,
  broadcastControlState,
  setBroadcastControl,
  messengerBroadcastRecipients,
  executeMessengerTask,
  runDueScheduledBroadcasts,
  logError,
  inBackground,
  sameSecret,
  utcDay,
  DAILY_REQUEST_LIMIT,
  countRequest,
  DRIVE_CONFIG_KEY,
  perStoreCache,
  driveConfigCaches,
} from "./messenger-core.js";

// Tests import these from the entry point, as they did from the old one.
export { localDictionaryCandidates } from "./messenger-core.js";
export { UserStore } from "./userstore.js";

// Live recorded-voice overlay (a fresh /record save lands in the DO
// before its manifest line lands): the parity module writes it, the
// playback path reads it. Cached in-isolate so a word card does not pay
// a DO read + a HEAD per render. A failed read degrades to the manifest.
const RECORDED_OVERLAY_TTL_MS = 60 * 1000;
const RECORDED_MP3_CHECK_TTL_MS = 5 * 60 * 1000;
const recordedOverlayCache = { at: 0, value: {} };
const recordedMp3Cache = new Map();
export function resetRecordedOverlayCache() {
  recordedOverlayCache.at = 0;
  recordedOverlayCache.value = {};
  recordedMp3Cache.clear();
}

async function getRecordedOverlay(env) {
  if (!env?.USERS) return {};
  const now = Date.now();
  if (now - recordedOverlayCache.at < RECORDED_OVERLAY_TTL_MS) return recordedOverlayCache.value;
  let value = {};
  try {
    const res = await storeCall(env, { op: "get", key: RECORDED_OVERLAY_KEY });
    if (res?.value && typeof res.value === "object" && !Array.isArray(res.value)) value = res.value;
  } catch {
    value = {};
  }
  recordedOverlayCache.value = value;
  recordedOverlayCache.at = now;
  return value;
}

async function recordedMp3Exists(env, base, filename, fetchImpl = globalThis.fetch) {
  const sibling = mp3Sibling(filename);
  if (!sibling) return false;
  const url = recordedPlaybackUrl(base, sibling);
  const now = Date.now();
  const hit = recordedMp3Cache.get(url);
  if (hit && now - hit.at < RECORDED_MP3_CHECK_TTL_MS) return hit.exists;
  let exists = false;
  try {
    const res = await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
    exists = res?.ok === true;
  } catch {
    exists = false;
  }
  recordedMp3Cache.set(url, { at: now, exists });
  return exists;
}

// Overlay-aware voice URL for one record: recorded (overlay > manifest,
// .mp3 sibling preferred when the converter produced it), then the
// prebuilt audio-manifest voice. Null when the word has no
// voice at all.
async function resolveMessengerVoice(env, record, fetchImpl = globalThis.fetch) {
  if (!record || record.id == null) return null;
  const base = env?.RECORDED_AUDIO_BASE_URL;
  const overlay = await getRecordedOverlay(env);
  const filename = recordedFilenameForId(record.id, overlay);
  let mp3Exists = false;
  if (base && filename) mp3Exists = await recordedMp3Exists(env, base, filename, fetchImpl);
  return messengerVoiceUrlWithOverlay(env, record, overlay, { mp3Exists });
}

// Search history for one Messenger user, written here (nothing wrote it
// before — getUserHistory only read `history:<id>` / the legacy snapshot
// plus an in-memory map nobody populated, so /recent, /fav and /mystats
// had no data source). One DO put per search, newest-first on read,
// capped at 20, duplicates collapse to the latest occurrence. Best
// effort: a store failure never breaks the search reply. Commands
// (text starting with "/") are never recorded — they are not searches.
async function recordMessengerSearch(env, psid, query) {
  const q = String(query ?? "").trim();
  if (!q || q.startsWith("/") || !env?.USERS || psid == null) return;
  try {
    const key = `msgr:${psid}`;
    const existing = await getUserHistory(env, key);
    const entries = [...existing].reverse().map((h) => ({ q: String(h?.q ?? h ?? ""), at: Number(h?.at ?? 0) || Date.now() }));
    entries.push({ q, at: Date.now() });
    const deduped = [];
    for (const entry of entries) {
      const at = deduped.findIndex((e) => e.q === entry.q);
      if (at >= 0) deduped.splice(at, 1);
      deduped.push(entry);
    }
    await storeCall(env, { op: "put", key: `history:${key}`, value: deduped.slice(-20) });
  } catch {
    /* history is a convenience, not the reply */
  }
}

async function clearMessengerHistory(env, psid) {
  if (!env?.USERS || psid == null) return false;
  try {
    await storeCall(env, { op: "put", key: `history:msgr:${psid}`, value: [] });
    return true;
  } catch {
    return false;
  }
}

// -- Botcake envelope -------------------------------------------------------
// The flat JSON contract the Botcake flow maps to variables (one JSON path
// → one variable, so the envelope is scalar fields only, no nested arrays):
// text/text2/text3 = the plan's text chunks in order (plans with more than
// three chunks join the rest into text3), voice_url = the word voice,
// image_url = the first IMAGE attachment, video_url = the first VIDEO
// attachment (lesson media: the flow has separate Image and Video steps —
// a video URL in image_url would be sent as the wrong type), quick_replies
// = a JSON string of [{title, payload}] taken from the LAST text that
// carries them (empty when the plan has none — the user then picks by
// typing a number, which the brain already supports). action is "none" on
// a normal reply.
// Botcake's flow text step silently drops a message whose text is too long
// (verified live 21 Nov: the 14-item L2 lesson list, ~324 chars, arrives;
// the 21-item L1 list, ~600+ chars, never does, while the brain returns it
// with hasText=true). The exact limit is unknown, so split any single text
// longer than 320 chars into chunks of at most 300 chars on line boundaries;
// the flow already sends text/text2/text3 in order, so a split list still
// arrives whole and the user still picks by number.
const BOTCAKE_SPLIT_AT = 320;
const BOTCAKE_CHUNK_MAX = 300;

function splitBotcakeText(value) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= BOTCAKE_SPLIT_AT) return [text];
  // Break every line into <=CHUNK pieces first (a single very long line is
  // hard-split), then greedily pack lines into chunks. Prefer a word
  // boundary when hard-splitting: break at the last space within the
  // limit so a long sentence splits between words, not mid-word. A line
  // with no space at all (a URL) still hard-splits — a split URL is dead
  // either way, so links that must arrive whole are kept short at the
  // source (get-code's wa.me link uses a short pre-filled text).
  const pieces = [];
  for (const line of text.split("\n")) {
    let rest = line;
    while (rest.length > BOTCAKE_CHUNK_MAX) {
      const head = rest.slice(0, BOTCAKE_CHUNK_MAX + 1);
      const cut = head.lastIndexOf(" ");
      if (cut > 0) {
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut + 1);
      } else {
        pieces.push(rest.slice(0, BOTCAKE_CHUNK_MAX));
        rest = rest.slice(BOTCAKE_CHUNK_MAX);
      }
    }
    pieces.push(rest);
  }
  const chunks = [];
  let current = "";
  for (const piece of pieces) {
    const next = current ? current + "\n" + piece : piece;
    if (next.length <= BOTCAKE_CHUNK_MAX) {
      current = next;
    } else {
      if (current) chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

export function planToBotcakeEnvelope(plan) {
  const rawTexts = Array.isArray(plan?.texts) ? plan.texts : [];
  const asText = (value) => (typeof value === "string" ? value : "");
  // Expand any over-long text into <=CHUNK pieces. Quick replies ride on
  // the last piece of the text that carried them.
  const texts = [];
  for (const item of rawTexts) {
    const pieces = splitBotcakeText(asText(item?.text));
    pieces.forEach((piece, i) => {
      texts.push({
        text: piece,
        quickReplies: i === pieces.length - 1 ? item?.quickReplies : undefined,
      });
    });
  }
  const lastWithReplies = [...texts]
    .reverse()
    .find((item) => Array.isArray(item?.quickReplies) && item.quickReplies.length);
  const quickReplies = lastWithReplies
    ? lastWithReplies.quickReplies
        .map((q) => ({ title: String(q?.title ?? ""), payload: String(q?.payload ?? "") }))
        .filter((q) => q.title && q.payload)
    : [];
  const imageUrl = Array.isArray(plan?.attachments)
    ? (plan.attachments.find((a) => a?.url && a?.type !== "video")?.url ?? "")
    : "";
  const videoUrl = Array.isArray(plan?.attachments)
    ? (plan.attachments.find((a) => a?.url && a?.type === "video")?.url ?? "")
    : "";
  const text = asText(texts[0]?.text);
  const text2 = asText(texts[1]?.text);
  let text3 = texts.slice(2).map((item) => asText(item?.text)).filter(Boolean).join("\n\n");
  // The flow has only three text slots; if the split produced more, cap
  // text3 so it too stays under the limit (real replies fit in three).
  if (text3.length > BOTCAKE_CHUNK_MAX) text3 = text3.slice(0, BOTCAKE_CHUNK_MAX) + "…";
  const voiceUrl = typeof plan?.voiceUrl === "string" ? plan.voiceUrl : "";
  return {
    text,
    text2,
    text3,
    voice_url: voiceUrl,
    image_url: typeof imageUrl === "string" ? imageUrl : "",
    video_url: typeof videoUrl === "string" ? videoUrl : "",
    quick_replies: quickReplies.length ? JSON.stringify(quickReplies) : "",
    // Flags for the Botcake flow's Conditions: Botcake converts "" to the
    // literal "null" on save, and its "not equals" operator does not work
    // live, so the flow gates on these always-real "yes"/"no" strings with
    // a single "equals yes" rule instead of comparing the content fields.
    has_text: text ? "yes" : "no",
    has_text2: text2 ? "yes" : "no",
    has_text3: text3 ? "yes" : "no",
    has_image: imageUrl ? "yes" : "no",
    // 21 Nov 2026: lesson order fix — the flow delays the image/text for
    // video lessons (a conditional Smart Delay gated on has_video) so the
    // video (slow Meta upload, ~17s) arrives BEFORE the photo, matching
    // Telegram's manifest order (video → photo → text). Without this the
    // photo/text (flow, ~10s) arrive before the video.
    has_video: videoUrl ? "yes" : "no",
    action: "none",
  };
}

// -- Botcake command buttons ------------------------------------------------
// Botcake's Persistent Menu cannot send a command text to the brain (its
// actions only send a canned message or start a flow), so the command
// buttons live as FIXED quick replies on the bot's text messages instead.
// Tapping one sends the button's Arabic label as the user's message, and the
// brain only understands slash commands — so normalize the label to its
// command here, before planFor runs. Diacritics are stripped so "تعلّم" and
// "تعلم" both match.
const BOTCAKE_BUTTON_ALIASES = {
  "البداية": "/start",
  "تعلم": "/learn",
  "القائمة": "/menu",
  "كلمة عشوائية": "/random",
  "تواصل معنا": "/contact",
};

export function normalizeBotcakeCommandText(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return raw;
  // Strip Arabic diacritics (tashkeel U+064B–U+0652, superscript alef U+0670,
  // tatweel U+0640) and collapse whitespace, then look up the button label.
  const folded = raw
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return BOTCAKE_BUTTON_ALIASES[folded] ?? raw;
}

// -- Botcake input ----------------------------------------------------------
// The flow's JSON API block sends the subscriber id + message text (and a
// quick-reply payload when the user taps one). The exact variable names are
// Botcake's, so accept every plausible name — Phase 0 confirms which ones
// the block actually sends. Query params are a fallback when the body is
// empty or not JSON.
// Botcake sends a photo as its Facebook CDN URL as the message text
// (live 28 Nov 2026: the admin's get-code screenshot arrived as an
// scontent URL, the image hook never fired, and the URL was searched as
// a dictionary word instead of completing the activation). A bare URL
// that is a Facebook image CDN link (fbcdn.net / cdninstagram.com) or
// ends in an image extension is the flow's representation of the photo
// the user just sent — not a dictionary word. Any other bare URL (a
// pasted link to a page) is not an image turn.
export function isBotcakeImageUrlText(text) {
  const raw = String(text ?? "").trim();
  if (!/^https?:\/\/\S+$/u.test(raw)) return false;
  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (/(^|\.)fbcdn\.net$/u.test(host) || /(^|\.)cdninstagram\.com$/u.test(host)) return true;
  return /\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/iu.test(raw);
}

export function parseBotcakeInput(body, url) {
  const b = body && typeof body === "object" ? body : {};
  const q = url?.searchParams;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = b[key];
      if (value !== undefined && value !== null && String(value) !== "") return String(value);
    }
    return "";
  };
  const psid =
    pick("psid", "sender_id", "subscriber_id", "user_id", "from", "senderId") ||
    (q?.get("psid") ?? "");
  const text =
    pick("text", "message", "message_text", "last_message", "input", "user_message") ||
    (q?.get("text") ?? "");
  const payload =
    pick("payload", "quick_reply_payload", "postback_payload") || (q?.get("payload") ?? "");
  const conversationId =
    pick("conversation_id", "conversationId") || (q?.get("conversation_id") ?? "");
  // Incoming message id — the ❤️ reaction needs it. The live flow's JSON
  // API body does NOT send one (it sends psid/text/first_name only), so
  // this is null on the live path until the flow adds it; accept every
  // plausible name so a one-line flow-body addition is all it takes.
  // Candidates for the flow variable (UNVERIFIED — read the variable
  // picker in the live flow builder; do NOT guess it into the flow):
  // {{last_message_id}}, {{message_id}}, {{mid}}.
  const messageId =
    pick("message_id", "mid", "last_message_id", "messageId") ||
    (q?.get("message_id") ?? q?.get("mid") ?? "");
  return {
    psid: psid || null,
    text,
    payload: payload || null,
    conversationId: conversationId || null,
    messageId: messageId || null,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    countRequest(env, ctx, url.pathname);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Coptic Dictionary Messenger bot is ready.", { status: 200 });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ready",
        bot: "coptic-dictionary-messenger-bot",
        records: records.length,
        time: new Date().toISOString(),
        usersStore: Boolean(env.USERS),
        driveConfigured: Boolean(await driveConfig(env).catch(() => null)),
      });
    }
    // ========================================================================
    // Facebook Messenger webhook (2026-11-16) — core loop only: webhook +
    // dictionary search + voice. Learn, exams, certificates and get-code are
    // NOT built here; they come later. Transport, signature verification and
    // payload shaping live in src/messenger.js; this section wires them to
    // the Telegram bot's own search (localDictionaryCandidates), word card
    // (formatRecord) and did-you-mean (suggestSimilar). Quick replies are a
    // supplement only: the full text list is always sent, and a pick is
    // stateless — the payload carries the record index, so no per-user state
    // is needed. No feature flag: the routes 403 while the Messenger env
    // vars (MESSENGER_VERIFY_TOKEN, MESSENGER_APP_SECRET,
    // MESSENGER_PAGE_TOKEN) are unset. Secrets are never logged.
    // ========================================================================
    const MESSENGER_WELCOME_TEXT = "📖 القاموس القبطي — ابعت أي كلمة بالقبطي أو العربي أو الإنجليزي أو الفرنسي أو الألماني، وأنا أجيب معناها ونطقها.";
    // Dictionary lists are paginated: 15 results per page (a 200-result
    // list used to go out as a burst of many chunk messages, which is
    // suspected of re-triggering Meta's temporary send block). Page 1
    // shows results 1–15 with a "التالي ⏭" quick reply; later pages add
    // "⏮ السابق". A bare number picks from the shown page (1–15 relative
    // to that page); the full ordered list + current page live in the
    // last-list state, so a page turn re-renders without re-searching.
    const MESSENGER_SEARCH_LIMIT = 200;
    const MESSENGER_LIST_PAGE_SIZE = 15;
    // Quick-reply payloads for list paging (plain-text "التالي"/"السابق"
    // take the same path via planFor.text). Distinct from the learn-nav
    // payloads (learn|next:/learn|prev:) and the parity prefixes.
    const MESSENGER_LIST_NAV_NEXT = "list|next";
    const MESSENGER_LIST_NAV_PREV = "list|prev";
    // Paging a list whose stored state is gone (pre-paging deploy, or a
    // corrupted entry) asks for a fresh search instead of guessing.
    const MESSENGER_LIST_EXPIRED_TEXT = "انتهت هذه القائمة، ابحث عن الكلمة مرة أخرى.";
    // Next on the last page / Previous on the first page.
    const MESSENGER_LIST_END_TEXT = "لا توجد نتائج أخرى.";
    // Meta caps one text message at 2000 characters; a long list splits
    // into several text messages instead of dropping results.
    const MESSENGER_TEXT_MAX = 2000;
    // A numbered list stays pickable for 10 minutes (WhatsApp LIST_TTL_MS).
    const MESSENGER_LAST_LIST_TTL_MS = 10 * 60 * 1000;
    // WhatsApp's pick instruction: above the items, directly under the
    // title — never below the list. Bare-number picks work (see below),
    // so this line is true; quick replies stay the tap path.
    const MESSENGER_PICK_INSTRUCTION = "أرسل رقمًا للاختيار.";

    // Arabic-Indic / Eastern Arabic-Indic / fullwidth digits, folded to
    // ASCII before any number is parsed (WhatsApp digits.js): an Arabic
    // keyboard types "٢", not "2".
    const MESSENGER_DIGIT_FOLD = (() => {
      const map = {};
      for (let i = 0; i <= 9; i += 1) {
        map[String.fromCharCode(0x660 + i)] = String(i);
        map[String.fromCharCode(0x6f0 + i)] = String(i);
        map[String.fromCharCode(0xff10 + i)] = String(i);
      }
      return map;
    })();
    function messengerNormalizeDigits(value) {
      return String(value ?? "").replace(/[٠-٩۰-۹０-９]/gu, (ch) => MESSENGER_DIGIT_FOLD[ch] ?? ch);
    }

    // -- Messenger parity wiring (src/messenger-parity.js) -----------------
    // Learn / certs / get-code / admin run in that module; this section
    // only connects it to the live sources Telegram already uses. Parity
    // per-user state lives in the same UserStore record Telegram uses,
    // keyed `msgr:<PSID>` (never a bare PSID: a Messenger id must not
    // collide with a Telegram numeric id), with the parity fields under
    // `.parity`. menuListAt stamps when the live menu was sent, so a bare
    // number can be routed to whichever list (parity menu vs dictionary
    // list) was sent most recently — see planFor below.
    async function messengerParityLoadState(env, psid) {
      try {
        return (await getUser(env, `msgr:${psid}`))?.parity ?? {};
      } catch {
        return {};
      }
    }
    async function messengerParitySaveState(env, psid, next) {
      const stamped = { ...next };
      if (next.menuList) stamped.menuListAt = Date.now();
      else delete stamped.menuListAt;
      try {
        const u = (await getUser(env, `msgr:${psid}`)) ?? {};
        await saveUser(env, `msgr:${psid}`, { ...u, parity: stamped });
      } catch {
        /* state loss degrades to "ask again", never to a crash */
      }
    }

    // First-time name registration (Telegram parity: FIRST_TIME_TEXT,
    // /start gate at 8306, name capture at 8492-8504). Telegram asks for
    // the name ONLY on /start, never on a first word — but Messenger
    // has no side menu forcing /start, so here a brand-new user (no
    // record at all) is asked on ANY first non-command message: a word,
    // a like/sticker, anything gets the name prompt before any
    // dictionary answer (user's call, 2026-11-23: a new-device test
    // sent a like and got word suggestions instead of the name prompt).
    // While awaitingName, plain text is the name attempt (validated by
    // isValidFullName, the same rule); commands keep working, /cancel
    // never clears the gate (it clears an open cert/get-code flow, or
    // falls back to Telegram's "write the word" text), and quick-reply
    // picks are never gated — planFor.pick bypasses this entirely, like
    // Telegram's menu handler running before its name check. A banned
    // user stays silent: the ban check runs first and the gate returns
    // null so parity silences them.
    // The name lives on the `user:msgr:<PSID>` record root (name /
    // awaitingName / registeredAt), exactly like Telegram's user
    // record, so /users shows it; the sheet push uses the
    // `msgr:<PSID>` id, the same id /syncusers already writes for
    // Messenger users. Returns a plan, or null to fall through.
    async function messengerNameGate(env, senderId, trimmed, ctx) {
      if (!env?.USERS || senderId == null) return null;
      const text = String(trimmed ?? "").trim();
      try {
        if (await isBanned(env, senderId)) return null;
      } catch {
        /* a failed ban check never blocks the message */
      }
      const record = await getUser(env, `msgr:${senderId}`);
      const isStart = text === "/start" || text.startsWith("/start ");
      // /start: a user with a stored name falls through to the parity
      // welcome; a user without one is asked, and any open cert /
      // get-code / exam flow is cleared first (Telegram's /start clears
      // certAwaiting/getcodeStep before the name check).
      if (isStart) {
        if (record?.name) return null;
        const parity = record?.parity ?? {};
        const next = { ...(record ?? {}), awaitingName: true };
        if (parity.certAwaiting || parity.getcodeStep || parity.getcodeName || parity.getcodeScreenshotAwaiting || parity.examAwaiting || parity.recordState || parity.recordPick) {
          next.parity = { ...parity, certAwaiting: undefined, getcodeStep: undefined, getcodeName: undefined, getcodeScreenshotAwaiting: undefined, examAwaiting: undefined, recordState: undefined, recordPick: undefined };
        }
        await saveUser(env, `msgr:${senderId}`, next);
        return { texts: [{ text: FIRST_TIME_TEXT }], voiceUrl: null };
      }
      // Brand-new user (no record at all) sending any non-command text
      // — a word, a like/sticker, anything: ask for the name FIRST,
      // before any dictionary answer. Messenger has no side menu that
      // forces /start, so without this a new user who types a word or
      // sends a like gets dictionary results (word suggestions) without
      // ever being asked for their name — the flow the user flagged on
      // 2026-11-23 (new-device test: a like returned word suggestions).
      // Commands keep working (a /help from a new user still answers),
      // and deep links still open the word first (wordLinkPlan runs
      // before this gate in planFor.text). An existing user without a
      // stored name is already awaitingName, so this branch only ever
      // fires once, on the very first message.
      if (!record) {
        if (!text.startsWith("/")) {
          await saveUser(env, `msgr:${senderId}`, { awaitingName: true });
          return { texts: [{ text: FIRST_TIME_TEXT }], voiceUrl: null };
        }
        return null;
      }
      if (!record?.awaitingName) return null;
      // /cancel while waiting: Telegram clears an open cert/get-code
      // flow with its own confirmation, otherwise falls through to the
      // "write the word" text — and never clears awaitingName.
      if (text === "/cancel") {
        const parity = record?.parity ?? {};
        if (parity.certAwaiting) {
          await saveUser(env, `msgr:${senderId}`, { ...record, parity: { ...parity, certAwaiting: undefined } });
          return { texts: [{ text: "✅ تم إلغاء إدخال الرقم الكودي." }], voiceUrl: null };
        }
        if (parity.getcodeStep) {
          await saveUser(env, `msgr:${senderId}`, { ...record, parity: { ...parity, getcodeStep: undefined, getcodeName: undefined, getcodeScreenshotAwaiting: undefined } });
          return { texts: [{ text: "✅ تم إلغاء الحصول على الرقم الكودي." }], voiceUrl: null };
        }
        if (parity.getcodeScreenshotAwaiting) {
          await saveUser(env, `msgr:${senderId}`, { ...record, parity: { ...parity, getcodeScreenshotAwaiting: undefined } });
          return { texts: [{ text: "✅ تم إلغاء الحصول على الرقم الكودي." }], voiceUrl: null };
        }
        if (parity.recordState || parity.recordPick) {
          await saveUser(env, `msgr:${senderId}`, { ...record, parity: { ...parity, recordState: undefined, recordPick: undefined } });
          return { texts: [{ text: "✅ تم إيقاف جلسة التسجيل." }], voiceUrl: null };
        }
        return { texts: [{ text: "اكتب الكلمة مباشرة للبحث أو استخدم /start للبدء." }], voiceUrl: null };
      }
      if (!text || text.startsWith("/")) return null; // commands keep working
      if (!isValidFullName(text)) {
        return { texts: [{ text: NAME_RETRY_TEXT }], voiceUrl: null };
      }
      const name = text.replace(/\s+/gu, " ").trim();
      const completed = { ...record, name, awaitingName: undefined, registeredAt: new Date().toISOString() };
      await saveUser(env, `msgr:${senderId}`, completed);
      // Sheet push, like Telegram's name completion (line 8500).
      await inBackground(ctx, pushUsers(env, [userSheetRow(`msgr:${senderId}`, completed, {})]));
      const caption = plainTextCard(await getWelcomeCaption(env, name));
      const replies = buildQuickReplies(MAIN_MENU_ITEMS.map((item) => ({ title: item.label, payload: item.payload })));
      const plan = {
        // Name completed: the /botcake handler sends this directly (see
        // the word-card block there) — the flow drops it otherwise.
        nameCompleted: true,
        texts: [{ text: caption }, { text: parityHelpText(), quickReplies: replies }],
        voiceUrl: null,
      };
      const adminPsids = String(env.MESSENGER_ADMIN_PSID ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (adminPsids.length && !adminPsids.includes(String(senderId))) {
        plan.task = { type: "send-dm", to: adminPsids[0], text: `✅ أكمل التسجيل: ${name} (🆔 ${senderId})` };
      }
      return plan;
    }

    // Messenger users only (keys `user:msgr:<PSID>`), bare PSIDs for
    // display: Telegram users belong to the Telegram /users, and a
    // Telegram numeric id is not a Page-scoped id — messaging it from
    // Messenger would fail, and banning it from here would be wrong.
    async function messengerListUsers(env, { limit = 60, query } = {}) {
      const page = await storeCall(env, { op: "userpage", limit }).catch(() => null);
      const bans = await bannedSet(env).catch(() => ({}));
      const q = normalize(String(query ?? "").trim());
      const users = (page?.users ?? [])
        .filter(({ id }) => String(id).startsWith("msgr:"))
        .map(({ id, record }) => ({
          id: String(id).slice("msgr:".length),
          name: record?.name ?? record?.tgName ?? null,
          username: record?.username ?? null,
          blocked: Boolean(bans[String(id).slice("msgr:".length)] || record?.blocked),
        }))
        .filter((u) => !q || normalize(`${u.name ?? ""} ${u.username ?? ""} ${u.id}`).includes(q));
      const total = ((await storeCall(env, { op: "get", key: "users:total" }).catch(() => null))?.value ?? null);
      return { users, total: typeof total === "number" ? total : users.length };
    }

    // Admin stats from the real sources (no dedicated search counter
    // exists: searchesToday is deliberately left unset — the usage
    // counter counts Worker requests, and the poller path is 0 requests,
    // so it would undercount searches badly; the module renders "—").
    async function messengerParityStats(env) {
      const out = { recordCount: records.length, status: "يعمل" };
      try {
        const report = await readAnalyticsReport(env);
        out.totalSearches = report.searches ?? 0;
        out.topWords = (report.topWords ?? []).map(([word, count]) => ({ word, count }));
      } catch { /* analytics unavailable: fields stay unset ("—") */ }
      try {
        out.misses = ((await readMisses(env)) ?? []).map(([word, count]) => ({ word, count }));
      } catch { /* leave unset */ }
      try {
        const total = ((await storeCall(env, { op: "get", key: "users:total" })).value ?? null);
        if (typeof total === "number") out.users = total;
      } catch { /* leave unset */ }
      try {
        out.bans = Object.keys(await bannedSet(env)).length;
      } catch { /* leave unset */ }
      try {
        const page = await storeCall(env, { op: "userpage", limit: 200 });
        out.topUsers = (page.users ?? [])
          .map(({ id, record }) => ({ id: String(id).replace(/^msgr:/u, ""), name: record?.name ?? record?.tgName ?? null, searches: Number(record?.searches ?? record?.searchCount ?? 0) }))
          .filter((u) => u.searches > 0)
          .sort((a, b) => b.searches - a.searches)
          .slice(0, 20);
      } catch { /* leave unset */ }
      try {
        const voiceIds = env.USERS ? new Set((await storeCall(env, { op: "voiceIds" })).ids ?? []) : new Set();
        const ds = dictionaryStats(voiceIds);
        out.voicedWords = ds.withVoice;
        out.emptyMeaning = records.filter((r) => !r._deleted && !String(r.meaning ?? "").trim()).length;
      } catch { /* leave unset */ }
      return out;
    }

    async function messengerParityUsage(env) {
      if (!env.USERS) return null;
      const report = await storeCall(env, { op: "usageReport", limit: 8 }).catch(() => null);
      if (!report) return null;
      const today = utcDay();
      const row = (report.days ?? []).find((d) => d.day === today);
      const total = (report.days ?? []).reduce((n, d) => n + Number(d.count ?? 0), 0);
      return { today: row?.count ?? 0, total, limit: DAILY_REQUEST_LIMIT };
    }

    async function messengerDictAudit(env) {
      const dups = findDuplicates();
      const voiceIds = env.USERS ? new Set((await storeCall(env, { op: "voiceIds" })).ids ?? []) : new Set();
      const ds = dictionaryStats(voiceIds);
      return {
        duplicateWords: dups.flatMap((g) => g.map((x) => x.coptic)).slice(0, 15),
        emptyWords: records.filter((r) => !r._deleted && !String(r.meaning ?? "").trim()).map((r) => r.coptic).slice(0, 15),
        duplicates: dups.length,
        emptyMeaning: records.filter((r) => !r._deleted && !String(r.meaning ?? "").trim()).length,
        voicedWords: ds.withVoice,
        recordCount: ds.total,
      };
    }

    // Bans keyed by bare PSID (the parity module's identifier), with the
    // blocked flag on the `msgr:` user record — NOT the shared banUser/
    // unbanUser, which key Telegram-style user records (`user:<id>`) and
    // would leave a phantom record under the bare PSID. Temp bans set
    // `until`; the shared isBanned() check lifts them on first sight.
    async function messengerParityBanUser(env, psid, opts) {
      const set = await bannedSet(env);
      const entry = { at: new Date().toISOString(), reason: String(opts?.reason ?? "").slice(0, 120) };
      const hours = Number(opts?.hours ?? 0);
      if (Number.isFinite(hours) && hours > 0) entry.until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
      set[String(psid)] = entry;
      if (env.USERS) await storeCall(env, { op: "put", key: "bans:list", value: set });
      invalidateCache(bansCache);
      const u = (await getUser(env, `msgr:${psid}`)) ?? {};
      await saveUser(env, `msgr:${psid}`, { ...u, blocked: true, bannedAt: entry.at });
      return true;
    }
    async function messengerParityUnbanUser(env, psid) {
      const set = await bannedSet(env);
      delete set[String(psid)];
      if (env.USERS) await storeCall(env, { op: "put", key: "bans:list", value: set });
      invalidateCache(bansCache);
      const u = (await getUser(env, `msgr:${psid}`)) ?? {};
      if (u && ("blocked" in u || "bannedAt" in u)) {
        const { blocked, blockedReason, bannedAt, ...rest } = u;
        await saveUser(env, `msgr:${psid}`, rest);
      }
      return true;
    }

    // The sender's last numbered list (PSID -> record indices, in displayed
    // order), kept in the existing UserStore Durable Object via the same
    // storeCall get/put pattern the rest of the bot uses — no second store.
    // A bare number picks from it; without it a number is just a search.
    // The key is namespaced so a Messenger PSID can never collide with a
    // Telegram user id. A storage failure never breaks the reply: the list
    // text is already on its way, only the number pick is lost.
    // Paging: the stored value also carries the displayed labels + title
    // (so a page turn re-renders without re-searching) and the current
    // page (bare numbers are relative to the shown page). A stored value
    // from before paging (labels/title missing) still picks by index, but
    // a page turn asks for a fresh search instead of guessing labels.
    function messengerLastListKey(psid) {
      return `messenger:lastlist:${String(psid)}`;
    }
    async function getMessengerLastList(env, psid) {
      if (!env?.USERS || psid == null) return null;
      try {
        const stored = (await storeCall(env, { op: "get", key: messengerLastListKey(psid) })).value;
        if (!stored || !Array.isArray(stored.indices) || !stored.indices.length) return null;
        if (Date.now() - Number(stored.at ?? 0) > MESSENGER_LAST_LIST_TTL_MS) return null;
        return stored;
      } catch {
        return null;
      }
    }
    async function setMessengerLastList(env, psid, indices, opts = {}) {
      if (!env?.USERS || psid == null) return;
      try {
        await storeCall(env, { op: "put", key: messengerLastListKey(psid), value: {
          indices: [...indices],
          labels: Array.isArray(opts.labels) ? [...opts.labels] : undefined,
          title: typeof opts.title === "string" && opts.title ? opts.title : undefined,
          page: Number.isInteger(opts.page) && opts.page >= 0 ? opts.page : 0,
          at: Date.now(),
        } });
      } catch (error) {
        console.error("Messenger last-list save failed", error instanceof Error ? error.message : "unknown");
      }
    }

    // Word-only labels (WhatsApp rule): the shared suggestionLabel returns
    // the WHOLE translation field for Latin/Greek queries, so Messenger
    // takes its first segment only — "fill with water", not
    // "fill with water, water, draw water". Arabic/Coptic labels are
    // already one word/part and pass through untouched.
    function messengerSuggestionLabel(record, normalizedQuery) {
      const label = suggestionLabel(record, normalizedQuery);
      const kind = scriptKind(normalizedQuery);
      if (kind === "ar" || kind === "cop") return label;
      return String(label).split(/[,/،]/u)[0]?.trim() || label;
    }

    // Labels starting with the query come first (WhatsApp search(): a
    // stable partition, tier order kept inside each group) — the list
    // starts with the word the user typed instead of hiding it mid-list.
    function messengerOrderItems(items, normalizedQuery) {
      const starts = [];
      const rest = [];
      for (const item of items) {
        (normalize(item.label).startsWith(normalizedQuery) ? starts : rest).push(item);
      }
      return [...starts, ...rest];
    }

    // One word card as plain text, plus its voice URL when the word has
    // one (null when it does not — the voice step is then skipped). Voice
    // priority is Telegram's: recorded human first, then prebuilt Polly
    // (see messengerVoiceUrl in neural-voice.js). The ×3
    // repeat in the transport applies to whichever voice is served, and
    // the user's voice prefs on `user:msgr:<PSID>` are honored here:
    // voiceOff suppresses the voice entirely, voiceRepeats 1 sends the
    // file once (/voiceonce) instead of the default 3× (/voicethree).
    // Word share link (Telegram parity): every word card carries a
    // one-tap link that opens this exact word for anyone who taps it
    // (m.me ?ref=word_<id>). The Botcake flow delivers the ref as text
    // or payload, and planFor opens the card (messengerWordLinkPlan
    // below) — the same deep link Telegram's share button builds.
    const MESSENGER_SHARE_BASE = "https://m.me/Copticdictionary?ref=word_";
    function wordShareLine(record) {
      if (record?.id == null) return "";
      return `\n\n🔗 شارك الكلمة: ${MESSENGER_SHARE_BASE}${record.id}`;
    }
    async function messengerCardPlan(env, record, searchedWord, partIndex = -1, senderId = null) {
      if (!record) return { texts: [], voiceUrl: null, voiceRepeats: 3 };
      let voiceOff = false;
      let voiceRepeats = 3;
      if (senderId != null) {
        const prefs = await getUser(env, `msgr:${senderId}`);
        voiceOff = Boolean(prefs?.voiceOff);
        voiceRepeats = prefs?.voiceRepeats === 1 ? 1 : 3;
      }
      return {
        texts: [{ text: plainTextCard(formatRecord(record, partIndex, searchedWord)) + wordShareLine(record) }],
        voiceUrl: !voiceOff && record.id != null ? await resolveMessengerVoice(env, record) : null,
        voiceRepeats,
        // Word card: the transport love-reacts the user's message (❤️).
        // messengerCardPlan is the single place all word cards are
        // finalized (search pick, deep link, /random, /wod, meaning
        // step), so the flag is exact — menus, lists, help, admin,
        // learn, errors and no-result turns never pass through here.
        wordCard: true,
      };
    }

    // Meaning pagination, Telegram/WhatsApp parity (21 Nov 2026): a word
    // card shows ONE meaning part at a time, never all parts joined.
    // When the word has more parts, the card carries a "معنى آخر" hint
    // and the step state is stored per user (DO, 10-min TTL); typing
    // "معنى آخر" advances to the next part. The state is keyed by the
    // record's index in `records` plus the first part shown, so the
    // options list recomputes identically on the next step.
    const MESSENGER_LAST_MEANING_TTL_MS = 10 * 60 * 1000;
    const MEANING_NEXT_NORMALIZED = "معني اخر";
    function messengerLastMeaningKey(psid) {
      return `messenger:lastmeaning:${String(psid)}`;
    }
    async function getMessengerLastMeaning(env, psid) {
      if (!env?.USERS || psid == null) return null;
      try {
        const stored = (await storeCall(env, { op: "get", key: messengerLastMeaningKey(psid) })).value;
        if (!stored || !Number.isInteger(stored.baseIndex) || !Number.isInteger(stored.step) || !Number.isInteger(stored.total)) return null;
        if (Date.now() - Number(stored.at ?? 0) > MESSENGER_LAST_MEANING_TTL_MS) return null;
        return stored;
      } catch {
        return null;
      }
    }
    async function setMessengerLastMeaning(env, psid, value) {
      if (!env?.USERS || psid == null) return;
      try {
        await storeCall(env, { op: "put", key: messengerLastMeaningKey(psid), value: { ...value, at: Date.now() } });
      } catch (error) {
        console.error("Messenger last-meaning save failed", error instanceof Error ? error.message : "unknown");
      }
    }
    function meaningMoreHint() {
      return `\n\n${UI_TEXT.ar.more} — أرسل «معنى آخر» لعرضه`;
    }
    async function messengerWordCardPlan(env, record, searchedWord, senderId) {
      if (!record) return { texts: [], voiceUrl: null, voiceRepeats: 3 };
      const options = meaningOptions(record, normalize(String(searchedWord ?? "")));
      if (!options.length) return messengerCardPlan(env, record, searchedWord, -1, senderId);
      const first = options[0];
      const plan = await messengerCardPlan(env, record, searchedWord, first.part, senderId);
      const baseIndex = records.indexOf(record);
      if (options.length > 1 && senderId != null && baseIndex >= 0) {
        await setMessengerLastMeaning(env, senderId, { baseIndex, firstPart: first.part, step: 0, total: options.length });
        if (plan.texts?.length) plan.texts[0].text = `${plan.texts[0].text}${meaningMoreHint()}`;
      }
      return plan;
    }
    // Deep link (Telegram parity): "word_<id>" / "word_<id>_<en|fr|de>"
    // opens that record's card directly — the same card (share line,
    // voice, «معنى آخر» pagination) as a search + pick. The language
    // suffix renders the card as if searched in that language
    // (Telegram: the first translation in that language is the
    // synthetic search key); no translation means the Arabic card. An
    // unknown id answers with the brain's standard no-result text.
    // Returns null when the text is not a word link.
    const WORD_LINK_RE = /^word_(\d+)(?:_(en|fr|de))?$/u;
    async function messengerWordLinkPlan(env, text, senderId) {
      const m = WORD_LINK_RE.exec(String(text ?? "").trim());
      if (!m) return null;
      const record = recordById(Number(m[1]));
      if (!record) return { texts: [{ text: uiTextFor("").noResult }], voiceUrl: null };
      const key = m[2] ? translationInLanguage(record, m[2]) : "";
      return messengerWordCardPlan(env, record, key, senderId);
    }
    async function messengerNextMeaningPlan(env, senderId) {
      const stored = await getMessengerLastMeaning(env, senderId);
      if (!stored) {
        return { texts: [{ text: "ابحث عن كلمة أولاً، ثم أرسل «معنى آخر» لعرض معانيها الأخرى." }], voiceUrl: null };
      }
      const record = records[stored.baseIndex];
      if (!record) {
        return { texts: [{ text: "ابحث عن كلمة أولاً، ثم أرسل «معنى آخر» لعرض معانيها الأخرى." }], voiceUrl: null };
      }
      const options = meaningOptions(record, "", stored.firstPart);
      const nextStep = stored.step + 1;
      if (nextStep >= options.length || nextStep >= stored.total) {
        return { texts: [{ text: UI_TEXT.ar.end }], voiceUrl: null };
      }
      const next = options[nextStep];
      const plan = await messengerCardPlan(env, record, "", next.part, senderId);
      await setMessengerLastMeaning(env, senderId, { ...stored, step: nextStep });
      if (nextStep + 1 < options.length && plan.texts?.length) {
        plan.texts[0].text = `${plan.texts[0].text}${meaningMoreHint()}`;
      }
      return plan;
    }

    // A numbered word-only list (labels only — meanings appear on the card
    // after a pick, the same rule as the WhatsApp port) with quick replies
    // for tapping. One page shows at most MESSENGER_LIST_PAGE_SIZE items
    // (numbered 1–15 relative to the shown page); later pages are reached
    // with the "التالي ⏭" / "⏮ السابق" quick replies (or the same words
    // typed). The numbered lines are NOT tappable in Messenger — only
    // quick replies are — and quick replies show in the composer only
    // while the Page's LATEST message carries them, so they go on the
    // LAST text chunk and nothing is ever sent after the list in the same
    // turn. Nav buttons come FIRST in the quick replies: buildQuickReplies
    // keeps the first 13, so the nav always survives and the item picks
    // fill the rest (items 13–15 on a page are picked by typing their
    // number). A page longer than Meta's 2000-char text limit still splits
    // into several text messages. listIndices/listLabels/listTitle
    // (displayed order, whole list) is what a bare-number pick resolves
    // against and what a page turn re-renders from.
    function messengerListPlan(items, titleText, page = 0) {
      const totalPages = Math.max(1, Math.ceil(items.length / MESSENGER_LIST_PAGE_SIZE));
      const safePage = Math.min(Math.max(0, Math.floor(page) || 0), totalPages - 1);
      const pageItems = items.slice(safePage * MESSENGER_LIST_PAGE_SIZE, (safePage + 1) * MESSENGER_LIST_PAGE_SIZE);
      const nav = [];
      if (safePage > 0) nav.push({ title: "⏮ السابق", payload: MESSENGER_LIST_NAV_PREV });
      if (safePage < totalPages - 1) nav.push({ title: "التالي ⏭", payload: MESSENGER_LIST_NAV_NEXT });
      const quickReplies = buildQuickReplies([
        ...nav,
        ...pageItems.map((item) => ({ title: item.label, payload: `${MESSENGER_PICK_PREFIX}${item.index}` })),
      ]);
      const allLines = [titleText, MESSENGER_PICK_INSTRUCTION];
      if (totalPages > 1) allLines.push(`صفحة ${safePage + 1} من ${totalPages}`);
      allLines.push(...pageItems.map((item, i) => `${i + 1}. ${item.label}`));
      const texts = [];
      let chunk = [];
      let chunkLen = 0;
      for (const line of allLines) {
        const nextLen = chunk.length ? chunkLen + 1 + line.length : line.length;
        if (chunk.length && nextLen > MESSENGER_TEXT_MAX) {
          texts.push({ text: chunk.join("\n") });
          chunk = [line];
          chunkLen = line.length;
        } else {
          chunk.push(line);
          chunkLen = nextLen;
        }
      }
      if (chunk.length) texts.push({ text: chunk.join("\n") });
      texts[texts.length - 1].quickReplies = quickReplies;
      return {
        texts,
        voiceUrl: null,
        listIndices: items.map((item) => item.index),
        listLabels: items.map((item) => item.label),
        listTitle: titleText,
      };
    }

    // Typed list navigation ("التالي" / "السابق", with or without the
    // button emoji, "next" / "prev"): +1, -1, or 0 when the text is not a
    // nav word. Never a name, a search, or a number pick.
    function messengerListNavDirection(text) {
      const t = String(text ?? "").replace(/[⏭⏮]/gu, "").trim();
      if (t === "التالي" || t.toLowerCase() === "next") return 1;
      if (t === "السابق" || t.toLowerCase() === "prev") return -1;
      return 0;
    }

    // Turn the sender's stored dictionary list one page in the given
    // direction and render it; out of range answers with the short
    // end-of-list text instead of re-sending the page. A stored list
    // without labels/title (written before paging existed) cannot be
    // re-rendered, so it asks for a fresh search.
    async function messengerListPagePlan(env, senderId, direction) {
      const stored = await getMessengerLastList(env, senderId);
      if (!stored || !Array.isArray(stored.labels) || stored.labels.length !== stored.indices.length || !stored.title) {
        return { texts: [{ text: MESSENGER_LIST_EXPIRED_TEXT }], voiceUrl: null };
      }
      const totalPages = Math.max(1, Math.ceil(stored.indices.length / MESSENGER_LIST_PAGE_SIZE));
      const current = Math.min(Math.max(0, Number(stored.page ?? 0)), totalPages - 1);
      const next = current + direction;
      if (next < 0 || next >= totalPages) {
        return { texts: [{ text: MESSENGER_LIST_END_TEXT }], voiceUrl: null };
      }
      const items = stored.indices.map((index, i) => ({ index, label: stored.labels[i] }));
      const plan = messengerListPlan(items, stored.title, next);
      await setMessengerLastList(env, senderId, plan.listIndices, { labels: plan.listLabels, title: plan.listTitle, page: next });
      return plan;
    }

    // The Telegram bot's own search, adapted: one exact match -> the card
    // (with voice); several -> the list; none -> did-you-mean, then the
    // no-result text. localDictionaryCandidates is exact -> partial
    // (contains) -> fuzzy, over the same in-memory records. A bare number
    // first tries the sender's last list (WhatsApp: a bare number picks
    // from the live list); in range it behaves exactly like a quick-reply
    // pick, out of range or with no live list it falls through to a
    // normal search for the number.
    async function messengerSearchPlan(env, query, senderId) {
      const text = String(query ?? "").trim();
      if (!text) return { texts: [], voiceUrl: null };
      if (text === "/start" || text === "/help") return { texts: [{ text: MESSENGER_WELCOME_TEXT }], voiceUrl: null };
      const folded = messengerNormalizeDigits(text);
      if (/^\d+$/u.test(folded) && senderId != null) {
        const live = await getMessengerLastList(env, senderId);
        if (live) {
          // Numbers are relative to the SHOWN page (1–15): page 2's "1"
          // is the 16th item of the stored list. Out of range falls
          // through to a normal search for the number, as before.
          const n = Number(folded);
          const globalAt = Number(live.page ?? 0) * MESSENGER_LIST_PAGE_SIZE + (n - 1);
          if (Number.isInteger(n) && n >= 1 && n <= MESSENGER_LIST_PAGE_SIZE && live.indices[globalAt] !== undefined) {
            return await messengerPickPlan(env, live.indices[globalAt], senderId);
          }
        }
      }
      const normalized = normalize(text);
      const result = localDictionaryCandidates(text, MESSENGER_SEARCH_LIMIT);
      if (result.ok && result.candidates.length) {
        // Exact short-circuit, exactly like Telegram (candidates.length
        // === 1 || exactCount === 1) and WhatsApp (same-spelling rows
        // collapse to one word): one exact match opens its card directly
        // instead of a list. The same word in several rows (exactCount >
        // 1, one normalized headword) still opens its card; different
        // words sharing one spelling show the list.
        const exacts = result.candidates.filter((candidate) => candidate.matchType === "exact");
        const sameWord = exacts.length > 1 && exacts.length === result.exactCount &&
          exacts.every((candidate) => normalize(String(records[candidate.row - 2]?.coptic ?? "")) ===
            normalize(String(records[exacts[0].row - 2]?.coptic ?? "")));
        if (result.candidates.length === 1 || result.exactCount === 1 || sameWord) {
          const candidate = result.candidates[0];
          const record = records[candidate.row - 2];
          return await messengerWordCardPlan(env, record, text, senderId);
        }
        const items = messengerOrderItems(
          result.candidates
            .map((candidate) => ({ index: candidate.row - 2, label: messengerSuggestionLabel(records[candidate.row - 2], normalized) }))
            .filter((item) => item.index >= 0 && item.label),
          normalized,
        );
        if (!items.length) return { texts: [{ text: uiTextFor(text).noResult }], voiceUrl: null };
        const plan = messengerListPlan(items, uiTextFor(text).choose);
        await setMessengerLastList(env, senderId, plan.listIndices, { labels: plan.listLabels, title: plan.listTitle, page: 0 });
        return plan;
      }
      const suggestions = suggestSimilar(text, 3);
      if (suggestions.length) {
        const items = suggestions
          .map((s) => ({ index: s.index, label: s.label }))
          .filter((item) => item.index >= 0 && item.label);
        if (items.length) {
          const plan = messengerListPlan(items, uiTextFor(text).didYouMean);
          await setMessengerLastList(env, senderId, plan.listIndices, { labels: plan.listLabels, title: plan.listTitle, page: 0 });
          return plan;
        }
      }
      return { texts: [{ text: uiTextFor(text).noResult }], voiceUrl: null };
    }

    async function messengerPickPlan(env, index, senderId = null) {
      const record = records[index];
      if (!record) return { texts: [{ text: "لم أجد هذه الكلمة، ابحث عنها مرة أخرى." }], voiceUrl: null };
      // The card opens on the meaning the list showed for this item
      // (an Arabic search's matched part, a Coptic search's part 0),
      // so the pick's card contains the label the user tapped.
      let searchedWord = "";
      if (senderId != null) {
        const stored = await getMessengerLastList(env, senderId);
        if (stored) {
          const pos = stored.indices.indexOf(index);
          if (pos >= 0 && stored.labels?.[pos]) searchedWord = stored.labels[pos];
        }
      }
      return await messengerWordCardPlan(env, record, searchedWord, senderId);
    }

    // Meta verification: GET /messenger-webhook?hub.mode=subscribe&
    // hub.verify_token=<MESSENGER_VERIFY_TOKEN>&hub.challenge=<challenge>
    // answers the challenge as plain text; anything else is 403.
    if (url.pathname === "/messenger-webhook" && request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (!env.MESSENGER_VERIFY_TOKEN || mode !== "subscribe" || !challenge ||
          !sameSecret(token ?? "", env.MESSENGER_VERIFY_TOKEN)) {
        return new Response("Forbidden", { status: 403 });
      }
      return new Response(challenge, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    // -- One brain, two transports ----------------------------------------
    // The webhook and POST /botcake share this wiring (parity brain +
    // live-monitor hook + planFor). Built lazily per request so the GET
    // routes never pay the drive-config read.
    let planForCache = null;
    async function getPlanFor() {
      if (planForCache) return planForCache;
      const macroConfig = await driveConfig(env).catch(() => null);
      // Shared deps for the parity factory AND the dispatch commands
      // (src/dispatch-commands.js): one adminStore, one user-record
      // reader, one error list — the two modules must see the same DO
      // state (suggestions, tickets, favorites, voice prefs).
      const messengerAdminStore = {
        get: async (key) => (await storeCall(env, { op: "get", key })).value ?? null,
        put: async (key, value) => { await storeCall(env, { op: "put", key, value }); return true; },
        del: async (key) => { await storeCall(env, { op: "put", key, value: null }); return true; },
      };
      const messengerGetUserRecord = async (psid) => {
        // Messenger users live under `user:msgr:<PSID>`; a bare-PSID
        // lookup would miss (or hit a Telegram user).
        const record = await getUser(env, `msgr:${psid}`);
        if (!record) return null;
        return { record, history: await getUserHistory(env, `msgr:${psid}`) };
      };
      const messengerSaveUserRecord = async (psid, record) => saveUser(env, `msgr:${psid}`, record);
      const messengerAdminPsids = String(env.MESSENGER_ADMIN_PSID ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const messengerListErrors = async () => {
        const entries = env.USERS ? ((await storeCall(env, { op: "get", key: "errors:recent" }).catch(() => null))?.value ?? []) : [];
        return (Array.isArray(entries) ? entries : []).slice(-30).reverse().map((e) => ({ at: e?.at ?? null, where: e?.where ?? e?.kind ?? "?", message: e?.message ?? String(e ?? "") }));
      };
      const messengerParity = createMessengerParity({
        adminPsids: (env.MESSENGER_ADMIN_PSID ?? "").split(","),
        macroUrl: macroConfig?.url ?? null,
        fetchLiveExamPattern,
        lookupCodeName,
        loadState: (psid) => messengerParityLoadState(env, psid),
        saveState: (psid, next) => messengerParitySaveState(env, psid, next),
        isBanned: (psid) => isBanned(env, psid),
        adminStore: messengerAdminStore,
        getUserRecord: messengerGetUserRecord,
        updateUserRecord: async (psid, patch) => {
          const u = (await getUser(env, `msgr:${psid}`)) ?? {};
          return saveUser(env, `msgr:${psid}`, { ...u, ...patch });
        },
        deleteUserRecord: async (psid) => {
          // Messenger users live under `user:msgr:<PSID>` (see loadState);
          // deleting bare `user:<PSID>` would miss (or hit a Telegram user).
          await storeCall(env, { op: "put", key: `user:msgr:${psid}`, value: null });
          return true;
        },
        listUserPage: (opts) => messengerListUsers(env, opts),
        listUsers: () => messengerListUsers(env, {}),
        listBans: () => bannedSet(env),
        banUser: (psid, opts) => messengerParityBanUser(env, psid, opts),
        unbanUser: (psid) => messengerParityUnbanUser(env, psid),
        listRecipients: () => messengerBroadcastRecipients(env),
        getStats: () => messengerParityStats(env),
        getUsage: () => messengerParityUsage(env),
        listErrors: messengerListErrors,
        listAuditLog: () => readAdminAudit(env),
        listSecurityLog: null, // no security-log reader exists on this path
        getDriveConfig: () => driveConfig(env).catch(() => null),
        setMacroUrl: async (url) => {
          await storeCall(env, { op: "put", key: DRIVE_CONFIG_KEY, value: { url } });
          invalidateCache(perStoreCache(driveConfigCaches, env));
          return true;
        },
        listTickets: null, // no ticket store exists on this path
        getTicket: null,
        closeTicket: null,
        createTicket: null,
        // Dispatch commands (wordinfo, /alphabet, /wod, voice prefs,
        // favorites, ...) — the real handlers in src/dispatch-commands.js.
        // Parked quiz/game commands answer with an honest "not built"
        // message there; the "لم يتم توصيله بعد" placeholder only fires
        // for a dispatch command that is somehow still unwired.
        runUserCommand: createDispatchCommands({
          getUserRecord: messengerGetUserRecord,
          saveUserRecord: messengerSaveUserRecord,
          clearHistory: (psid) => clearMessengerHistory(env, psid),
          wordCard: (record, senderId) => messengerWordCardPlan(env, record, "", senderId ?? null),
          hasRecordedVoice: async (id) => {
            try {
              const overlay = await getRecordedOverlay(env);
              return Boolean(recordedFilenameForId(id, overlay));
            } catch {
              return false;
            }
          },
          adminStore: messengerAdminStore,
          isAdmin: (psid) => messengerAdminPsids.includes(String(psid)),
          firstAdminPsid: messengerAdminPsids[0] ?? null,
          listErrors: messengerListErrors,
        }),
        getDictAudit: () => messengerDictAudit(env),
        deleteVoice: null, // voice files live on the audio branch / DO
        // Voice recording (/record): Messenger voice attachments download
        // as MP4/AAC and land in R2 recorded/<id>.<ext> via the RECORDINGS
        // binding (wrangler.jsonc). The live DO overlay makes a fresh
        // recording playable before its manifest line lands (the manifest
        // syncs from the Telegram repo every 30 min). The converter
        // script (scripts/convert-recorded.mjs) later produces the .mp3
        // sibling so the recording also plays on WhatsApp/Telegram.
        // /voice_delete removes the same keys (raw file + .mp3 sibling)
        // through deleteRecording below.
        deleteRecording: async (key) => {
          if (!env.RECORDINGS) return { ok: false, error: "r2-unconfigured" };
          try {
            await env.RECORDINGS.delete(key);
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "r2-delete-failed" };
          }
        },
        putRecording: async (key, bytes, contentType) => {
          if (!env.RECORDINGS) return { ok: false, error: "r2-unconfigured" };
          try {
            await env.RECORDINGS.put(key, bytes, { httpMetadata: { contentType: contentType || "audio/mp4" } });
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "r2-put-failed" };
          }
        },
        fetchImpl: globalThis.fetch,
        // Get-code screenshot OCR (28 Nov 2026): the OCR.space free key
        // from the OCR_SPACE_API_KEY wrangler secret; unset = OCR
        // skipped (fail open). The parent sets the secret after deploy.
        ocrApiKey: env.OCR_SPACE_API_KEY ?? null,
        // Shared get-code registry (28 Nov 2026, cross-platform sync):
        // the SAME GETCODE_REGISTRY_SECRET the Telegram Worker uses
        // (wrangler secret on this Worker too); unset = registry
        // disabled — every lookup is a miss, writes are skipped.
        getcodeRegistrySecret: env.GETCODE_REGISTRY_SECRET ?? null,
        searchWords: async (query) => {
          // /record_choose candidates: the same dictionary search the
          // bot uses, capped at 15 (one Messenger list page).
          const result = localDictionaryCandidates(query, 15);
          if (!result?.ok) return [];
          const seen = new Set();
          const out = [];
          for (const candidate of result.candidates ?? []) {
            const record = records[candidate.row - 2];
            if (!record || record.id == null || seen.has(String(record.id))) continue;
            seen.add(String(record.id));
            out.push({
              id: record.id, coptic: record.coptic ?? "",
              pronunciation: record.pronunciation ?? "",
              english: record.english ?? "", meaning: record.meaning ?? "",
            });
          }
          return out;
        },
        nextUnrecorded: async (recordedIds) => nextUnrecordedWord(records, recordedIds),
        getBroadcastControl: () => broadcastControlState(env),
        setBroadcastControl: async (patch) => { await setBroadcastControl(env, patch); return true; },
        getBroadcastStats: () => storeCall(env, { op: "bcstatus" }),
        editDictionary: null, // Apps Script dictionary-admin route, unwired
        runTask: null, // job tasks run via plan.task (see executeTask)
      });
      // Live monitoring (Telegram /livemon parity): every incoming
      // message from a non-admin is logged to the DO conversation log,
      // and while /livemon is ON it is forwarded live to the first
      // admin PSID (same "first admin" convention as the name-gate
      // send-dm). The forward is a DIRECT sendMessengerMessage, never
      // a plan.task: the plan may already carry a task (e.g. the name
      // gate's send-dm on registration) and a second task would
      // collide. The hook is awaited so the forward is not lost when
      // the webhook returns, and it is wrapped in try/catch so a
      // logging/forward failure never breaks the user's reply. Admin
      // messages are never logged or forwarded; bot replies are never
      // logged (only inbound messages reach this hook).
      async function liveMonitorHook(senderId, kind, text) {
        try {
          if (senderId == null || messengerParity.isAdmin(senderId)) return;
          const logged = await messengerParity.logIncomingMessage(senderId, kind, text);
          if (!logged || !(await messengerParity.liveMonitorOn())) return;
          const adminPsids = String(env.MESSENGER_ADMIN_PSID ?? "").split(",").map((s) => s.trim()).filter(Boolean);
          if (!adminPsids.length) return;
          const forward = await messengerParity.buildLiveForward(senderId, kind, text);
          if (!forward) return;
          await sendMessengerMessage(env, adminPsids[0], messengerTextMessage(forward));
        } catch {
          /* logging/forwarding never breaks the user's reply */
        }
      }
      const planFor = {
        // Parity first: flows (cert/get-code/exam), menus, commands.
        // A bare number is routed by recency — whichever list (parity
        // menu vs dictionary list) was sent most recently wins — so a
        // number typed after a word search picks the word, not a stale
        // menu, and vice versa. While a parity flow is active (a cert
        // code, a get-code step, an exam code, a broadcast/confirm
        // pending), the number belongs to the flow, not to any list.
        text: async (query, senderId, attachments) => {
          // Live monitor hook first: every inbound text (and every
          // captioned attachment — the caption is the text) from a
          // non-admin is logged, and forwarded while /livemon is ON.
          // A non-audio attachment alongside the text means the text
          // is a media caption (kind "media"); an audio attachment
          // with text is ignored by the router, so it stays "text".
          if (senderId != null) {
            const hasMedia = Array.isArray(attachments) && attachments.some((a) => a?.type && a.type !== "audio");
            await liveMonitorHook(senderId, hasMedia ? "media" : "text", query);
          }
          // A captioned image (photo with a caption): the caption is
          // the text, but the image also answers the get-code screenshot
          // wait — check it first, passing the attachment so the OCR
          // verification can download it; handleImage returns null when
          // no wait is open and the turn flows on normally. A sticker
          // (incl. the 👍 like) is an "image" attachment with a
          // sticker_id — it is NOT a photo and never reaches handleImage.
          if (senderId != null && Array.isArray(attachments) && attachments.some((a) => a?.type === "image" && !a?.payload?.sticker_id)) {
            const imgPlan = await messengerParity.handleImage(senderId, attachments.find((a) => a?.type === "image" && !a?.payload?.sticker_id));
            if (imgPlan) return imgPlan;
          }
          // Deep link (Telegram parity): a tapped share link opens the
          // word directly — before the name gate, so a first-time user
          // who taps a shared link gets the word (Telegram's /start
          // word_<id> likewise answers before the name prompt).
          const wordLinkPlan = await messengerWordLinkPlan(env, query, senderId);
          if (wordLinkPlan) return wordLinkPlan;
          // First-time name registration (Telegram parity): the gate
          // runs before flows and search; a plan means the turn is
          // answered here, null means normal routing (commands, flows,
          // dictionary search) proceeds untouched.
          if (senderId != null) {
            const namePlan = await messengerNameGate(env, senderId, query, ctx);
            if (namePlan) return namePlan;
          }
          // Meaning pagination ("معنى آخر", typed): steps to the next
          // meaning part of the last word card shown. Runs before list
          // paging and number routing so the phrase is never searched
          // as a dictionary word.
          if (senderId != null && normalize(String(query ?? "").trim()) === MEANING_NEXT_NORMALIZED) {
            return messengerNextMeaningPlan(env, senderId);
          }
          // Dictionary-list paging ("التالي ⏭" / "⏮ السابق", typed):
          // a live list turns one page — unless a parity flow is active
          // (a code/name/phone is expected), a lesson is open (lesson nav
          // owns these words there), or a parity menu is newer than the
          // list — then parity answers as today.
          const navDir = messengerListNavDirection(query);
          if (navDir !== 0 && senderId != null) {
            const parityState = await messengerParityLoadState(env, senderId);
            const flowActive = Boolean(parityState?.certAwaiting || parityState?.getcodeStep || parityState?.examAwaiting || parityState?.pendingBroadcast || parityState?.pendingConfirm || parityState?.recordPick);
            if (!flowActive && !parityState?.lastLessonId) {
              const dictList = await getMessengerLastList(env, senderId);
              const menuAt = parityState?.menuList ? Number(parityState.menuListAt ?? 0) : 0;
              if (dictList && Number(dictList.at ?? 0) >= menuAt) {
                return messengerListPagePlan(env, senderId, navDir);
              }
            }
          }
          const folded = messengerNormalizeDigits(String(query ?? "").trim());
          if (/^\d+$/u.test(folded) && senderId != null) {
            const parityState = await messengerParityLoadState(env, senderId);
            const flowActive = Boolean(parityState?.certAwaiting || parityState?.getcodeStep || parityState?.examAwaiting || parityState?.pendingBroadcast || parityState?.pendingConfirm || parityState?.recordPick);
            if (!flowActive) {
              const dictList = await getMessengerLastList(env, senderId);
              const menuAt = parityState?.menuList ? Number(parityState.menuListAt ?? 0) : 0;
              const dictAt = dictList ? Number(dictList.at ?? 0) : 0;
              if (parityState?.menuList && menuAt >= dictAt) {
                const parityPlan = await messengerParity.handleText(senderId, query);
                if (parityPlan) return parityPlan;
              }
              return messengerSearchPlan(env, query, senderId);
            }
          }
          const parity = await messengerParity.handleText(senderId, query);
          if (parity) return parity;
          // A bare URL is not a dictionary word (a photo arriving via
          // Botcake as its URL is routed to the image path by the
          // /botcake handler; a pasted link here gets silence, never a
          // search for the URL).
          if (/^https?:\/\/\S+$/u.test(String(query ?? "").trim())) return null;
          // Dictionary search fall-through: record it so /recent, /fav
          // and /mystats have real data (recordMessengerSearch skips
          // commands and never breaks the reply).
          if (senderId != null) await recordMessengerSearch(env, senderId, query);
          return messengerSearchPlan(env, query, senderId);
        },
        pick: async (payload, senderId) => {
          // Deep link via payload: an m.me ?ref=word_<id> tap arrives
          // as a postback payload (Botcake or the webhook) — open the
          // word card directly.
          if (typeof payload === "string") {
            const wordLinkPlan = await messengerWordLinkPlan(env, payload, senderId);
            if (wordLinkPlan) return wordLinkPlan;
          }
          if (typeof payload === "string" && MESSENGER_PARITY_PAYLOAD_PREFIXES.some((p) => payload.startsWith(p))) {
            return messengerParity.handlePick(senderId, payload);
          }
          // Dictionary-list paging quick replies ("التالي ⏭" / "⏮ السابق"):
          // the payload carries no record index, so it turns the stored
          // list instead of picking. Bypasses the name gate like picks do.
          if (payload === MESSENGER_LIST_NAV_NEXT) return messengerListPagePlan(env, senderId, 1);
          if (payload === MESSENGER_LIST_NAV_PREV) return messengerListPagePlan(env, senderId, -1);
          const index = Number(payload);
          return messengerPickPlan(env, index, senderId);
        },
        // A voice message (audio attachment, no text): the /record flow
        // owns it when an admin session is open; anything else stays
        // silent (non-admin voices and stray voices are ignored).
        // The live monitor logs the voice and forwards it while ON
        // before the record flow decides — admin voices are never
        // logged or forwarded (the hook gates on isAdmin).
        audio: async (attachment, senderId) => {
          await liveMonitorHook(senderId, "voice", "");
          return messengerParity.handleAudio(senderId, attachment);
        },
        // An image message (photo attachment, no text): only the
        // get-code screenshot wait owns it — handleImage answers the
        // activation (OCR-verified on the webhook path; fail-open on the
        // /botcake empty-text path, which carries no image bytes), or
        // null (silence) when no wait is open. The live monitor logs
        // it as media before the wait decides.
        image: async (attachment, senderId) => {
          await liveMonitorHook(senderId, "media", "");
          return messengerParity.handleImage(senderId, attachment);
        },
        executeTask: (task, senderId, fetchImpl) => executeMessengerTask(env, task, senderId, fetchImpl, { ctx }),
      };
      planForCache = planFor;
      return planForCache;
    }

    // Botcake brain endpoint: POST /botcake -------------------------------
    // Auth: shared secret in the X-Botcake-Secret header, compared against
    // env.BOTCAKE_SECRET; fail-closed (unset secret = always 403) so the
    // route cannot be used before the secret exists. The Botcake JSON API
    // block sends the header; the secret never appears in a URL or a flow.
    // The flow sends { psid, text } (or a quick-reply payload); the same
    // brain computes the reply, but nothing is sent here — the plan comes
    // back as a flat JSON envelope (planToBotcakeEnvelope) and Botcake
    // sends it. Server-side tasks (admin DM, broadcasts, ...) still run
    // here, exactly as on the webhook path.
    if (url.pathname === "/botcake" && request.method === "POST") {
      if (!env.BOTCAKE_SECRET || !sameSecret(request.headers.get("x-botcake-secret") ?? "", env.BOTCAKE_SECRET)) {
        return new Response("Forbidden", { status: 403 });
      }
      let body = null;
      try {
        body = await request.json();
      } catch {
        body = null;
      }
      const input = parseBotcakeInput(body, url);
      if (!input.psid) {
        return Response.json({ error: "missing_psid" }, { status: 400 });
      }
      const started = Date.now();
      const planFor = await getPlanFor();
      // First-ever message? A brand-new subscriber has no UserStore
      // record AND no search history yet. Remember it BEFORE
      // planFor.text runs (the search recording creates the history,
      // /start creates the record), because a new user is exactly who
      // the Botcake flow goes silent on (see the direct send below).
      // Both signals are needed: a word search writes history but no
      // user record, while /start writes a record but no history — so
      // either one present means "has messaged before". getUser is
      // memoized (5 s TTL) and saveUser refreshes the memo; the
      // history read is always fresh, so this stays correct across
      // rapid repeat messages.
      let isFirstEver = false;
      try {
        const [existing, history] = await Promise.all([
          getUser(env, `msgr:${input.psid}`).catch(() => null),
          getUserHistory(env, `msgr:${input.psid}`).catch(() => []),
        ]);
        isFirstEver = !existing && (!history || history.length === 0);
      } catch {
        isFirstEver = false;
      }
      // Typing indicator, best-effort: the user sees "يكتب..." while the
      // flow waits for this call. A failure never blocks the reply; the
      // flow's reply clears it, and a silent turn turns it off below.
      try {
        await sendMessengerSenderAction(env, input.psid, "typing_on");
      } catch {
        /* typing is best-effort only */
      }
      let plan = null;
      try {
        // Quick-reply button taps arrive as the button's Arabic label
        // (as text, or as a payload). Map the label to its slash command
        // so the brain answers it. A payload that is a command/label is
        // text, not a list pick — route it through the text path.
        const text = normalizeBotcakeCommandText(input.text);
        const payloadAsText = input.payload
          ? normalizeBotcakeCommandText(input.payload)
          : "";
        const payloadIsCommand =
          Boolean(input.payload) &&
          (payloadAsText.startsWith("/") || payloadAsText !== input.payload);
        // A non-text message (photo/sticker/like) reaches the flow with
        // no text and no payload — Botcake forwards it as an empty-text
        // call. LIVE 28 Nov 2026 (admin report): a photo ALSO arrives
        // as its Facebook CDN URL as the text — the flow's message
        // variable resolves a media message to the attachment URL, so
        // the turn carried a non-empty text, the image hook below never
        // fired, and the URL was searched as a dictionary word instead
        // of completing the get-code activation. So an image-URL text
        // is an image turn too: it goes to planFor.image with the URL
        // as the attachment (the OCR verification downloads it, exactly
        // like the webhook path; a failed download fails open). An
        // image-like turn with no owner stays silent — an empty query
        // or a URL is never searched as a dictionary word.
        const imageUrlTurn = Boolean(text) && !input.payload && isBotcakeImageUrlText(text);
        if ((!text && !input.payload) || imageUrlTurn) {
          if (typeof planFor.image === "function") {
            plan = await planFor.image(imageUrlTurn ? { payload: { url: text } } : null, input.psid);
          }
        }
        if (!plan) {
          if ((!text && !input.payload) || imageUrlTurn) {
            // A photo/sticker/like (or its URL representation) with no
            // owner: silence — never search an empty query or a URL.
            plan = { texts: [], voiceUrl: null };
          } else if (payloadIsCommand) plan = await planFor.text(payloadAsText, input.psid, null);
          else if (input.payload) plan = await planFor.pick(input.payload, input.psid);
          else plan = await planFor.text(text, input.psid, null);
        }
      } catch (error) {
        console.error("Botcake plan failed", error instanceof Error ? error.message : "unknown");
        try {
          await sendMessengerSenderAction(env, input.psid, "typing_off");
        } catch {
          /* typing is best-effort only */
        }
        return Response.json({
          text: "حصلت مشكلة، حاول تاني بعد شوية.",
          text2: "",
          text3: "",
          voice_url: "",
          image_url: "",
          video_url: "",
          quick_replies: "",
          action: "error",
        });
      }
      if (plan?.task && typeof planFor.executeTask === "function") {
        try {
          await planFor.executeTask(plan.task, input.psid);
        } catch (error) {
          console.error("Botcake task failed", error instanceof Error ? error.message : "unknown");
        }
      }
      const envelope = planToBotcakeEnvelope(plan);
      // First-ever message (new user): the Botcake flow reads the saved
      // reply fields one run stale, and a brand-new subscriber has no
      // previous fields at all — so its Conditions see empty and it
      // sends NOTHING. Live case 23 Nov 2026: Asmaa Mohamed's first
      // word got total silence (the Worker answered, the flow did not
      // send). Send the reply text directly here so a new user always
      // gets an answer on their first message. Botcake's flow also
      // tries, but its fields are empty for a new user so it sends
      // nothing — no double. From the second message on, the fields
      // exist (saved by this run) and Botcake sends as normal, so this
      // direct send only ever fires once per user. Awaited (like the
      // video/cert sends) so it lands before the envelope returns.
      if (isFirstEver && envelope.text && !plan?.shareReply && !plan?.getCodePhotoReply) {
        try {
          let quickReplies = [];
          try {
            const parsed = envelope.quick_replies ? JSON.parse(envelope.quick_replies) : [];
            if (Array.isArray(parsed)) quickReplies = parsed;
          } catch {
            /* no quick replies */
          }
          const chunks = [envelope.text, envelope.text2, envelope.text3].filter(Boolean);
          for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            const msg = { text: chunks[i] };
            if (isLast && quickReplies.length) {
              msg.quick_replies = quickReplies.map((q) => ({
                content_type: "text",
                title: String(q.title ?? "").slice(0, 20),
                payload: String(q.payload ?? ""),
              }));
            }
            const sent = await sendMessengerMessage(env, input.psid, msg, globalThis.fetch);
            if (!sent.ok) {
              console.error("Botcake first-user direct send failed", sent.error ?? "unknown");
              break;
            }
          }
        } catch (error) {
          console.error("Botcake first-user direct send failed", error instanceof Error ? error.message : "unknown");
        }
      }
      // Word cards, name completions, get-code replies and coptic-name
      // replies: send the text directly (awaited), like the voice below.
      // Live bug 23 Nov 2026: picking a suggestion returns only the
      // voice — the flow drops the card text on pick turns (it reads its
      // saved reply fields one run stale), while the voice, sent directly
      // by the Worker, always arrives. Same bug, second face: after a new
      // user types their name, the welcome + help text never arrives at
      // all (the name IS saved, the envelope is correct, the Worker just
      // never sends it directly and the flow drops it). Same bug, third
      // face (24 Nov 2026): after a user types their name + phone for
      // get-code, the code reply never arrives — the envelope is correct,
      // the Worker sent nothing directly, the flow drops it. Same bug,
      // fourth face (27 Nov 2026): /copticname's ask/answer would drop
      // the same way, so its plans ride the direct send too. Sending the
      // text directly too makes all four complete. On success the envelope
      // text is cleared so the flow sends nothing (no double); a chunk
      // that fails to send stays in the envelope so the flow tries it as
      // a fallback. Skipped for first-ever users (the direct send above
      // already delivered their text), and the name gate prompt is not a
      // word card (no wordCard flag), so a brand-new user still gets
      // FIRST_TIME_TEXT first.
      // The card carries no quick replies in the plan, so the five fixed
      // navigation buttons from the flow's Content #7 are attached here
      // (label as payload, so a tap arrives as the label and maps to its
      // command); a name completion carries its own replies (the main
      // menu), which the envelope already holds, so they ride instead.
      // A get-code reply likewise carries no replies, so it gets the
      // five fixed buttons too.
      if ((plan?.wordCard || plan?.nameCompleted || plan?.getCodeReply || plan?.copticNameReply) && envelope.text && !isFirstEver) {
        try {
          let quickReplies = [];
          try {
            const parsed = envelope.quick_replies ? JSON.parse(envelope.quick_replies) : [];
            if (Array.isArray(parsed)) quickReplies = parsed;
          } catch {
            /* no quick replies in the envelope */
          }
          if (!quickReplies.length) {
            quickReplies = ["البداية", "تعلّم", "القائمة", "كلمة عشوائية", "تواصل معنا"].map((title) => ({
              title,
              payload: title,
            }));
          }
          const chunks = [envelope.text, envelope.text2, envelope.text3].filter(Boolean);
          let sentCount = 0;
          for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            const msg = { text: chunks[i] };
            if (isLast && quickReplies.length) {
              msg.quick_replies = quickReplies.map((q) => ({
                content_type: "text",
                title: String(q.title ?? "").slice(0, 20),
                payload: String(q.payload ?? ""),
              }));
            }
            const sent = await sendMessengerMessage(env, input.psid, msg, globalThis.fetch);
            if (!sent.ok) {
              console.error("Botcake direct text send failed", sent.error ?? "unknown");
              break;
            }
            sentCount++;
          }
          // Clear only the chunks that landed, so the flow does not
          // resend them; a failed chunk stays in the envelope.
          if (sentCount > 0) envelope.text = "";
          if (sentCount > 1) envelope.text2 = "";
          if (sentCount > 2) envelope.text3 = "";
          if (sentCount > 0) envelope.has_text = "no";
          if (sentCount > 1) envelope.has_text2 = "no";
          if (sentCount > 2) envelope.has_text3 = "no";
          if (sentCount === chunks.length) envelope.quick_replies = "";
        } catch (error) {
          console.error("Botcake direct text send failed", error instanceof Error ? error.message : "unknown");
        }
      }
      // Get-code success (28 Nov 2026 redesign, Telegram's exact text):
      // the full reply text FIRST, then the example screenshot image
      // (Messenger has no photo captions — same words, same order).
      // The text goes out WHOLE as one message (Meta cap 2000 chars;
      // the reply is ~700), so the long wa.me link never hits the
      // Botcake chunk splitter — the 22 Nov 2026 bug, when the reply
      // rode the envelope and the splitter cut the URL mid-link. Same
      // direct-send pattern as /share below. On success the envelope
      // is cleared so the flow sends nothing (no double); a failed
      // text send leaves the text fields so the flow tries them (split,
      // degraded), and a failed image send leaves image_url as a flow
      // fallback. The five fixed nav buttons ride on the LAST message
      // (the image — Meta allows quick replies on attachment messages),
      // like the other direct sends.
      if (plan?.getCodePhotoReply && envelope.text && !isFirstEver) {
        try {
          let quickReplies = [];
          try {
            const parsed = envelope.quick_replies ? JSON.parse(envelope.quick_replies) : [];
            if (Array.isArray(parsed)) quickReplies = parsed;
          } catch {
            /* no quick replies in the envelope */
          }
          if (!quickReplies.length) {
            quickReplies = ["البداية", "تعلّم", "القائمة", "كلمة عشوائية", "تواصل معنا"].map((title) => ({
              title,
              payload: title,
            }));
          }
          const quickRepliesPayload = quickReplies.map((q) => ({
            content_type: "text",
            title: String(q.title ?? "").slice(0, 20),
            payload: String(q.payload ?? ""),
          }));
          const replyText = (Array.isArray(plan?.texts) ? plan.texts : []).map((t) => t?.text).filter(Boolean).join("\n\n");
          let textSent = false;
          if (replyText) {
            const sent = await sendMessengerMessage(env, input.psid, { text: replyText }, globalThis.fetch);
            textSent = Boolean(sent?.ok);
            if (!textSent) console.error("Botcake get-code text send failed", sent?.error ?? "unknown");
          }
          const imgUrl = Array.isArray(plan?.attachments)
            ? (plan.attachments.find((a) => a?.type === "image" && a?.url)?.url ?? "")
            : "";
          let imgSent = false;
          if (imgUrl) {
            const imgMsg = { ...messengerAttachmentMessage("image", imgUrl) };
            if (quickRepliesPayload.length) imgMsg.quick_replies = quickRepliesPayload;
            const imgRes = await sendMessengerMessage(env, input.psid, imgMsg, globalThis.fetch);
            imgSent = Boolean(imgRes?.ok);
            if (!imgSent) console.error("Botcake get-code image send failed", imgRes?.error ?? "unknown");
          }
          if (textSent) {
            envelope.text = "";
            envelope.text2 = "";
            envelope.text3 = "";
            envelope.has_text = "no";
            envelope.has_text2 = "no";
            envelope.has_text3 = "no";
          }
          if (imgSent) {
            envelope.image_url = "";
            envelope.has_image = "no";
          }
          if (textSent && imgSent) envelope.quick_replies = "";
        } catch (error) {
          console.error("Botcake get-code photo send failed", error instanceof Error ? error.message : "unknown");
        }
      }
      // /share (25 Nov 2026): the v2 launch announcement + poster. The
      // announcement is ~2,900 chars — the envelope only carries three
      // capped chunks, so the flow would truncate it (text3 is capped).
      // Send the image first, then the full text chunks, directly
      // (awaited), like the word-card fix above, and clear the envelope
      // so the flow sends nothing (no double). A failed image send
      // leaves image_url in the envelope as a flow fallback; a failed
      // text chunk leaves the text fields so the flow tries them.
      if (plan?.shareReply) {
        try {
          // Order (user's word, 25 Nov 2026): announcement chunks first,
          // then the poster image, then the closing share-ask line — the
          // last text in plan.texts is the closing line.
          const shareTexts = (Array.isArray(plan?.texts) ? plan.texts : []).map((t) => t?.text).filter(Boolean);
          const announcement = shareTexts.slice(0, -1);
          const closing = shareTexts.length ? shareTexts[shareTexts.length - 1] : "";
          let quickReplies = [];
          try {
            const parsed = envelope.quick_replies ? JSON.parse(envelope.quick_replies) : [];
            if (Array.isArray(parsed)) quickReplies = parsed;
          } catch {
            /* no quick replies in the envelope */
          }
          if (!quickReplies.length) {
            quickReplies = ["البداية", "تعلّم", "القائمة", "كلمة عشوائية", "تواصل معنا"].map((title) => ({
              title,
              payload: title,
            }));
          }
          const quickRepliesPayload = quickReplies.map((q) => ({
            content_type: "text",
            title: String(q.title ?? "").slice(0, 20),
            payload: String(q.payload ?? ""),
          }));
          let sentCount = 0;
          for (const text of announcement) {
            const sent = await sendMessengerMessage(env, input.psid, { text }, globalThis.fetch);
            if (!sent.ok) {
              console.error("Botcake share text send failed", sent.error ?? "unknown");
              break;
            }
            sentCount++;
          }
          const imgUrl = Array.isArray(plan?.attachments)
            ? (plan.attachments.find((a) => a?.type === "image" && a?.url)?.url ?? "")
            : "";
          let imgSent = false;
          if (imgUrl) {
            const imgRes = await sendMessengerMessage(env, input.psid, messengerAttachmentMessage("image", imgUrl), globalThis.fetch);
            imgSent = Boolean(imgRes?.ok);
            if (!imgSent) console.error("Botcake share image send failed", imgRes?.error ?? "unknown");
          }
          if (imgSent) {
            envelope.image_url = "";
            envelope.has_image = "no";
          }
          if (closing && sentCount === announcement.length) {
            const msg = { text: closing };
            if (quickRepliesPayload.length) msg.quick_replies = quickRepliesPayload;
            const sent = await sendMessengerMessage(env, input.psid, msg, globalThis.fetch);
            if (sent.ok) sentCount++;
            else console.error("Botcake share text send failed", sent.error ?? "unknown");
          }
          if (sentCount === shareTexts.length) {
            envelope.text = "";
            envelope.text2 = "";
            envelope.text3 = "";
            envelope.has_text = "no";
            envelope.has_text2 = "no";
            envelope.has_text3 = "no";
            envelope.quick_replies = "";
          }
        } catch (error) {
          console.error("Botcake share send failed", error instanceof Error ? error.message : "unknown");
        }
      }
      // Voice cannot be sent from a Botcake flow: the Audio step is
      // upload-only (no URL, no variable — Phase 0, 21 Nov 2026), so the
      // Worker sends the voice itself, delayed ~3 s so the flow's text
      // lands first (text before voice, the WhatsApp port's proven
      // order). Best-effort in waitUntil so the envelope is not delayed;
      // a failed send never blocks the reply, and the text card still
      // arrives when Meta's send restriction is up.
      if (plan?.voiceUrl && ctx?.waitUntil) {
        const voiceUrl = plan.voiceUrl;
        const repeats = plan.voiceRepeats ?? 3;
        ctx.waitUntil((async () => {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          try {
            await sendWordVoice(env, input.psid, voiceUrl, globalThis.fetch, repeats);
          } catch (error) {
            console.error("Botcake voice send failed", error instanceof Error ? error.message : "unknown");
          }
        })());
      }
      // Word card shown: love-react the user's message (❤️) — a direct
      // Graph call on the incoming message's id, in waitUntil like the
      // voice, so it never delays the envelope or the flow's text. It
      // only fires when the flow actually sent a message id (the live
      // flow's JSON API body does NOT — it sends psid/text/first_name
      // only — so this is a no-op live until the flow adds
      // "message_id": "{{last_message_id}}" or the equivalent variable
      // to its JSON API body; the variable name is UNVERIFIED, read it
      // off the flow builder's variable picker, do not guess it).
      // Without a message id there is nothing to react to, and the card
      // still goes out exactly as before.
      if (plan?.wordCard && input.messageId && ctx?.waitUntil) {
        const messageId = input.messageId;
        ctx.waitUntil((async () => {
          try {
            await sendMessengerReaction(env, messageId, "LOVE", globalThis.fetch);
          } catch (error) {
            console.error("Botcake reaction failed", error instanceof Error ? error.message : "unknown");
          }
        })());
      }
      // Video cannot be sent from a Botcake flow either: the Video step
      // takes a static URL or an upload — no variable (checked live
      // 21 Nov 2026: typing {{video_url}} is rejected as an invalid URL).
      // So the Worker sends the lesson video itself. 21 Nov 2026 (lesson
      // order fix): the send is AWAITED, not waitUntil — a lesson video
      // upload takes 17–30 s (Meta fetching + processing), and the flow's
      // photo/text (even with the 15 s conditional delay) can beat it, so
      // the lesson arrived text-first. Awaiting the video makes the
      // envelope return only after the video is sent, so the flow's
      // photo/text always land AFTER the video — Telegram's order
      // (video → photo → text). A failed send never blocks the reply.
      const videoAttachment = Array.isArray(plan?.attachments)
        ? plan.attachments.find((a) => a?.type === "video" && a?.url)
        : null;
      if (videoAttachment) {
        const videoUrl = videoAttachment.url;
        try {
          await sendMessengerMessage(env, input.psid, messengerAttachmentMessage("video", videoUrl), globalThis.fetch);
        } catch (error) {
          console.error("Botcake video send failed", error instanceof Error ? error.message : "unknown");
        }
      }
      // Certificates: a ready certificate arrives as BYTES (photoBytes),
      // not a URL — lookupCertificate downloads the image, and
      // certResultToPlan carries it as plan.photoBytes. The envelope only
      // maps plan.attachments (URLs) to image_url, so photoBytes was
      // silently dropped and only the caption text ever arrived — the
      // certificate itself was never sent (reported 21 Nov 2026). Send it
      // here, AWAITED like the video, so it lands before the flow's
      // caption text — the webhook order (photoBytes before texts). A
      // failed send never blocks the reply.
      if (plan?.photoBytes) {
        try {
          const photoResult = await sendMessengerPhotoBytes(env, input.psid, plan.photoBytes, globalThis.fetch);
          if (!photoResult.ok) {
            console.error("Botcake certificate photo send failed", photoResult.error ?? "unknown");
          }
        } catch (error) {
          console.error("Botcake certificate photo send failed", error instanceof Error ? error.message : "unknown");
        }
      }
      if (!envelope.text && !envelope.voice_url && !envelope.image_url && !envelope.video_url) {
        try {
          await sendMessengerSenderAction(env, input.psid, "typing_off");
        } catch {
          /* typing is best-effort only */
        }
      }
      console.log("botcake", JSON.stringify({
        psid: input.psid,
        ms: Date.now() - started,
        // Input shape only (never the content): tells a later diagnosis
        // whether a photo turn arrived empty, as its image URL, or as
        // text — the 28 Nov 2026 screenshot bug was a URL-as-text turn.
        textLen: String(input.text ?? "").length,
        textIsUrl: isBotcakeImageUrlText(input.text ?? ""),
        hasText: Boolean(envelope.text),
        hasVoice: Boolean(envelope.voice_url),
        hasImage: Boolean(envelope.image_url),
        hasVideo: Boolean(envelope.video_url),
      }));
      return Response.json(envelope);
    }

    if (url.pathname === "/messenger-webhook" && request.method === "POST") {
      if (!env.MESSENGER_APP_SECRET || !env.MESSENGER_PAGE_TOKEN) {
        return new Response("Forbidden", { status: 403 });
      }
      // The signature covers the raw body, so read it once as text and
      // parse the same bytes — request.json() would hide the raw form.
      let rawBody;
      try {
        rawBody = await request.text();
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      const signatureOk = await verifyMessengerSignature(rawBody, request.headers.get("x-hub-signature-256"), env.MESSENGER_APP_SECRET);
      if (!signatureOk) return new Response("Forbidden", { status: 403 });
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      if (body?.object !== "page") return new Response("EVENT_RECEIVED", { status: 200 });
      // Parity (learn / certs / get-code / admin) answers first; the
      // dictionary search is the fall-through. The parity handler is
      // built per request (cheap factory) so it closes over this env.
      // MESSENGER_ADMIN_PSID is the admin's page-scoped id, read from a
      // real admin message to the Page; unset, admin stays fail-closed.
      const planFor = await getPlanFor();
      // Fast-ack like the Telegram webhook: answer Meta 200 immediately and
      // keep processing in the background (Meta re-delivers after ~20s).
      // Tests call fetch without a Workers ctx, so there we still await to
      // keep them deterministic.
      const process = handleMessengerWebhookBody(env, body, planFor).catch((error) => {
        logError(env, error, { where: "messenger-webhook" });
        console.error("Messenger webhook failed", error instanceof Error ? error.message : "unknown error");
      });
      if (ctx?.waitUntil) {
        ctx.waitUntil(process);
        return new Response("EVENT_RECEIVED", { status: 200 });
      }
      await process;
      return new Response("EVENT_RECEIVED", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  },

  // Cron (*/5 * * * *): the keep-warm tick ALSO runs due scheduled
  // broadcasts (see /schedule in messenger-parity.js). The tick itself
  // warms a fresh isolate, so the keep-warm effect stays; a due job is
  // sent from here, at most ~5 minutes after its time (the cron grain).
  // A broadcast already running makes the tick a no-op for scheduling.
  async scheduled(event, env, ctx) {
    const adminPsid = String(env.MESSENGER_ADMIN_PSID ?? "").split(",").map((s) => s.trim()).filter(Boolean)[0] ?? null;
    const run = runDueScheduledBroadcasts(env, { adminPsid }).catch((error) => {
      console.error("Scheduled broadcast tick failed", error instanceof Error ? error.message : "unknown");
    });
    if (ctx?.waitUntil) ctx.waitUntil(run);
    else await run;
  },
};
