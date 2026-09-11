/**
 * Unit tests for the timeline's arithmetic.
 *
 * `src/lib/timeline/scale.ts` is pure on purpose, so the part of the chart most
 * likely to be wrong is the part that needs no app, no window and no database
 * to test. Node 24 strips the types itself — no test runner, no new dependency,
 * nothing downloaded.
 *
 *   node scripts/timeline-test.mjs
 *
 * The timezone tests are the point of the file. `new Date('2026-03-01')` parses
 * as UTC midnight and reports its LOCAL parts, so in America/Chicago it answers
 * "February 28" and every bar on the chart lands one day left of where it
 * belongs. These assertions are run under a spread of offsets to prove the
 * module never touches a local-time getter.
 */

import * as S from '../src/lib/timeline/scale.ts';

let passed = 0;
const failures = [];

function ok(label, cond) {
  if (cond) passed++;
  else failures.push(label);
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}

// --- conversions ------------------------------------------------------------

eq('epoch is day 0', S.toDayIndex('1970-01-01'), 0);
eq('day 0 round-trips', S.fromDayIndex(0), '1970-01-01');
eq('a known date', S.toDayIndex('2026-08-28'), 20693);
eq('and back', S.fromDayIndex(20693), '2026-08-28');
eq('leap day exists', S.spanDays('2024-02-28', '2024-03-01'), 3);
eq('non-leap February', S.spanDays('2026-02-28', '2026-03-01'), 2);
eq('addDays crosses a month', S.addDays('2026-01-31', 1), '2026-02-01');
eq('addDays crosses a year', S.addDays('2026-12-31', 1), '2027-01-01');
eq('addDays goes backwards', S.addDays('2026-01-01', -1), '2025-12-31');

// Inclusive spans. A one-day task is one day wide, never zero — a zero-width
// bar is an invisible bar.
eq('same day is one day', S.spanDays('2026-03-04', '2026-03-04'), 1);
eq('a working week', S.spanDays('2026-03-02', '2026-03-06'), 5);

// A thousand consecutive days round-trip, so nothing drifts across DST
// boundaries, month lengths or year ends.
let drift = 0;
for (let i = 20000; i < 21000; i++) {
  if (S.toDayIndex(S.fromDayIndex(i)) !== i) drift++;
}
eq('1000 days round-trip with no drift', drift, 0);

// --- the timezone trap ------------------------------------------------------
//
// Re-running the whole conversion suite under offsets either side of UTC. If
// any function reaches for a local getter, one of these fails and the other
// does not — which is exactly the shape of the bug in the wild.

const TZS = ['UTC', 'America/Chicago', 'Pacific/Kiritimati', 'Pacific/Niue', 'Asia/Kolkata'];
for (const tz of TZS) {
  process.env.TZ = tz;
  eq(`[${tz}] month start survives`, S.fromDayIndex(S.toDayIndex('2026-03-01')), '2026-03-01');
  eq(`[${tz}] year start survives`, S.fromDayIndex(S.toDayIndex('2026-01-01')), '2026-01-01');
  ok(`[${tz}] 2026-03-01 is a month start`, S.isMonthStart(S.toDayIndex('2026-03-01')));
  ok(`[${tz}] 2026-01-01 is a year start`, S.isYearStart(S.toDayIndex('2026-01-01')));
  eq(`[${tz}] monthStart of mid-month`, S.fromDayIndex(S.monthStart(S.toDayIndex('2026-03-17'))), '2026-03-01');
}
process.env.TZ = 'America/Chicago';

// --- the week starts on Monday ----------------------------------------------

eq('1970-01-05 was a Monday', S.weekday(S.toDayIndex('1970-01-05')), 0);
eq('1970-01-01 was a Thursday', S.weekday(S.toDayIndex('1970-01-01')), 3);
eq('2026-08-28 is a Friday', S.weekday(S.toDayIndex('2026-08-28')), 4);
ok('Saturday is a weekend', S.isWeekend(S.toDayIndex('2026-08-29')));
ok('Sunday is a weekend', S.isWeekend(S.toDayIndex('2026-08-30')));
ok('Monday is not', !S.isWeekend(S.toDayIndex('2026-08-31')));
ok('Friday is not', !S.isWeekend(S.toDayIndex('2026-08-28')));
ok('Monday is a Monday', S.isMonday(S.toDayIndex('2026-08-31')));

// weekStart walks back to Monday, and is a no-op on one.
eq('weekStart from a Friday', S.fromDayIndex(S.weekStart(S.toDayIndex('2026-08-28'))), '2026-08-24');
eq('weekStart from a Sunday', S.fromDayIndex(S.weekStart(S.toDayIndex('2026-08-30'))), '2026-08-24');
eq('weekStart of a Monday is itself', S.fromDayIndex(S.weekStart(S.toDayIndex('2026-08-31'))), '2026-08-31');

// Every day of one year: exactly 7 weekdays per week, exactly 2 of them weekend.
let weekendCount = 0;
const yearStart = S.toDayIndex('2026-01-01');
for (let i = 0; i < 365; i++) if (S.isWeekend(yearStart + i)) weekendCount++;
eq('2026 has 104 weekend days', weekendCount, 104);

// --- quarters ---------------------------------------------------------------

ok('Jan 1 starts a quarter', S.isQuarterStart(S.toDayIndex('2026-01-01')));
ok('Apr 1 starts a quarter', S.isQuarterStart(S.toDayIndex('2026-04-01')));
ok('Jul 1 starts a quarter', S.isQuarterStart(S.toDayIndex('2026-07-01')));
ok('Oct 1 starts a quarter', S.isQuarterStart(S.toDayIndex('2026-10-01')));
ok('Feb 1 does not', !S.isQuarterStart(S.toDayIndex('2026-02-01')));
ok('Apr 2 does not', !S.isQuarterStart(S.toDayIndex('2026-04-02')));

// --- domain -----------------------------------------------------------------

const dom = S.relativeDomain('2026-08-28', 14, 90);
ok('domain starts on a Monday', S.isMonday(dom.start));
ok('domain ends on a Sunday', S.weekday(dom.end) === 6);
ok('domain contains today', dom.start <= S.toDayIndex('2026-08-28') && dom.end >= S.toDayIndex('2026-08-28'));
ok('domain reaches back at least 14 days', S.toDayIndex('2026-08-28') - dom.start >= 14);
ok('domain reaches forward at least 90 days', dom.end - S.toDayIndex('2026-08-28') >= 90);
eq('whole weeks', S.domainDays(dom) % 7, 0);

const fit = S.fitDomain(['2026-09-10', '2026-09-01', '2026-10-02'], '2026-08-28');
ok('fit contains the earliest', fit.start <= S.toDayIndex('2026-09-01'));
ok('fit contains the latest', fit.end >= S.toDayIndex('2026-10-02'));
ok('fit still contains today', fit.start <= S.toDayIndex('2026-08-28'));
ok('fit starts on a Monday', S.isMonday(fit.start));

const empty = S.fitDomain([], '2026-08-28');
ok('an empty chart is still a chart', S.domainDays(empty) > 30);

// A single dated action, far in the past: today must stay on the canvas or the
// red line has nowhere to be.
const past = S.fitDomain(['2020-01-01'], '2026-08-28');
ok('fit stretches to cover today', past.end >= S.toDayIndex('2026-08-28'));

// --- projection -------------------------------------------------------------

const d0 = { start: S.toDayIndex('2026-08-24'), end: S.toDayIndex('2026-09-27') };
eq('first day sits at zero', S.xOf(d0.start, d0, 'day'), 0);
eq('second day is one column in', S.xOf(d0.start + 1, d0, 'day'), 28);
eq('dayAt inverts xOf', S.dayAt(S.xOf(d0.start + 5, d0, 'day'), d0, 'day'), d0.start + 5);
eq('a pixel inside a column belongs to it', S.dayAt(28 + 27, d0, 'day'), d0.start + 1);
eq('the next pixel is the next day', S.dayAt(28 + 28, d0, 'day'), d0.start + 2);
eq('one-day bar is one column wide', S.widthOf(d0.start, d0.start, 'day'), 28);
eq('five-day bar', S.widthOf(d0.start, d0.start + 4, 'day'), 140);
ok('a bar never disappears at quarter zoom', S.widthOf(d0.start, d0.start, 'quarter') >= S.MIN_BAR_PX);

// xOf/dayAt must invert each other at every zoom, across the whole domain.
let projErrors = 0;
for (const z of S.ZOOM_ORDER) {
  for (let i = d0.start; i <= d0.end; i++) {
    if (S.dayAt(S.xOf(i, d0, z), d0, z) !== i) projErrors++;
  }
}
eq('projection inverts at every zoom', projErrors, 0);

// --- zoom -------------------------------------------------------------------

eq('zoom out from day', S.stepZoom('day', 1), 'week');
eq('zoom out from week', S.stepZoom('week', 1), 'month');
eq('zoom out from month', S.stepZoom('month', 1), 'quarter');
eq('zoom out clamps at quarter', S.stepZoom('quarter', 1), 'quarter');
eq('zoom in clamps at day', S.stepZoom('day', -1), 'day');
eq('zoom in from quarter', S.stepZoom('quarter', -1), 'month');
ok('banding is on at day zoom', S.bandingVisible('day'));
ok('banding is on at week zoom', S.bandingVisible('week'));
ok('banding is off at month zoom', !S.bandingVisible('month'));
ok('banding is off at quarter zoom', !S.bandingVisible('quarter'));

// Zoom anchoring: the day under the cursor stays under the cursor. Without
// this a wheel notch throws the viewport to an unrelated week.
{
  const wide = { start: S.toDayIndex('2026-01-01'), end: S.toDayIndex('2027-12-31') };
  const cursorX = 400;
  const viewport = 900;
  const scrollLeft = 2000;
  const before = (scrollLeft + cursorX) / S.dayWidth('day');
  const after = S.anchoredScroll(scrollLeft, cursorX, viewport, wide, 'day', 'week');
  const dayAfter = (after + cursorX) / S.dayWidth('week');
  ok(`anchored zoom holds the day (${before.toFixed(2)} vs ${dayAfter.toFixed(2)})`,
    Math.abs(before - dayAfter) < 0.01);
  ok('anchored scroll is never negative',
    S.anchoredScroll(0, 10, viewport, wide, 'quarter', 'day') >= 0);

  // Zoomed out far enough that the whole domain fits, there is nothing left to
  // scroll: the answer is 0, not a position past the end of the content.
  const narrow = { start: S.toDayIndex('2026-01-01'), end: S.toDayIndex('2026-02-01') };
  eq('a domain that fits the viewport parks at the left',
    S.anchoredScroll(400, cursorX, viewport, narrow, 'day', 'quarter'), 0);

  const capped = S.anchoredScroll(9999, cursorX, viewport, wide, 'day', 'month');
  ok('never scrolls past the end of the canvas',
    capped <= S.domainWidth(wide, 'month') - viewport + 0.001, String(capped));
}

// --- ruler ------------------------------------------------------------------

{
  const r = S.ruler(d0, 'day');
  eq('a tick per day', r.ticks.length, S.domainDays(d0));
  ok('every rule is a Monday', r.rules.every((i) => S.isMonday(i)));
  ok('bands cover the domain exactly',
    r.bands.reduce((n, b) => n + b.days, 0) === S.domainDays(d0));
  ok('the first band starts at the domain', r.bands[0].idx === d0.start);
  eq('weekday initials are Mon-first', r.ticks[0].sub, 'M');
  ok('some ticks are weekends', r.ticks.some((t) => t.weekend));
}

{
  const r = S.ruler(d0, 'week');
  ok('week ticks are all Mondays', r.ticks.every((t) => S.isMonday(t.idx)));
  ok('no tick escapes the domain', r.ticks.every((t) => t.idx >= d0.start && t.idx <= d0.end));
}

{
  const wide = { start: S.toDayIndex('2026-01-01'), end: S.toDayIndex('2027-12-31') };
  const r = S.ruler(wide, 'month');
  eq('24 months', r.ticks.length, 24);
  eq('2 year bands', r.bands.length, 2);
  eq('the first is Jan', r.ticks[0].label, 'Jan');

  const q = S.ruler(wide, 'quarter');
  eq('8 quarters', q.ticks.length, 8);
  eq('the first is Q1', q.ticks[0].label, 'Q1');
  eq('the fifth is Q1 again', q.ticks[4].label, 'Q1');
}

// A domain starting mid-month must not emit a band that begins before it.
{
  const mid = { start: S.toDayIndex('2026-03-17'), end: S.toDayIndex('2026-05-04') };
  const r = S.ruler(mid, 'day');
  ok('no band starts before the domain', r.bands.every((b) => b.idx >= mid.start));
  ok('no band ends after the domain',
    r.bands.every((b) => b.idx + b.days - 1 <= mid.end));
  eq('bands still tile the domain',
    r.bands.reduce((n, b) => n + b.days, 0), S.domainDays(mid));
}

// --- shapes -----------------------------------------------------------------

eq('both dates is a bar', S.shapeOf({ start_date: '2026-03-01', due_date: '2026-03-05' }), 'bar');
eq('due only is a milestone', S.shapeOf({ start_date: null, due_date: '2026-03-05' }), 'milestone');
eq('start only is a milestone', S.shapeOf({ start_date: '2026-03-01', due_date: null }), 'milestone');
eq('neither draws nothing', S.shapeOf({ start_date: null, due_date: null }), 'none');

eq('a bar anchors on its start',
  S.anchorDay({ start_date: '2026-03-01', due_date: '2026-03-05' }),
  S.toDayIndex('2026-03-01'));
eq('a due-only milestone anchors on its due',
  S.anchorDay({ start_date: null, due_date: '2026-03-05' }),
  S.toDayIndex('2026-03-05'));
eq('nothing anchors nowhere', S.anchorDay({ start_date: null, due_date: null }), null);

// --- rollup -----------------------------------------------------------------

{
  const r = S.rollup([
    { start_date: '2026-03-04', due_date: '2026-03-08' },
    { start_date: null, due_date: '2026-03-20' },
    { start_date: '2026-03-01', due_date: null },
    { start_date: null, due_date: null }
  ]);
  eq('rollup starts at the earliest date', S.fromDayIndex(r.start), '2026-03-01');
  eq('rollup ends at the latest date', S.fromDayIndex(r.end), '2026-03-20');
  eq('a group with nothing dated has no rollup',
    S.rollup([{ start_date: null, due_date: null }]), null);
  eq('an empty group has no rollup', S.rollup([]), null);
}

// --- overdue ----------------------------------------------------------------

ok('yesterday is overdue', S.isOverdue({ due_date: '2026-08-27', done: false }, '2026-08-28'));
ok('today is not overdue', !S.isOverdue({ due_date: '2026-08-28', done: false }, '2026-08-28'));
ok('tomorrow is not overdue', !S.isOverdue({ due_date: '2026-08-29', done: false }, '2026-08-28'));
ok('no date is not overdue', !S.isOverdue({ due_date: null, done: false }, '2026-08-28'));
ok('a finished one is never overdue', !S.isOverdue({ due_date: '2020-01-01', done: true }, '2026-08-28'));

// --- report -----------------------------------------------------------------

console.log(`\n  timeline scale: ${passed} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
