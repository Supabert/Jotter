<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Action } from '../api';
  import { store, type TimelineGroup } from '../store.svelte';
  import * as scale from '../timeline/scale';
  import TimelineBar from './TimelineBar.svelte';
  import type { DragMode } from '../timeline/scale';

  /**
   * The chart.
   *
   * Owns the geometry, the scrolling and every gesture; `TimelineBar` owns only
   * how a mark looks. All the date arithmetic lives in `timeline/scale.ts`,
   * which is pure and unit-tested, so nothing here has to be right about
   * calendars — only about pixels and pointers.
   *
   * ## Why the panes are wired by hand
   *
   * Only `.body` has real scrollbars. The ruler mirrors its `scrollLeft` and
   * the label column mirrors its `scrollTop`, which is what freezes each of
   * them on one axis while both follow on the other. Position-sticky would do
   * the same job for one of the two, never for both at once.
   */

  /** Uniform, so a pointer's y maps to a line by division and nothing else. A
      group header earns its presence from its ground and its legend, not from
      being taller than the rows it holds. */
  const LINE_H = 26;
  /** How far a pointer must leave its own row before a drag is also a move
      between rows. Below this, a wobble while dragging dates would silently
      recategorise the work. */
  const V_DEADZONE = LINE_H / 2;
  /** Under this, a pointer press is a click on the bar rather than a drag of
      it. Without it every click lands a one-pixel reschedule. */
  const CLICK_SLOP = 3;

  let bodyEl = $state<HTMLDivElement | null>(null);
  let rulerEl = $state<HTMLDivElement | null>(null);
  let labelsEl = $state<HTMLDivElement | null>(null);

  /** The horizontal window actually on screen, for tick virtualisation. */
  let viewLeft = $state(0);
  let viewWidth = $state(1200);

  const zoom = $derived(store.timelineZoom);
  const domain = $derived(store.timelineDomain);
  const dayW = $derived(scale.dayWidth(zoom));
  const canvasW = $derived(scale.domainWidth(domain, zoom));
  const groups = $derived(store.timelineGroups);
  const todayIdx = $derived(scale.toDayIndex(store.today));
  const todayX = $derived(
    todayIdx >= domain.start && todayIdx <= domain.end ? scale.xOf(todayIdx, domain, zoom) : null
  );

  /** Month and quarter boundaries are not periodic, so those rules are real
      elements. Weeks and days are, so they are one background each and cost
      no nodes at all — which is what keeps a two-year day view cheap. */
  const periodic = $derived(zoom === 'day' || zoom === 'week');
  const ruler = $derived(scale.ruler(domain, zoom));

  /** Flattened render order. Group headers and rows share one list so a
      pointer's y resolves to a line by a single division. */
  type Line =
    | { kind: 'group'; group: TimelineGroup }
    | { kind: 'row'; group: TimelineGroup; action: Action; index: number };

  const lines = $derived.by((): Line[] => {
    const out: Line[] = [];
    for (const g of groups) {
      out.push({ kind: 'group', group: g });
      if (g.collapsed) continue;
      g.items.forEach((action, index) => out.push({ kind: 'row', group: g, action, index }));
    }
    return out;
  });

  const canvasH = $derived(Math.max(lines.length * LINE_H, 120));
  const anyRows = $derived(lines.some((l) => l.kind === 'row'));

  // --- ticks, virtualised -----------------------------------------------------

  const visibleTicks = $derived.by(() => {
    const pad = 400;
    const from = viewLeft - pad;
    const to = viewLeft + viewWidth + pad;
    return ruler.ticks.filter((t) => {
      const x = scale.xOf(t.idx, domain, zoom);
      return x >= from && x <= to;
    });
  });

  const visibleRules = $derived.by(() =>
    periodic
      ? []
      : ruler.rules.filter((i) => {
          const x = scale.xOf(i, domain, zoom);
          return x >= viewLeft - 400 && x <= viewLeft + viewWidth + 400;
        })
  );

  // --- gestures ---------------------------------------------------------------

  interface Drag {
    id: number;
    mode: DragMode;
    action: Action;
    /** Which line the bar started on, so the ghost's vertical offset is a
        difference of two line indices rather than an accumulated delta. */
    homeLine: number;
    x0: number;
    y0: number;
    dx: number;
    dy: number;
    moved: boolean;
  }

  let drag = $state<Drag | null>(null);
  let pan = $state<{ x0: number; y0: number; sl: number; st: number } | null>(null);

  /** Whole days the pointer has travelled. Snapped live rather than on drop:
      the bar shows exactly the dates that will be written, at every moment of
      the gesture. */
  const dragDays = $derived(drag ? Math.round(drag.dx / dayW) : 0);

  /** What the dragged row's dates would become right now. */
  const preview = $derived.by((): { start_date: string | null; due_date: string | null } | null => {
    if (!drag) return null;
    const a = drag.action;
    const d = dragDays;

    if (drag.mode === 'move') {
      return {
        start_date: a.start_date ? scale.addDays(a.start_date, d) : null,
        due_date: a.due_date ? scale.addDays(a.due_date, d) : null
      };
    }

    if (drag.mode === 'start' && a.start_date && a.due_date) {
      const next = scale.addDays(a.start_date, d);
      // Pushed past its own deadline, a start stops being a start. The bar
      // collapses back to the milestone it grew out of — the exact reverse of
      // the gesture that made it a bar.
      return next > a.due_date
        ? { start_date: null, due_date: a.due_date }
        : { start_date: next, due_date: a.due_date };
    }

    if (drag.mode === 'end' && a.due_date) {
      const next = scale.addDays(a.due_date, d);
      // Clamped, not cleared: the right edge is the deadline, and a deadline
      // dragged before the start is a slip, not an instruction to unschedule.
      return {
        start_date: a.start_date,
        due_date: a.start_date && next < a.start_date ? a.start_date : next
      };
    }

    if (drag.mode === 'grow') {
      // Growing a milestone into a bar: the date it does not have is the one
      // being created, and it only exists once the drag has actually left the
      // marker's own day.
      if (a.due_date && !a.start_date) {
        const next = scale.addDays(a.due_date, d);
        return { start_date: next < a.due_date ? next : null, due_date: a.due_date };
      }
      if (a.start_date && !a.due_date) {
        const next = scale.addDays(a.start_date, d);
        return { start_date: a.start_date, due_date: next > a.start_date ? next : null };
      }
    }

    return { start_date: a.start_date, due_date: a.due_date };
  });

  /** Which group and which slot the pointer is currently over, or null while
      the drag has not left its own row. */
  const dropTarget = $derived.by((): { group: TimelineGroup; index: number } | null => {
    if (!drag || Math.abs(drag.dy) <= V_DEADZONE) return null;
    const li = Math.floor((drag.homeLine * LINE_H + drag.dy + LINE_H / 2) / LINE_H);
    const line = lines[Math.min(Math.max(li, 0), lines.length - 1)];
    if (!line) return null;
    if (line.kind === 'group') {
      // A collapsed group has no rows to aim between, so its header is the
      // whole target and the row joins the end of it.
      return { group: line.group, index: line.group.collapsed ? line.group.items.length : 0 };
    }
    return { group: line.group, index: line.index };
  });

  /** The ghost's vertical offset: a whole number of rows, never a raw delta. */
  const ghostY = $derived.by(() => {
    if (!drag || !dropTarget) return 0;
    const g = dropTarget.group;
    let target = lines.findIndex(
      (l) => l.kind === 'row' && l.group.key === g.key && l.index === dropTarget.index
    );
    if (target < 0) {
      // No row occupies that slot — an empty group, a collapsed one, or the
      // end of a list. Land against the header instead of snapping home.
      const gi = lines.findIndex((l) => l.kind === 'group' && l.group.key === g.key);
      if (gi < 0) return 0;
      target = g.collapsed ? gi : gi + Math.min(dropTarget.index + 1, g.items.length + 1);
    }
    return (target - drag.homeLine) * LINE_H;
  });

  function grab(mode: DragMode, e: PointerEvent, action: Action, homeLine: number) {
    drag = {
      id: action.id,
      mode,
      action: { ...action },
      homeLine,
      x0: e.clientX,
      y0: e.clientY,
      dx: 0,
      dy: 0,
      moved: false
    };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp, { once: true });
  }

  function onDragMove(e: PointerEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    drag = {
      ...drag,
      dx,
      dy,
      moved: drag.moved || Math.hypot(dx, dy) > CLICK_SLOP
    };
  }

  async function onDragUp() {
    window.removeEventListener('pointermove', onDragMove);
    const d = drag;
    const p = preview;
    const target = dropTarget;
    drag = null;
    if (!d) return;

    // A press that never travelled is a click, and a click opens the row.
    if (!d.moved) {
      store.openCard = d.id;
      return;
    }
    if (!p) return;

    const group = target?.group;
    const projectId = group ? group.projectId : store.timelineGroupOf(d.action);

    // The destination group's full order, filter and completed toggle ignored:
    // writing back only the rows on screen would renumber them on top of the
    // ones the filter is hiding.
    let ids = store.groupOrder(projectId).filter((id) => id !== d.id);
    if (group) {
      const anchor = group.items.filter((a) => a.id !== d.id)[target!.index];
      const at = anchor ? ids.indexOf(anchor.id) : ids.length;
      ids.splice(at < 0 ? ids.length : at, 0, d.id);
    } else {
      ids = store.groupOrder(projectId);
    }

    await store.commitTimelineDrag({
      id: d.id,
      start: p.start_date,
      due: p.due_date,
      projectId,
      ids
    });
  }

  /** Keyboard equivalent of a horizontal drag. Every gesture on this chart has
      one, because a chart you can only operate with a mouse is a chart half
      the app cannot reach. */
  async function nudge(a: Action, days: number, edgeOnly: boolean) {
    if (edgeOnly && a.due_date) {
      const next = scale.addDays(a.due_date, days);
      await store.setActionSpan(
        a.id,
        a.start_date,
        a.start_date && next < a.start_date ? a.start_date : next,
        'Rescheduled'
      );
      return;
    }
    await store.setActionSpan(
      a.id,
      a.start_date ? scale.addDays(a.start_date, days) : null,
      a.due_date ? scale.addDays(a.due_date, days) : null,
      'Rescheduled'
    );
  }

  // --- panning ----------------------------------------------------------------

  function startPan(e: PointerEvent) {
    if (e.button !== 0 || !bodyEl) return;
    pan = { x0: e.clientX, y0: e.clientY, sl: bodyEl.scrollLeft, st: bodyEl.scrollTop };
    window.addEventListener('pointermove', onPanMove);
    window.addEventListener('pointerup', endPan, { once: true });
  }

  function onPanMove(e: PointerEvent) {
    if (!pan || !bodyEl) return;
    // Grab-and-drag: the canvas follows the hand, so the scroll goes the
    // opposite way to the pointer.
    bodyEl.scrollLeft = pan.sl - (e.clientX - pan.x0);
    bodyEl.scrollTop = pan.st - (e.clientY - pan.y0);
  }

  function endPan() {
    window.removeEventListener('pointermove', onPanMove);
    pan = null;
  }

  // --- zoom -------------------------------------------------------------------

  let zoomSaveTimer: number | undefined;

  async function onWheel(e: WheelEvent) {
    if (!bodyEl) return;

    // Shift is the fine adjustment: pan a little instead of changing the whole
    // scale, for when the wheel is the only thing under the hand.
    if (e.shiftKey) {
      e.preventDefault();
      bodyEl.scrollLeft += e.deltaY;
      return;
    }

    e.preventDefault();
    const next = scale.stepZoom(zoom, e.deltaY > 0 ? 1 : -1);
    if (next === zoom) return;

    const cursorX = e.clientX - bodyEl.getBoundingClientRect().left;
    const sl = scale.anchoredScroll(
      bodyEl.scrollLeft,
      cursorX,
      bodyEl.clientWidth,
      domain,
      zoom,
      next
    );

    store.timelineZoom = next;
    // Written once the wheel settles. A notch is not a decision worth a disk
    // write, and a fast spin is a dozen of them.
    clearTimeout(zoomSaveTimer);
    zoomSaveTimer = setTimeout(() => store.setSetting('timeline_zoom', next), 400) as unknown as number;

    // After the canvas has taken its new width, or the scroll clamps against
    // the old one and the anchoring is lost.
    await tick();
    bodyEl.scrollLeft = sl;
  }

  // --- scroll sync ------------------------------------------------------------

  function onScroll() {
    if (!bodyEl) return;
    viewLeft = bodyEl.scrollLeft;
    viewWidth = bodyEl.clientWidth;
    if (rulerEl) rulerEl.scrollLeft = bodyEl.scrollLeft;
    if (labelsEl) labelsEl.scrollTop = bodyEl.scrollTop;
  }

  /** Put today a quarter of the way in, so the chart opens showing what is
      coming with enough of what just happened to give it context. */
  export function scrollToToday(): void {
    if (!bodyEl || todayX === null) return;
    bodyEl.scrollLeft = Math.max(0, todayX - bodyEl.clientWidth / 4);
    onScroll();
  }

  onMount(() => {
    onScroll();
    // One frame later: at mount the pane is in the document but the grid has
    // not sized it yet, so `clientWidth` is 0 and the opening scroll lands at
    // the far left instead of on today.
    requestAnimationFrame(() => {
      onScroll();
      scrollToToday();
    });
    return () => {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointermove', onPanMove);
      clearTimeout(zoomSaveTimer);
    };
  });

  // --- per-row geometry -------------------------------------------------------

  function markOf(a: Action) {
    const live = drag?.id === a.id && preview ? preview : a;
    const shape = scale.shapeOf(live);
    const day = scale.anchorDay(live);
    if (shape === 'none' || day === null) return null;
    const endIso = live.start_date && live.due_date ? live.due_date : null;
    // A bar starts at its first day's left edge; a marker belongs in the middle
    // of the day it marks, not on the boundary between that day and the one
    // before it.
    const x = scale.xOf(day, domain, zoom) + (endIso ? 0 : dayW / 2);
    const w = endIso ? scale.widthOf(day, scale.toDayIndex(endIso), zoom) : 0;
    return { shape, x, w };
  }

  function rollupBox(g: TimelineGroup) {
    if (!g.rollup) return null;
    const x = scale.xOf(g.rollup.start, domain, zoom);
    const w = scale.widthOf(g.rollup.start, g.rollup.end, zoom);
    const total = g.items.length;
    const done = g.items.filter((a) => a.done).length;
    return { x, w, done, total, pct: total ? (done / total) * 100 : 0 };
  }
</script>

<div class="tl" style:--line-h="{LINE_H}px" style:--day-w="{dayW}px">
  <div class="corner">
    <span class="legend">Project</span>
  </div>

  <div class="ruler" bind:this={rulerEl}>
    <div class="rulercanvas" style:width="{canvasW}px">
      <div class="bands">
        {#each ruler.bands as b (b.idx)}
          <div
            class="band"
            style:left="{scale.xOf(b.idx, domain, zoom)}px"
            style:width="{b.days * dayW}px"
          >
            <span>{b.label}</span>
          </div>
        {/each}
      </div>
      <div class="ticks">
        {#each visibleTicks as t (t.idx)}
          <div
            class="tick"
            class:weekend={t.weekend}
            class:wide={zoom !== 'day'}
            style:left="{scale.xOf(t.idx, domain, zoom)}px"
            style:width="{(zoom === 'day' ? 1 : 7) * dayW}px"
          >
            <span class="num">{t.label}</span>
            {#if t.sub}<span class="sub">{t.sub}</span>{/if}
          </div>
        {/each}
      </div>
      {#if todayX !== null}
        <div class="todaycap" style:left="{todayX}px" style:width="{dayW}px"></div>
      {/if}
    </div>
  </div>

  <!-- The chart's wheel zooms, so this column keeps the ordinary meaning of a
       wheel and scrolls the rows. -->
  <div
    class="labels"
    bind:this={labelsEl}
    onwheel={(e) => {
      if (!bodyEl) return;
      e.preventDefault();
      bodyEl.scrollTop += e.deltaY;
    }}
  >
    <div class="labelcanvas" style:height="{canvasH}px">
      {#each lines as line (line.kind === 'group' ? `g${line.group.key}` : `a${line.action.id}`)}
        {#if line.kind === 'group'}
          <div class="lbl grouplbl" class:targeted={dropTarget?.group.key === line.group.key}>
            <button
              class="twist"
              aria-expanded={!line.group.collapsed}
              aria-label="{line.group.collapsed ? 'Expand' : 'Collapse'} {line.group.name}"
              onclick={() => store.toggleCollapsed(line.group.projectId)}
            >
              <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
                <path
                  d="M3 1.5 L7 5 L3 8.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <span
              class="tab"
              style:background={line.group.color ?? 'transparent'}
              aria-hidden="true"
            ></span>
            <span class="gname legend">{line.group.name}</span>
            {#if line.group.items.length}
              <span class="count mono">
                {line.group.items.filter((a) => a.done).length}/{line.group.items.length}
              </span>
            {/if}
          </div>
        {:else}
          <div class="lbl rowlbl" class:selected={store.openCard === line.action.id}>
            <button
              class="tick-box"
              class:on={line.action.done}
              aria-label={line.action.done ? 'Reopen' : 'Complete'}
              onclick={() => store.toggleAction(line.action.id, !line.action.done)}
            >
              {#if line.action.done}
                <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
                  <path
                    d="M1.5 5.2 L4 7.5 L8.5 2.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              {/if}
            </button>
            <button
              class="rowname"
              class:done={line.action.done}
              class:overdue={store.isOverdue(line.action)}
              onclick={() => (store.openCard = line.action.id)}
              title={line.action.text}
            >
              {line.action.text}
            </button>
          </div>
        {/if}
      {/each}
    </div>
  </div>

  <!-- Only this pane scrolls; the ruler and the labels mirror it. -->
  <div class="body" bind:this={bodyEl} onscroll={onScroll} onwheel={onWheel}>
    <!-- Press anywhere that is not a mark and the canvas follows the hand.
         Marks stop the event before it arrives here, so a bar drag and a pan
         can never both start from one press. -->
    <div
      class="canvas"
      class:panning={pan !== null}
      class:banded={periodic && scale.bandingVisible(zoom)}
      class:weekrules={periodic}
      style:width="{canvasW}px"
      style:height="{canvasH}px"
      role="group"
      aria-label="Timeline chart"
      onpointerdown={startPan}
    >
      {#each visibleRules as r (r)}
        <div class="rule" style:left="{scale.xOf(r, domain, zoom)}px"></div>
      {/each}

      {#if todayX !== null}
        <div class="today" style:left="{todayX}px"></div>
      {/if}

      {#each lines as line, i (line.kind === 'group' ? `g${line.group.key}` : `a${line.action.id}`)}
        {#if line.kind === 'group'}
          {@const box = rollupBox(line.group)}
          <div
            class="lane grouplane"
            class:targeted={dropTarget?.group.key === line.group.key}
            data-gkey={line.group.key}
            style:top="{i * LINE_H}px"
          >
            {#if box}
              <!-- A summary, drawn as a summary: a bracket over the span its
                   children occupy, with the finished share filled in. Nothing
                   about it is grabbable, because a rollup is a reading of its
                   rows and not a row of its own. -->
              <div class="rollup" style:left="{box.x}px" style:width="{box.w}px">
                <div class="rollupfill" style:width="{box.pct}%"></div>
              </div>
            {/if}
          </div>
        {:else}
          {@const mark = markOf(line.action)}
          <div class="lane" data-aid={line.action.id} style:top="{i * LINE_H}px">
            {#if mark}
              <TimelineBar
                action={line.action}
                shape={mark.shape}
                x={mark.x}
                w={mark.w}
                overdue={store.isOverdue(line.action)}
                dragging={drag?.id === line.action.id}
                ghostY={drag?.id === line.action.id ? ghostY : 0}
                selected={store.openCard === line.action.id}
                onGrab={(mode, e) => grab(mode, e, line.action, i)}
                onOpen={() => (store.openCard = line.action.id)}
                onNudge={(days, edge) => nudge(line.action, days, edge)}
              />
            {/if}
          </div>
        {/if}
      {/each}

      {#if !anyRows}
        <div class="empty">
          <p class="legend">Nothing scheduled</p>
          <p class="hint">
            Give an action a due date — on its card, or on the board — and it appears here.
          </p>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  /* Each pane spells out its own track. A single fixed list plus a conditional
     child is how content ends up in the wrong track — the editor wrap already
     taught this repo that once. */
  .tl {
    display: grid;
    grid-template-columns: 208px minmax(0, 1fr);
    grid-template-rows: 40px minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
    background: var(--panel-1);
  }

  .corner {
    display: flex;
    align-items: flex-end;
    padding: 0 10px 5px;
    border-right: 1px solid var(--hairline);
    border-bottom: 1px solid var(--hairline);
    background: var(--panel-1);
  }

  .legend {
    font-family: var(--font-legend);
    font-variation-settings: var(--wdth-legend);
    font-size: 10px;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--legend);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--legend-dim);
  }

  /* --- ruler ---------------------------------------------------------------- */

  .ruler {
    overflow: hidden;
    border-bottom: 1px solid var(--hairline);
    background: var(--panel-1);
  }

  .rulercanvas {
    position: relative;
    height: 39px;
  }

  .bands,
  .ticks {
    position: absolute;
    left: 0;
    right: 0;
    height: 19px;
  }

  .bands {
    top: 0;
  }

  .ticks {
    top: 19px;
    height: 20px;
  }

  .band {
    position: absolute;
    top: 0;
    height: 19px;
    display: flex;
    align-items: center;
    border-left: 1px solid var(--hairline);
    overflow: hidden;
  }

  .band span {
    padding-left: 6px;
    font-family: var(--font-legend);
    font-variation-settings: var(--wdth-legend);
    font-size: 10px;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--legend);
    white-space: nowrap;
    /* Held against the left edge of the viewport while the month is still on
       screen, so a month you are halfway through still says its name. */
    position: sticky;
    left: 0;
  }

  .tick {
    position: absolute;
    top: 0;
    height: 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    overflow: hidden;
  }

  .tick.wide {
    align-items: flex-start;
    padding-left: 3px;
    border-left: 1px solid var(--hairline-soft);
  }

  .num {
    font-family: var(--font-mono);
    font-size: 9px;
    line-height: 1;
    color: var(--legend);
  }

  .sub {
    font-family: var(--font-mono);
    font-size: 8px;
    line-height: 1;
    color: var(--legend-dim);
  }

  .tick.weekend .num,
  .tick.weekend .sub {
    color: var(--legend-dim);
  }

  .todaycap {
    position: absolute;
    top: 19px;
    height: 20px;
    border-bottom: 2px solid var(--anc-red);
    pointer-events: none;
  }

  /* --- labels --------------------------------------------------------------- */

  .labels {
    overflow: hidden;
    border-right: 1px solid var(--hairline);
    background: var(--panel-1);
  }

  .labelcanvas {
    position: relative;
  }

  .lbl {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--line-h);
    padding: 0 8px 0 4px;
    border-bottom: 1px solid var(--hairline-soft);
  }

  .grouplbl {
    background: var(--panel-0);
    padding-left: 2px;
  }

  .grouplbl.targeted {
    background: var(--anc-amber-bg);
  }

  .twist {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--legend);
    cursor: pointer;
    transition: transform var(--dur-fast) var(--ease);
  }

  .twist[aria-expanded='true'] {
    transform: rotate(90deg);
  }

  .twist:hover {
    color: var(--ink);
  }

  /* One edge mechanism in this app: the 3px thumb tab. The project's colour
     rides here and never on the bars, so a bar's colour is only ever state. */
  .tab {
    width: 3px;
    align-self: stretch;
    margin: 4px 0;
    border-radius: 1px;
  }

  .gname {
    flex: 1;
    min-width: 0;
    color: var(--ink-soft);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rowlbl {
    padding-left: 22px;
  }

  .rowlbl.selected {
    background: var(--panel-2);
  }

  .tick-box {
    flex: none;
    display: grid;
    place-items: center;
    width: 13px;
    height: 13px;
    padding: 0;
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    background: var(--panel-2);
    color: var(--anc-green);
    cursor: pointer;
    transition: border-color var(--dur-fast) var(--ease);
  }

  .tick-box:hover {
    border-color: var(--legend);
  }

  .tick-box.on {
    border-color: var(--anc-green);
  }

  .rowname {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    font: 400 11.5px/1 var(--font-body);
    color: var(--ink-soft);
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .rowname:hover {
    color: var(--ink);
  }

  .rowname.overdue {
    color: var(--anc-red);
  }

  .rowname.done {
    color: var(--legend-dim);
    text-decoration: line-through;
  }

  /* --- chart ---------------------------------------------------------------- */

  .body {
    overflow: auto;
    background: var(--panel-2);
    /* The wheel is bound to zoom, so the browser must not also treat it as a
       scroll gesture and fight the handler for it. */
    overscroll-behavior: contain;
  }

  .canvas {
    position: relative;
    /* Fills the pane even when the rows do not, so the empty space below the
       last row is still chart to grab rather than the scroller's background.
       Safe here in a way it is not on a grid item: this is a block child of a
       scroll container, so the percentage resolves against the pane. */
    min-height: 100%;
    cursor: grab;
  }

  .canvas.panning {
    cursor: grabbing;
  }

  /* Weeks and weekends repeat with a period of exactly seven days, so both are
     one painted background rather than a thousand elements. The domain always
     starts on a Monday, which is what lets the phase be zero. */
  .canvas.banded {
    background-image: repeating-linear-gradient(
      90deg,
      transparent 0,
      transparent calc(var(--day-w) * 5),
      var(--hairline-soft) calc(var(--day-w) * 5),
      var(--hairline-soft) calc(var(--day-w) * 7)
    );
  }

  .canvas.weekrules {
    background-image: repeating-linear-gradient(
        90deg,
        var(--hairline) 0,
        var(--hairline) 1px,
        transparent 1px,
        transparent calc(var(--day-w) * 7)
      ),
      repeating-linear-gradient(
        90deg,
        transparent 0,
        transparent calc(var(--day-w) * 5),
        var(--hairline-soft) calc(var(--day-w) * 5),
        var(--hairline-soft) calc(var(--day-w) * 7)
      );
  }

  .rule {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--hairline);
    pointer-events: none;
  }

  /* Today, in the one colour that already means "past its moment". Everything
     to the left of this line that is not ticked is late, which is the same
     thing the red cards on the board are saying. */
  .today {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--anc-red);
    pointer-events: none;
    z-index: 2;
  }

  .lane {
    position: absolute;
    left: 0;
    right: 0;
    height: var(--line-h);
    border-bottom: 1px solid var(--hairline-soft);
  }

  .grouplane {
    background: color-mix(in srgb, var(--panel-0) 55%, transparent);
  }

  .grouplane.targeted {
    background: var(--anc-amber-bg);
  }

  .rollup {
    position: absolute;
    top: 10px;
    height: 5px;
    background: var(--panel-3);
    border: 1px solid var(--hairline);
    border-radius: 1px;
    overflow: hidden;
  }

  .rollupfill {
    height: 100%;
    background: var(--anc-green);
    opacity: 0.55;
    transition: width var(--dur-base) var(--ease);
  }

  .empty {
    position: absolute;
    top: 34px;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    pointer-events: none;
  }

  .hint {
    font: 400 11.5px/1.4 var(--font-body);
    color: var(--legend-dim);
    margin: 0;
  }

  .empty .legend {
    margin: 0;
  }
</style>
