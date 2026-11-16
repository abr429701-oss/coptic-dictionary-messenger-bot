// Dispatch commands (src/dispatch-commands.js) — routing + state tests.
// No live network: the DO user record and adminStore are in-memory fakes.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createDispatchCommands,
  PARKED_DISPATCH_MESSAGES,
  PARKED_DISPATCH_COMMANDS,
  MESSENGER_PAGE_URL,
} from "../src/dispatch-commands.js";
import { ADMIN_DISPATCH_COMMANDS } from "../src/messenger-parity.js";

const USER = "987654321098765";
const ADMIN = "123456789012345";
const WORD = "ⲁⲑⲙⲟϣⲓ";

function makeStore() {
  const users = new Map(); // psid -> { record, history }
  const kv = new Map();
  const deps = {
    getUserRecord: async (psid) => users.get(String(psid)) ?? null,
    saveUserRecord: async (psid, record) => {
      const cur = users.get(String(psid)) ?? { record: {}, history: [] };
      cur.record = record;
      users.set(String(psid), cur);
      return true;
    },
    clearHistory: async (psid) => {
      const cur = users.get(String(psid));
      if (cur) cur.history = [];
      return true;
    },
    wordCard: async (record) => ({ texts: [{ text: `CARD ${record.id}` }], voiceUrl: "https://example.invalid/v.ogg" }),
    hasRecordedVoice: async (id) => id === 55,
    adminStore: {
      get: async (key) => kv.get(key) ?? null,
      put: async (key, value) => { kv.set(key, value); return true; },
      del: async (key) => { kv.delete(key); return true; },
    },
    isAdmin: (psid) => String(psid) === ADMIN,
    firstAdminPsid: ADMIN,
    listErrors: async () => [{ at: Date.now(), where: "test", message: "boom" }],
  };
  return { deps, users, kv };
}

function seedUser(users, psid, record = {}, history = []) {
  users.set(String(psid), { record: { ...record }, history: [...history] });
  return users.get(String(psid));
}

function planText(plan) {
  assert.ok(plan, "expected a plan, not null");
  assert.ok(Array.isArray(plan.texts) && plan.texts.length, "expected at least one text");
  return plan.texts.map((t) => t.text).join("\n");
}

// One arg per command that needs one (a real dictionary word where the
// handler looks one up).
const ARGS = {
  wordsearch: WORD,
  wordinfo: WORD,
  translate: WORD,
  similar: WORD,
  startswith: "ⲁ",
  pronounce: WORD,
  fav: "",
  myfav: "",
  favorites: "",
  mywords: "",
  removefav: WORD,
  suggestword: `${WORD} — معنى`,
  contribute: `${WORD} — معنى`,
  notify: "",
};

test("every implemented dispatch command returns a real plan, never the placeholder", async () => {
  const { deps, users } = makeStore();
  seedUser(users, USER, {}, [{ q: WORD }]);
  const run = createDispatchCommands(deps);
  const implemented = [...ADMIN_DISPATCH_COMMANDS].filter((c) => !PARKED_DISPATCH_COMMANDS.has(c));
  assert.equal(implemented.length, 44, "44 of 57 dispatch commands are implemented (12 parked + lang moved to na)");
  for (const cmd of implemented) {
    const plan = await run(cmd, ARGS[cmd] ?? "", USER);
    const text = planText(plan);
    assert.ok(!text.includes("لم يتم توصيله بعد"), `/${cmd} must not reach the unwired placeholder`);
    assert.ok(!text.includes("يعمل في المسار الخاص به"), `/${cmd} must not show the old placeholder`);
  }
});

test("each parked command returns its honest paused message", async () => {
  const { deps } = makeStore();
  const run = createDispatchCommands(deps);
  assert.equal(PARKED_DISPATCH_COMMANDS.size, 12);
  for (const cmd of PARKED_DISPATCH_COMMANDS) {
    const plan = await run(cmd, "", USER);
    assert.equal(planText(plan), PARKED_DISPATCH_MESSAGES[cmd], `/${cmd} must answer with its parked message`);
  }
  // The parked set is exactly the 12 quiz/game commands the user parked
  // on 2026-11-13 — /daily is a summary, not a quiz, and is implemented.
  assert.ok(!PARKED_DISPATCH_COMMANDS.has("daily"), "/daily is implemented, not parked");
  assert.ok(!PARKED_DISPATCH_COMMANDS.has("wod"), "/wod is implemented, not parked");
});

test("voice prefs flip the stored preference and voicesettings reflects them", async () => {
  const { deps, users } = makeStore();
  seedUser(users, USER, {});
  const run = createDispatchCommands(deps);
  let plan = await run("voiceoff", "", USER);
  assert.match(planText(plan), /لن يُرسل النطق/u);
  assert.equal(users.get(USER).record.voiceOff, true);
  plan = await run("voicesettings", "", USER);
  assert.match(planText(plan), /متوقف/u);
  assert.match(planText(plan), /3 مرات/u);
  plan = await run("voiceonce", "", USER);
  assert.match(planText(plan), /مرة واحدة/u);
  assert.equal(users.get(USER).record.voiceRepeats, 1);
  plan = await run("voicesettings", "", USER);
  assert.match(planText(plan), /مرة واحدة/u);
  plan = await run("voicethree", "", USER);
  assert.match(planText(plan), /3 مرات/u);
  assert.equal(users.get(USER).record.voiceRepeats, 3);
  plan = await run("voiceon", "", USER);
  assert.match(planText(plan), /سيعود إرسال النطق/u);
  assert.equal(users.get(USER).record.voiceOff, undefined, "voiceon removes the flag (no stale key)");
});

test("favorites: /fav saves the last search, /myfav lists, /removefav drops", async () => {
  const { deps, users } = makeStore();
  seedUser(users, USER, {}, [{ q: WORD }]);
  const run = createDispatchCommands(deps);
  // No history at all -> honest hint, nothing saved.
  const empty = await run("fav", "", ADMIN);
  assert.match(planText(empty), /ابحث عن كلمة أولًا/u);
  const added = await run("fav", "", USER);
  assert.match(planText(added), /تمت إضافة/u);
  assert.equal(users.get(USER).record.favorites.length, 1);
  assert.equal(users.get(USER).record.favorites[0].word, WORD);
  const again = await run("fav", "", USER);
  assert.match(planText(again), /في مفضلتك بالفعل/u);
  const list = await run("myfav", "", USER);
  assert.match(planText(list), new RegExp(WORD, "u"));
  assert.match(planText(list), /حذف: \/myfav/u);
  const removed = await run("removefav", WORD, USER);
  assert.match(planText(removed), /حُذفت/u);
  assert.equal(users.get(USER).record.favorites.length, 0);
  const emptyList = await run("myfav", "", USER);
  assert.match(planText(emptyList), /مفضلتك فارغة/u);
});

test("favorites cap at 50: the oldest drops when a new one is added", async () => {
  const { deps, users } = makeStore();
  const favs = Array.from({ length: 50 }, (_, i) => ({ word: `كلمة${i}`, meaning: "x", id: i }));
  seedUser(users, USER, { favorites: favs }, [{ q: WORD }]);
  const run = createDispatchCommands(deps);
  await run("fav", "", USER);
  const kept = users.get(USER).record.favorites;
  assert.equal(kept.length, 50);
  assert.equal(kept[0].word, "كلمة1", "oldest favorite dropped");
  assert.equal(kept[49].word, WORD);
});

test("subscribe / unsubscribe / notify flip their flags", async () => {
  const { deps, users } = makeStore();
  seedUser(users, USER, {});
  const run = createDispatchCommands(deps);
  await run("subscribe", "", USER);
  assert.equal(users.get(USER).record.wodSub, true);
  await run("unsubscribe", "", USER);
  assert.equal(users.get(USER).record.wodSub, false);
  await run("notify", "", USER);
  assert.equal(users.get(USER).record.notify, true);
  await run("notify", "off", USER);
  assert.equal(users.get(USER).record.notify, false);
});

test("daily summary and word of the day use the real word card", async () => {
  const { deps, users } = makeStore();
  seedUser(users, USER, { favorites: [{ word: WORD, meaning: "x", id: 155 }] }, [{ q: WORD }, { q: "ⲁ" }]);
  const run = createDispatchCommands(deps);
  const daily = await run("daily", "", USER);
  const dailyText = planText(daily);
  assert.match(dailyText, /ملخصك اليومي/u);
  assert.match(dailyText, /كلمة اليوم/u);
  assert.match(dailyText, /مفضلتك: 1/u);
  assert.match(dailyText, /عمليات بحث محفوظة: 2/u);
  const wod = await run("wod", "", USER);
  assert.match(planText(wod), /^CARD \d+$/u, "wod returns the word-card plan");
  const random = await run("random", "", USER);
  assert.match(planText(random), /^CARD \d+$/u);
  const stats = await run("mystats", "", USER);
  assert.match(planText(stats), /كلماتك المفضلة: 1/u);
  assert.match(planText(stats), /عمليات بحث محفوظة: 2/u);
  const recent = await run("recent", "", USER);
  assert.match(planText(recent), new RegExp(WORD, "u"));
});

test("dictionary features return real content, with usage hints when the arg is missing", async () => {
  const { deps } = makeStore();
  const run = createDispatchCommands(deps);
  assert.match(planText(await run("wordinfo", WORD, USER)), /معلومات الكلمة/u);
  assert.match(planText(await run("wordinfo", WORD, USER)), /صف \d+/u);
  assert.match(planText(await run("wordsearch", WORD, USER)), /نتائج/u);
  assert.match(planText(await run("translate", WORD, USER)), /عربي:/u);
  assert.match(planText(await run("similar", WORD, USER)), /كلمات شقيقة/u);
  assert.match(planText(await run("startswith", "ⲁ", USER)), /تبدأ بـ/u);
  assert.match(planText(await run("longest", "", USER)), /أطول/u);
  assert.match(planText(await run("letterstats", "", USER)), /توزيع.*على الحروف الأولى/u);
  assert.match(planText(await run("alphabet", "", USER)), /الحروف القبطية/u);
  assert.match(planText(await run("copticdate", "", USER)), /التاريخ القبطي/u);
  assert.match(planText(await run("origins", "", USER)), /أصول الكلمات/u);
  assert.match(planText(await run("vocab", "", USER)), /مفردات/u);
  assert.match(planText(await run("pronounce", WORD, USER)), /النطق/u);
  assert.match(planText(await run("pronounce", WORD, USER)), /النقل الصوتي/u);
  for (const cmd of ["wordinfo", "wordsearch", "translate", "similar", "startswith", "pronounce"]) {
    assert.match(planText(await run(cmd, "", USER)), /الاستخدام/u, `/${cmd} without an arg must show its usage`);
  }
  assert.match(planText(await run("wordinfo", "zzzznotaword", USER)), /لم أجد/u);
  assert.match(planText(await run("search", "", USER)), /أرسل الكلمة/u);
});

test("support: suggest stores + notifies the admin; tickets, alerts, exitsupport", async () => {
  const { deps, kv } = makeStore();
  const run = createDispatchCommands(deps);
  const noArg = await run("suggestword", "", USER);
  assert.match(planText(noArg), /اكتب اقتراحك/u);
  const sent = await run("contribute", `${WORD} — معنى جديد`, USER);
  assert.match(planText(sent), /تم استلام مساهمتك/u);
  assert.deepEqual(sent.task, {
    type: "send-dm",
    to: ADMIN,
    text: `💡 مساهمة جديدة من ${USER}:\n${WORD} — معنى جديد`,
    from: USER,
  });
  assert.equal(kv.get("msgr:suggestions").length, 1);
  const hint = await run("suggestions", "", USER);
  assert.match(planText(hint), /\/suggestword/u, "a non-admin gets the hint, not the list");
  const list = await run("suggestions", "", ADMIN);
  assert.match(planText(list), new RegExp(WORD, "u"));
  const noTickets = await run("mytickets", "", USER);
  assert.match(planText(noTickets), /ليس لديك تذاكر دعم/u);
  kv.set("msgr:tickets", [{ id: "TKT-7", userId: USER, status: "open", text: "مشكلة في الدرس", replies: [] }]);
  const mine = await run("mytickets", "", USER);
  assert.match(planText(mine), /TKT-7/u);
  assert.match(planText(mine), /مفتوحة/u);
  const alertsUser = await run("alerts", "", USER);
  assert.match(planText(alertsUser), /للأدمن فقط/u);
  const alertsAdmin = await run("alerts", "", ADMIN);
  assert.match(planText(alertsAdmin), /حالة التنبيهات/u);
  assert.match(planText(alertsAdmin), /أخطاء مسجلة \(آخر 50\): 1/u);
  kv.set(`msgr:supportflow:${USER}`, { step: 1 });
  const exited = await run("exitsupport", "", USER);
  assert.match(planText(exited), /تم إنهاء وضع الدعم/u);
  assert.equal(kv.has(`msgr:supportflow:${USER}`), false);
  const invite = await run("invite", "", USER);
  assert.ok(planText(invite).includes(MESSENGER_PAGE_URL), "invite shares the verified Page URL");
  const myref = await run("myref", "", USER);
  assert.ok(planText(myref).includes(MESSENGER_PAGE_URL));
  assert.match(planText(myref), /غير متاح على ماسنجر بعد/u);
  assert.match(planText(await run("toptop", "", USER)), /غير مبنية على ماسنجر/u);
  assert.match(planText(await run("refinfo", "", USER)), /للأدمن فقط/u);
  assert.match(planText(await run("refinfo", "", ADMIN)), /غير متاحة على ماسنجر/u);
});

test("clearhistory clears and reports honestly; recent shows the saved queries", async () => {
  const { deps, users } = makeStore();
  seedUser(users, USER, {}, [{ q: WORD }, { q: "ⲁ" }]);
  const run = createDispatchCommands(deps);
  const recent = await run("recent", "", USER);
  assert.match(planText(recent), new RegExp(WORD, "u"));
  const cleared = await run("clearhistory", "", USER);
  assert.match(planText(cleared), /تم مسح سجل/u);
  assert.deepEqual(users.get(USER).history, []);
  const empty = await run("clearhistory", "", USER);
  assert.match(planText(empty), /فارغ أصلًا/u);
  const noRecent = await run("recent", "", USER);
  assert.match(planText(noRecent), /لا توجد عمليات بحث/u);
});

test("unknown command returns null (falls through); a dep failure answers with a retry text", async () => {
  const { deps } = makeStore();
  const run = createDispatchCommands(deps);
  assert.equal(await run("not-a-command", "", USER), null);
  const failing = createDispatchCommands({
    ...deps,
    wordCard: async () => { throw new Error("do-down"); },
  });
  const plan = await failing("wod", "", USER);
  assert.match(planText(plan), /حدث خطأ أثناء تنفيذ الأمر/u);
});

test("wordinfo shows the recorded-voice flag from the overlay dep", async () => {
  const { deps } = makeStore();
  const run = createDispatchCommands(deps);
  // id 55 has a recorded voice in the fake dep; ⲁⲑⲙⲟϣⲓ (155) does not.
  const noVoice = await run("wordinfo", WORD, USER);
  assert.match(planText(noVoice), /صوت مسجل: لا/u);
  const withVoice = await run("pronounce", "ⲁⲅⲅⲉⲗⲉⲓⲛ", USER);
  assert.match(planText(withVoice), /متوفر — ابحث عن الكلمة لسماعها/u);
});
