import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleTime, formatCairoDateTime } from "../src/schedule-time.js";

// Fixed "now": 2026-11-25 18:00 UTC = 20:00 Cairo (EET, UTC+2, no DST in Nov).
const NOW = Date.UTC(2026, 10, 25, 18, 0, 0);

test('parseScheduleTime: relative forms (Arabic + Western digits)', () => {
  assert.equal(parseScheduleTime('بعد ساعتين', NOW).ms, NOW + 2 * 60 * 60 * 1000);
  assert.equal(parseScheduleTime('بعد ساعة', NOW).ms, NOW + 60 * 60 * 1000);
  assert.equal(parseScheduleTime('بعد 30 دقيقة', NOW).ms, NOW + 30 * 60 * 1000);
  assert.equal(parseScheduleTime('بعد ٣٠ دقيقة', NOW).ms, NOW + 30 * 60 * 1000);
  assert.equal(parseScheduleTime('بعد 3 أيام', NOW).ms, NOW + 3 * 24 * 60 * 60 * 1000);
  assert.equal(parseScheduleTime('بعد يومين', NOW).ms, NOW + 2 * 24 * 60 * 60 * 1000);
  assert.equal(parseScheduleTime('بعد أسبوع', NOW).ms, NOW + 7 * 24 * 60 * 60 * 1000);
  assert.equal(parseScheduleTime('بعد 5 دقائق', NOW).ms, NOW + 5 * 60 * 1000);
});

test('parseScheduleTime: absolute Cairo times', () => {
  // 26/11 08:00 Cairo = 06:00 UTC.
  assert.equal(parseScheduleTime('26/11 08:00', NOW).ms, Date.UTC(2026, 10, 26, 6, 0));
  assert.equal(parseScheduleTime('26/11/2026 08:00', NOW).ms, Date.UTC(2026, 10, 26, 6, 0));
  // بكرة 08:00 Cairo = 26 Nov 06:00 UTC (NOW is 25 Nov 20:00 Cairo).
  assert.equal(parseScheduleTime('بكرة 08:00', NOW).ms, Date.UTC(2026, 10, 26, 6, 0));
  // النهاردة 21:00 Cairo = 19:00 UTC today.
  assert.equal(parseScheduleTime('النهاردة 21:00', NOW).ms, Date.UTC(2026, 10, 25, 19, 0));
  // Round-trip through the formatter.
  assert.equal(formatCairoDateTime(Date.UTC(2026, 10, 26, 6, 0)), '26/11/2026 08:00');
});

test('parseScheduleTime: rejects garbage, past times and far-future times', () => {
  assert.equal(parseScheduleTime('بعد شوية', NOW).ok, false);
  assert.equal(parseScheduleTime('أمس', NOW).ok, false);
  assert.equal(parseScheduleTime('26/11 25:00', NOW).ok, false);
  assert.equal(parseScheduleTime('النهاردة 20:00', NOW).ok, false, 'exactly now is not >1 min ahead');
  assert.equal(parseScheduleTime('النهاردة 19:00', NOW).ok, false, 'past time today');
  assert.equal(parseScheduleTime('26/11/2030 08:00', NOW).ok, false, 'over a year out');
  assert.equal(parseScheduleTime('', NOW).ok, false);
});
