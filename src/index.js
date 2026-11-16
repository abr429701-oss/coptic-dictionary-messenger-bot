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
// Routes: GET / (ready text), GET /health, GET+POST /messenger-webhook.
// Everything else is 404. The learn web app and privacy page still live
// on the Telegram Worker.

import records from "../data/dictionary.json" with { type: "json" };
import { messengerVoiceUrl } from "./neural-voice.js";
import {
  verifyMessengerSignature,
  handleMessengerWebhookBody,
  plainTextCard,
  buildQuickReplies,
  sendMessengerMessage,
  messengerTextMessage,
  MESSENGER_PICK_PREFIX,
} from "./messenger.js";
import {
  createMessengerParity,
  MESSENGER_PARITY_PAYLOAD_PREFIXES,
  parityHelpText,
  MAIN_MENU_ITEMS,
} from "./messenger-parity.js";
import { suggestSimilar } from "./new-features.js";
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
  matchedPartIndex,
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
    // the name ONLY on /start, never on a first word: a new user who
    // searches directly gets results, and is prompted the first time
    // they send /start. While awaitingName, plain text is the name
    // attempt (validated by isValidFullName, the same rule); commands
    // keep working, /cancel never clears the gate (it clears an open
    // cert/get-code flow, or falls back to Telegram's "write the word"
    // text), and quick-reply picks are never gated — planFor.pick
    // bypasses this entirely, like Telegram's menu handler running
    // before its name check. A banned user stays silent: the ban check
    // runs first and the gate returns null so parity silences them.
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
        if (parity.certAwaiting || parity.getcodeStep || parity.getcodeName || parity.examAwaiting) {
          next.parity = { ...parity, certAwaiting: undefined, getcodeStep: undefined, getcodeName: undefined, examAwaiting: undefined };
        }
        await saveUser(env, `msgr:${senderId}`, next);
        return { texts: [{ text: FIRST_TIME_TEXT }], voiceUrl: null };
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
          await saveUser(env, `msgr:${senderId}`, { ...record, parity: { ...parity, getcodeStep: undefined, getcodeName: undefined } });
          return { texts: [{ text: "✅ تم إلغاء الحصول على الرقم الكودي." }], voiceUrl: null };
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
    // priority is Telegram's: recorded human first, then prebuilt Polly,
    // then Joanna (see messengerVoiceUrl in neural-voice.js). The ×3
    // repeat in the transport applies to whichever voice is served.
    function messengerCardPlan(env, record, searchedWord, partIndex = -1) {
      if (!record) return { texts: [], voiceUrl: null };
      return {
        texts: [{ text: plainTextCard(formatRecord(record, partIndex, searchedWord)) }],
        voiceUrl: record.id != null ? messengerVoiceUrl(env, record) : null,
      };
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
            return messengerPickPlan(env, live.indices[globalAt]);
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
          return messengerCardPlan(env, record, text, matchedPartIndex(record, normalized));
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

    function messengerPickPlan(env, index) {
      const record = records[index];
      if (!record) return { texts: [{ text: "لم أجد هذه الكلمة، ابحث عنها مرة أخرى." }], voiceUrl: null };
      return messengerCardPlan(env, record, "", -1);
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
      const macroConfig = await driveConfig(env).catch(() => null);
      const messengerParity = createMessengerParity({
        adminPsids: (env.MESSENGER_ADMIN_PSID ?? "").split(","),
        macroUrl: macroConfig?.url ?? null,
        fetchLiveExamPattern,
        lookupCodeName,
        loadState: (psid) => messengerParityLoadState(env, psid),
        saveState: (psid, next) => messengerParitySaveState(env, psid, next),
        isBanned: (psid) => isBanned(env, psid),
        adminStore: {
          get: async (key) => (await storeCall(env, { op: "get", key })).value ?? null,
          put: async (key, value) => { await storeCall(env, { op: "put", key, value }); return true; },
          del: async (key) => { await storeCall(env, { op: "put", key, value: null }); return true; },
        },
        getUserRecord: async (psid) => {
          // Messenger users live under `user:msgr:<PSID>`; a bare-PSID
          // lookup would miss (or hit a Telegram user).
          const record = await getUser(env, `msgr:${psid}`);
          if (!record) return null;
          return { record, history: await getUserHistory(env, `msgr:${psid}`) };
        },
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
        listErrors: async () => {
          const entries = env.USERS ? ((await storeCall(env, { op: "get", key: "errors:recent" }).catch(() => null))?.value ?? []) : [];
          return (Array.isArray(entries) ? entries : []).slice(-30).reverse().map((e) => ({ at: e?.at ?? null, where: e?.where ?? e?.kind ?? "?", message: e?.message ?? String(e ?? "") }));
        },
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
        runUserCommand: null, // dispatch commands fall through to search
        getDictAudit: () => messengerDictAudit(env),
        deleteVoice: null, // voice files live on the audio branch / DO
        getBroadcastControl: () => broadcastControlState(env),
        setBroadcastControl: async (patch) => { await setBroadcastControl(env, patch); return true; },
        getBroadcastStats: () => storeCall(env, { op: "bcstatus" }),
        editDictionary: null, // Apps Script dictionary-admin route, unwired
        runTask: null, // job tasks run via plan.task (see executeTask)
      });
      const planFor = {
        // Parity first: flows (cert/get-code/exam), menus, commands.
        // A bare number is routed by recency — whichever list (parity
        // menu vs dictionary list) was sent most recently wins — so a
        // number typed after a word search picks the word, not a stale
        // menu, and vice versa. While a parity flow is active (a cert
        // code, a get-code step, an exam code, a broadcast/confirm
        // pending), the number belongs to the flow, not to any list.
        text: async (query, senderId) => {
          // First-time name registration (Telegram parity): the gate
          // runs before flows and search; a plan means the turn is
          // answered here, null means normal routing (commands, flows,
          // dictionary search) proceeds untouched.
          if (senderId != null) {
            const namePlan = await messengerNameGate(env, senderId, query, ctx);
            if (namePlan) return namePlan;
          }
          // Dictionary-list paging ("التالي ⏭" / "⏮ السابق", typed):
          // a live list turns one page — unless a parity flow is active
          // (a code/name/phone is expected), a lesson is open (lesson nav
          // owns these words there), or a parity menu is newer than the
          // list — then parity answers as today.
          const navDir = messengerListNavDirection(query);
          if (navDir !== 0 && senderId != null) {
            const parityState = await messengerParityLoadState(env, senderId);
            const flowActive = Boolean(parityState?.certAwaiting || parityState?.getcodeStep || parityState?.examAwaiting || parityState?.pendingBroadcast || parityState?.pendingConfirm);
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
            const flowActive = Boolean(parityState?.certAwaiting || parityState?.getcodeStep || parityState?.examAwaiting || parityState?.pendingBroadcast || parityState?.pendingConfirm);
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
          return messengerSearchPlan(env, query, senderId);
        },
        pick: async (payload, senderId) => {
          if (typeof payload === "string" && MESSENGER_PARITY_PAYLOAD_PREFIXES.some((p) => payload.startsWith(p))) {
            return messengerParity.handlePick(senderId, payload);
          }
          // Dictionary-list paging quick replies ("التالي ⏭" / "⏮ السابق"):
          // the payload carries no record index, so it turns the stored
          // list instead of picking. Bypasses the name gate like picks do.
          if (payload === MESSENGER_LIST_NAV_NEXT) return messengerListPagePlan(env, senderId, 1);
          if (payload === MESSENGER_LIST_NAV_PREV) return messengerListPagePlan(env, senderId, -1);
          const index = Number(payload);
          return messengerPickPlan(env, index);
        },
        executeTask: (task, senderId, fetchImpl) => executeMessengerTask(env, task, senderId, fetchImpl, { ctx }),
      };
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

  // Keep-warm cron (*/5 * * * *): a no-op tick so a fresh isolate is warm
  // when the next webhook arrives. No learn sync, no poller on this Worker.
  async scheduled(event, env, ctx) {
    // no-op
  },
};
