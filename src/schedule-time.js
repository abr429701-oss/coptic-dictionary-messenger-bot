// schedule-time.js — parse a broadcast schedule time (Cairo local time).
// Same rules as the Telegram bot's parseScheduleTime:
//   relative: "بعد ساعتين" / "بعد 30 دقيقة" / "بعد 3 أيام" / "بعد أسبوع"
//   absolute: "بكرة 08:00" / "النهاردة 20:00" / "26/11 08:00" / "26/11/2026 08:00"
// Arabic-Indic digits work like Western ones. Returns { ok: true, ms } or
// { ok: false, error } with an Arabic message.
const SCHEDULE_MIN_AHEAD_MS = 60 * 1000;
const SCHEDULE_MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
function normalizeScheduleDigits(text) {
  return String(text ?? '').replace(/[٠-٩۰-۹]/gu, (d) => ARABIC_DIGITS[d] ?? d);
}
const CAIRO_TZ = 'Africa/Cairo';
function cairoOffsetMs(atMs) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: CAIRO_TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(atMs)).map((p) => [p.type, p.value]));
  const wallAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return wallAsUtc - atMs;
}
function cairoWallToMs(year, month, day, hour, minute) {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = cairoOffsetMs(wallAsUtc);
  let ms = wallAsUtc - first;
  const second = cairoOffsetMs(ms);
  if (second !== first) ms = wallAsUtc - second;
  return ms;
}
export function formatCairoDateTime(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: CAIRO_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)).replace(',', '');
}
function cairoTodayParts(nowMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: CAIRO_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs)).map((p) => [p.type, Number(p.value)]));
  return { year: parts.year, month: parts.month, day: parts.day };
}
function finishScheduleTime(ms, nowMs) {
  if (!Number.isFinite(ms)) return { ok: false, error: '❌ لم أفهم الميعاد.' };
  if (ms <= nowMs + SCHEDULE_MIN_AHEAD_MS) return { ok: false, error: '❌ الميعاد لازم يكون في المستقبل (بعد دقيقة على الأقل).' };
  if (ms > nowMs + SCHEDULE_MAX_AHEAD_MS) return { ok: false, error: '❌ الميعاد بعيد أوي — أقصى حاجة سنة من دلوقتي.' };
  return { ok: true, ms };
}
export function parseScheduleTime(input, nowMs = Date.now()) {
  const raw = normalizeScheduleDigits(input).trim().replace(/\s+/gu, ' ');
  const fail = () => ({ ok: false, error: '❌ لم أفهم الميعاد. جرّب: «بعد ساعتين» أو «بعد 30 دقيقة» أو «بكرة 08:00» أو «26/11 08:00».' });
  if (!raw) return fail();
  const relative = raw.match(/^بعد\s+(.+)$/u);
  if (relative) {
    const rest = relative[1].trim();
    const units = [
      [/^(?:(\d+)\s*)?(?:دقيقة|دقائق|دقيقه)$/u, 60 * 1000],
      [/^(?:(\d+)\s*)?(?:ساعة|ساعات|ساعه)$/u, 60 * 60 * 1000],
      [/^(?:(\d+)\s*)?(?:يوم|أيام|ايام)$/u, 24 * 60 * 60 * 1000],
      [/^(?:(\d+)\s*)?(?:أسبوع|أسابيع|اسبوع)$/u, 7 * 24 * 60 * 60 * 1000],
    ];
    const dualMs = { 'دقيقتين': 60 * 1000, 'ساعتين': 60 * 60 * 1000, 'يومين': 24 * 60 * 60 * 1000, 'أسبوعين': 7 * 24 * 60 * 60 * 1000 };
    for (const [pattern, unitMs] of units) {
      const m = rest.match(pattern);
      if (m) {
        const n = m[1] ? Number(m[1]) : 1;
        if (!Number.isFinite(n) || n < 1 || n > 366) return fail();
        return finishScheduleTime(nowMs + n * unitMs, nowMs);
      }
    }
    if (Object.hasOwn(dualMs, rest)) return finishScheduleTime(nowMs + 2 * dualMs[rest], nowMs);
    return fail();
  }
  const timeOnly = raw.match(/^(?:بكرة|بكرا|غداً|غدا|النهاردة|النهارده|اليوم)\s+(\d{1,2}):(\d{2})$/u);
  if (timeOnly) {
    const word = raw.split(/\s+/u)[0];
    const hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    if (hour > 23 || minute > 59) return fail();
    const today = cairoTodayParts(nowMs);
    const addDays = /^(?:بكرة|بكرا|غداً|غدا)$/u.test(word) ? 1 : 0;
    const base = new Date(Date.UTC(today.year, today.month - 1, today.day + addDays));
    return finishScheduleTime(cairoWallToMs(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hour, minute), nowMs);
  }
  const dated = raw.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?\s+(\d{1,2}):(\d{2})$/u);
  if (dated) {
    const day = Number(dated[1]);
    const month = Number(dated[2]);
    const hour = Number(dated[4]);
    const minute = Number(dated[5]);
    if (day < 1 || day > 31 || month < 1 || month > 12 || hour > 23 || minute > 59) return fail();
    const year = dated[3] ? Number(dated[3]) : cairoTodayParts(nowMs).year;
    return finishScheduleTime(cairoWallToMs(year, month, day, hour, minute), nowMs);
  }
  return fail();
}
