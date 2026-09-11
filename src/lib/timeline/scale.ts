/**
 * The timeline's arithmetic. No DOM, no Svelte, no store — every function here
 * is pure, so the part of the chart most likely to be wrong is the part that
 * can be tested without launching anything (`scripts/timeline-test.mjs`).
 *
 * ## Day-index space
 *
 * Every date in Jotter is a `YYYY-MM-DD` string with no time component, and it
 * never grows one. So the chart works in whole days: a date converts to an
 * integer day index, all arithmetic happens on integers, and it converts back
 * the same way. Nothing here holds a `Date` beyond one expression.
 *
 * ⚠ `new Date('2026-03-01')` parses as UTC midnight and then reports its
 * *local* parts. In America/Chicago that is `Feb 28 18:00`, so `getDate()`
 * answers 28 and every bar on the chart sits one day to the left. The rule is
 * therefore absolute: build from `Date.UTC`, read back with `getUTC*`, and
 * never let a local-time getter touch a date that came from a string.
 */

export type Zoom = 'day' | 'week' | 'month' | 'quarter';

/**
 * What a pointer grabbed. `move` shifts a whole span, `start` and `end` move
 * one edge of a bar, and `grow` is the handle on a milestone that creates the
 * date it does not have yet — the gesture that turns a deadline into a span.
 */
export type DragMode = 'move' | 'start' | 'end' | 'grow';

/** Milliseconds in a day. UTC has no daylight saving, so this is exact. */
const MS_DAY = 86_400_000;

/** 1970-01-01 was a Thursday, which is 3 in a week that starts on Monday. */
const EPOCH_WEEKDAY = 3;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];

const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

// --- conversions ------------------------------------------------------------

/** `YYYY-MM-DD` → whole days since 1970-01-01. */
export function toDayIndex(iso: string): number {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return Math.round(Date.UTC(y, m - 1, d) / MS_DAY);
}

/** Whole days since 1970-01-01 → `YYYY-MM-DD`. */
export function fromDayIndex(idx: number): string {
  const d = new Date(idx * MS_DAY);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function addDays(iso: string, days: number): string {
  return fromDayIndex(toDayIndex(iso) + days);
}

/**
 * How many days a span covers, counting both ends. A task that starts and is
 * due on the same day is one day of work, not zero — a zero-width bar would be
 * invisible, which is the wrong answer to "when is this happening".
 */
export function spanDays(startIso: string, endIso: string): number {
  return toDayIndex(endIso) - toDayIndex(startIso) + 1;
}

// --- calendar predicates ----------------------------------------------------

/** 0 = Monday … 6 = Sunday — the ISO week. */
export function weekday(idx: number): number {
  return (((idx + EPOCH_WEEKDAY) % 7) + 7) % 7;
}

export function isWeekend(idx: number): boolean {
  return weekday(idx) >= 5;
}

export function isMonday(idx: number): boolean {
  return weekday(idx) === 0;
}

/** The Monday of the week containing `idx`. */
export function weekStart(idx: number): number {
  return idx - weekday(idx);
}

export function isMonthStart(idx: number): boolean {
  return new Date(idx * MS_DAY).getUTCDate() === 1;
}

export function isQuarterStart(idx: number): boolean {
  const d = new Date(idx * MS_DAY);
  return d.getUTCDate() === 1 && d.getUTCMonth() % 3 === 0;
}

export function isYearStart(idx: number): boolean {
  const d = new Date(idx * MS_DAY);
  return d.getUTCDate() === 1 && d.getUTCMonth() === 0;
}

/** The first of the month containing `idx`. */
export function monthStart(idx: number): number {
  const d = new Date(idx * MS_DAY);
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / MS_DAY);
}

/** The first day of the next month after the one containing `idx`. */
export function nextMonth(idx: number): number {
  const d = new Date(idx * MS_DAY);
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / MS_DAY);
}

export function nextYear(idx: number): number {
  const d = new Date(idx * MS_DAY);
  return Math.round(Date.UTC(d.getUTCFullYear() + 1, 0, 1) / MS_DAY);
}

// --- zoom -------------------------------------------------------------------

export interface ZoomSpec {
  /** Pixels one day occupies. Everything else on the chart derives from this. */
  px: number;
  /** What the bottom row of the ruler counts. */
  unit: 'day' | 'week' | 'month' | 'quarter';
  label: string;
}

/**
 * Four steps, each roughly 3× the last. Enough separation that a wheel notch is
 * a decision rather than a nudge, and the whole useful range — a fortnight to a
 * couple of years — is three notches wide.
 */
export const ZOOMS: Record<Zoom, ZoomSpec> = {
  day: { px: 28, unit: 'day', label: 'Day' },
  week: { px: 8, unit: 'week', label: 'Week' },
  month: { px: 2.6, unit: 'month', label: 'Month' },
  quarter: { px: 0.9, unit: 'quarter', label: 'Quarter' }
};

export const ZOOM_ORDER: Zoom[] = ['day', 'week', 'month', 'quarter'];

/** `+1` zooms out (a day gets narrower), `-1` zooms in. Clamps at both ends. */
export function stepZoom(z: Zoom, delta: 1 | -1): Zoom {
  const i = ZOOM_ORDER.indexOf(z);
  const next = Math.min(ZOOM_ORDER.length - 1, Math.max(0, i + delta));
  return ZOOM_ORDER[next];
}

export function dayWidth(z: Zoom): number {
  return ZOOMS[z].px;
}

/**
 * Below this a day column is thinner than a hairline pair, so weekend banding
 * turns into a moiré of grey stripes and stops meaning anything. Off it goes.
 */
export function bandingVisible(z: Zoom): boolean {
  return ZOOMS[z].px >= 4;
}

// --- domain -----------------------------------------------------------------

/** An inclusive run of days. The chart's whole canvas. */
export interface Domain {
  start: number;
  end: number;
}

export function domainDays(d: Domain): number {
  return d.end - d.start + 1;
}

export function domainWidth(d: Domain, z: Zoom): number {
  return domainDays(d) * dayWidth(z);
}

/**
 * The window the user asked for: so far back, so far forward, both measured
 * from today. Relative rather than absolute so the chart follows the date
 * without anyone re-setting it, which is the same reason the today line has to
 * survive midnight.
 *
 * Snapped out to whole weeks so the first column of the chart is always a
 * Monday and the week rules never start mid-stride.
 */
export function relativeDomain(todayIso: string, backDays: number, fwdDays: number): Domain {
  const today = toDayIndex(todayIso);
  const start = weekStart(today - backDays);
  const end = weekStart(today + fwdDays) + 6;
  return { start, end };
}

/**
 * Every dated row, plus a week of air at each end so the outermost bar is not
 * flush against the edge. Falls back to the default window when there is
 * nothing dated to fit — an empty chart still has to be a chart.
 */
export function fitDomain(dates: string[], todayIso: string): Domain {
  if (dates.length === 0) return relativeDomain(todayIso, DEFAULT_BACK, DEFAULT_FWD);
  let lo = Infinity;
  let hi = -Infinity;
  for (const iso of dates) {
    const i = toDayIndex(iso);
    if (i < lo) lo = i;
    if (i > hi) hi = i;
  }
  // Today is always in view. A chart that has scrolled off the red line is
  // answering a question nobody asked.
  const today = toDayIndex(todayIso);
  lo = Math.min(lo, today);
  hi = Math.max(hi, today);
  return { start: weekStart(lo - 7), end: weekStart(hi + 7) + 6 };
}

export const DEFAULT_BACK = 14;
export const DEFAULT_FWD = 90;

/** The presets behind the `Range` control, in days. */
export const RANGE_STEPS: { label: string; days: number }[] = [
  { label: '2w', days: 14 },
  { label: '1m', days: 30 },
  { label: '3m', days: 90 },
  { label: '6m', days: 182 },
  { label: '1y', days: 365 }
];

// --- projection -------------------------------------------------------------

/** Left edge of a day's column, in pixels from the start of the canvas. */
export function xOf(idx: number, d: Domain, z: Zoom): number {
  return (idx - d.start) * dayWidth(z);
}

/**
 * Which day a pixel offset falls in. Floors, so a pixel belongs to exactly one
 * day.
 *
 * The epsilon is not defensive padding. The zoomed-out day widths are not
 * binary fractions, so a column's own left edge divides back to a hair under
 * its index — `(3 * 0.9) / 0.9` is `2.9999999999999996`, which floors to 2 and
 * puts a bar one day left of where it was drawn. A billionth of a pixel is far
 * below anything that could reach the other boundary.
 */
export function dayAt(x: number, d: Domain, z: Zoom): number {
  return d.start + Math.floor(x / dayWidth(z) + 1e-9);
}

/** Pixel width of an inclusive span, never less than one readable stub. */
export function widthOf(startIdx: number, endIdx: number, z: Zoom): number {
  return Math.max(dayWidth(z) * (endIdx - startIdx + 1), MIN_BAR_PX);
}

/**
 * A bar zoomed out to a quarter view would otherwise be a fraction of a pixel
 * and vanish. It stops being a measurement at that point and becomes a marker,
 * which is the honest thing for it to be.
 */
export const MIN_BAR_PX = 3;

/**
 * Zooming has to keep the day under the cursor under the cursor. Without this
 * a wheel notch throws the viewport to an unrelated week, which reads as the
 * chart breaking rather than as the chart zooming.
 *
 * Returns the `scrollLeft` the viewport needs after the zoom.
 */
export function anchoredScroll(
  scrollLeft: number,
  cursorX: number,
  viewportWidth: number,
  d: Domain,
  from: Zoom,
  to: Zoom
): number {
  // Fractional deliberately — anchoring on the floored day would jump by up to
  // a day at a time, which is visible at the day zoom.
  const dayUnderCursor = (scrollLeft + cursorX) / dayWidth(from);
  const next = dayUnderCursor * dayWidth(to) - cursorX;
  // Clamped against what can actually be scrolled to. Zoomed out far enough
  // that the whole domain fits, there is nothing left to scroll: the anchor
  // cannot be honoured and the chart parks at the left. That is the content
  // running out, not the anchoring failing.
  const max = Math.max(0, domainWidth(d, to) - viewportWidth);
  return Math.min(Math.max(0, next), max);
}

// --- ruler ------------------------------------------------------------------

/** A labelled run along the top row of the ruler: a month, or a year. */
export interface Band {
  idx: number;
  days: number;
  label: string;
}

/** A labelled column along the bottom row: a day, a week, a month, a quarter. */
export interface Tick {
  idx: number;
  label: string;
  /** Weekday initial under the number, at the day zoom only. */
  sub?: string;
  weekend?: boolean;
}

export interface Ruler {
  bands: Band[];
  ticks: Tick[];
  /** Day indices carrying a vertical rule across the whole chart. */
  rules: number[];
}

/**
 * The ruler and its rules for one zoom. The two rows always answer different
 * questions — the bottom row counts the unit you are reading, the top row says
 * which larger period you are inside — so neither row ever has to repeat the
 * other to stay legible.
 */
export function ruler(d: Domain, z: Zoom): Ruler {
  const unit = ZOOMS[z].unit;
  const bands: Band[] = [];
  const ticks: Tick[] = [];
  const rules: number[] = [];

  if (unit === 'day' || unit === 'week') {
    // Top row: months, clipped to the domain at both ends.
    for (let i = monthStart(d.start); i <= d.end; i = nextMonth(i)) {
      const from = Math.max(i, d.start);
      const to = Math.min(nextMonth(i) - 1, d.end);
      const date = new Date(i * MS_DAY);
      bands.push({
        idx: from,
        days: to - from + 1,
        label: `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
      });
    }
  } else {
    for (let i = d.start; i <= d.end; ) {
      const y = nextYear(i);
      const to = Math.min(y - 1, d.end);
      bands.push({
        idx: i,
        days: to - i + 1,
        label: String(new Date(i * MS_DAY).getUTCFullYear())
      });
      i = y;
    }
  }

  if (unit === 'day') {
    for (let i = d.start; i <= d.end; i++) {
      const date = new Date(i * MS_DAY);
      ticks.push({
        idx: i,
        label: String(date.getUTCDate()),
        sub: WEEKDAY_INITIALS[weekday(i)],
        weekend: isWeekend(i)
      });
      if (isMonday(i)) rules.push(i);
    }
  } else if (unit === 'week') {
    for (let i = weekStart(d.start); i <= d.end; i += 7) {
      if (i < d.start) continue;
      ticks.push({ idx: i, label: String(new Date(i * MS_DAY).getUTCDate()) });
      rules.push(i);
    }
  } else if (unit === 'month') {
    for (let i = monthStart(d.start); i <= d.end; i = nextMonth(i)) {
      if (i < d.start) continue;
      ticks.push({ idx: i, label: MONTHS[new Date(i * MS_DAY).getUTCMonth()].slice(0, 3) });
      rules.push(i);
    }
  } else {
    for (let i = monthStart(d.start); i <= d.end; i = nextMonth(i)) {
      if (i < d.start || !isQuarterStart(i)) continue;
      ticks.push({ idx: i, label: `Q${Math.floor(new Date(i * MS_DAY).getUTCMonth() / 3) + 1}` });
      rules.push(i);
    }
  }

  return { bands, ticks, rules };
}

// --- spans ------------------------------------------------------------------

/**
 * What one action draws as. `none` never reaches the chart; it is returned so
 * the header can count what the chart is not showing, because a timeline that
 * silently omits work is a timeline you cannot trust.
 */
export type Shape = 'bar' | 'milestone' | 'none';

export function shapeOf(a: { start_date: string | null; due_date: string | null }): Shape {
  if (a.start_date && a.due_date) return 'bar';
  if (a.due_date) return 'milestone';
  // A start with no due is still a span of one known day: it begins, and
  // nothing says when it ends. Drawn as a milestone on its start.
  if (a.start_date) return 'milestone';
  return 'none';
}

/** The day a milestone sits on, or a bar's first day. */
export function anchorDay(a: { start_date: string | null; due_date: string | null }): number | null {
  const iso = a.start_date && a.due_date ? a.start_date : (a.due_date ?? a.start_date);
  return iso ? toDayIndex(iso) : null;
}

/**
 * The smallest window containing every dated child, or `null` when a group has
 * nothing dated in it. Computed on every render and never stored: a rollup is a
 * reading of its children, and a stored one is a second answer that can drift.
 */
export function rollup(
  items: { start_date: string | null; due_date: string | null }[]
): Domain | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of items) {
    for (const iso of [a.start_date, a.due_date]) {
      if (!iso) continue;
      const i = toDayIndex(iso);
      if (i < lo) lo = i;
      if (i > hi) hi = i;
    }
  }
  return lo === Infinity ? null : { start: lo, end: hi };
}

/**
 * Is this late? One definition, used by the chart, the board and the checklist,
 * so the three views cannot disagree about what red means. Derived every time
 * and never written down — fixing the date has to un-redden the card with no
 * second write to forget.
 */
export function isOverdue(
  a: { due_date: string | null; done: boolean },
  todayIso: string
): boolean {
  return !a.done && a.due_date !== null && a.due_date < todayIso;
}
