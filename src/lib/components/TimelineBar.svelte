<script lang="ts">
  import type { Action } from '../api';
  import type { DragMode, Shape } from '../timeline/scale';

  /**
   * One row's mark on the chart, and the hit zones that operate it.
   *
   * Deliberately geometry-free: the parent owns the domain, the zoom and the
   * live drag, and hands this component pixels. All this decides is what the
   * mark looks like in each state and where the grab zones are — which keeps
   * every date calculation in one testable place instead of spread across a
   * component that also renders.
   */

  interface Props {
    action: Action;
    shape: Shape;
    /** Left edge of the mark, in pixels from the start of the canvas. */
    x: number;
    /** Bar width. Ignored by a milestone, which is a fixed lozenge. */
    w: number;
    overdue: boolean;
    /** Live pointer offset while this bar is the one being dragged. */
    ghostX?: number;
    ghostY?: number;
    dragging?: boolean;
    /** The panel is open on this row. */
    selected?: boolean;
    onGrab: (mode: DragMode, e: PointerEvent) => void;
    onOpen: () => void;
    onNudge: (days: number, edge: boolean) => void;
  }

  let {
    action,
    shape,
    x,
    w,
    overdue,
    ghostX = 0,
    ghostY = 0,
    dragging = false,
    selected = false,
    onGrab,
    onOpen,
    onNudge
  }: Props = $props();

  /* A due-only milestone grows leftwards into a bar by acquiring a start; a
     start-only one grows rightwards by acquiring a due. Either way the handle
     sits on the side the new date would extend towards, so the gesture points
     the way the bar will move. */
  const growSide = $derived(action.due_date ? 'left' : 'right');

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    onNudge(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey);
  }
</script>

<!-- The mark is positioned by the parent and offset by transform while dragging:
     nothing on this chart animates layout, so a drag costs one composited
     property and the row underneath never reflows. -->
<div
  class="mark"
  class:bar={shape === 'bar'}
  class:milestone={shape === 'milestone'}
  class:done={action.done}
  class:overdue
  class:dragging
  class:selected
  style:left="{x}px"
  style:width={shape === 'bar' ? `${w}px` : undefined}
  style:transform={dragging ? `translate(${ghostX}px, ${ghostY}px)` : undefined}
  role="button"
  tabindex="0"
  aria-label="{action.text} — {action.start_date ?? 'no start'} to {action.due_date ??
    'no due date'}"
  onpointerdown={(e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onGrab('move', e);
  }}
  onkeydown={onKey}
>
  {#if shape === 'bar'}
    <!-- Six pixels, on the inside of the bar. A resize zone that hangs outside
         its own bar steals the pixels of whatever is next to it. -->
    <span
      class="edge left"
      onpointerdown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        onGrab('start', e);
      }}
      aria-hidden="true"
    ></span>
    <span class="label">{action.text}</span>
    <span
      class="edge right"
      onpointerdown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        onGrab('end', e);
      }}
      aria-hidden="true"
    ></span>
  {:else}
    <span class="diamond" aria-hidden="true"></span>
    <!-- Hidden until hover or focus: a permanent handle on every milestone
         would read as part of the mark rather than as a thing you can pull. -->
    <span
      class="grow {growSide}"
      onpointerdown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        onGrab('grow', e);
      }}
      aria-hidden="true"
    ></span>
  {/if}
</div>

<style>
  .mark {
    position: absolute;
    top: 4px;
    height: 18px;
    display: flex;
    align-items: center;
    /* The board's rule holds here: the pointer stays the pointer. Only the
       resize zones, which have no other tell, change it. */
    cursor: default;
    transition:
      background-color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease),
      opacity var(--dur-fast) var(--ease);
  }

  .mark:focus-visible {
    outline: 1px solid var(--focus);
    outline-offset: 1px;
  }

  /* Dragging leaves the transition behind — a bar that eased towards the
     pointer would lag it, and a bar that lags the pointer reads as the app
     being slow rather than as the bar being smooth. */
  .mark.dragging {
    transition: none;
    z-index: 3;
  }

  /* --- bar ---------------------------------------------------------------- */

  .bar {
    background: var(--panel-3);
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    box-shadow: inset 0 1px 0 var(--bezel);
    min-width: 3px;
    overflow: hidden;
  }

  .bar:hover {
    border-color: var(--legend-dim);
  }

  .bar.selected {
    border-color: var(--focus);
  }

  .bar.overdue {
    background: var(--anc-red-bg);
    border-color: var(--anc-red);
  }

  /* Finished work lies flat: it happened, it is not happening. */
  .bar.done {
    background: transparent;
    border-style: dashed;
    border-color: var(--hairline);
    box-shadow: none;
  }

  .label {
    flex: 1;
    min-width: 0;
    padding: 0 6px;
    font: 400 11px/1 var(--font-body);
    color: var(--ink-soft);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    user-select: none;
  }

  .bar.overdue .label {
    color: var(--anc-red);
  }

  .bar.done .label {
    color: var(--legend-dim);
    text-decoration: line-through;
  }

  .edge {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: ew-resize;
  }

  .edge.left {
    left: 0;
  }

  .edge.right {
    right: 0;
  }

  /* A grabbable edge you cannot see is a guess. One hairline of contrast on
     hover is enough to say the end is a control without drawing a handle. */
  .bar:hover .edge::after {
    content: '';
    position: absolute;
    top: 3px;
    bottom: 3px;
    width: 1px;
    background: var(--legend);
  }

  .bar:hover .edge.left::after {
    left: 2px;
  }

  .bar:hover .edge.right::after {
    right: 2px;
  }

  /* --- milestone ---------------------------------------------------------- */

  /* A real box, or there is nothing to press: a zero-width mark whose only
     child ignores the pointer cannot be grabbed at all. Centred on its day
     with a margin, because the transform is the drag ghost's. */
  .milestone {
    width: 14px;
    margin-left: -7px;
    justify-content: center;
  }

  /* A drawn shape, not a glyph: a rotated square renders identically in every
     lighting and takes the annunciator tokens like everything else. */
  .diamond {
    width: 10px;
    height: 10px;
    background: var(--legend);
    border: 1px solid var(--hairline);
    transform: rotate(45deg);
    pointer-events: none;
  }

  .milestone:hover .diamond {
    background: var(--ink-soft);
  }

  .milestone.selected .diamond {
    background: var(--focus);
  }

  .milestone.overdue .diamond {
    background: var(--anc-red);
    border-color: var(--anc-red);
  }

  .milestone.done .diamond {
    background: transparent;
    border-color: var(--legend-dim);
  }

  .grow {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 8px;
    cursor: ew-resize;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }

  .grow.left {
    right: 14px;
  }

  .grow.right {
    left: 14px;
  }

  .milestone:hover .grow,
  .milestone:focus-visible .grow {
    opacity: 1;
  }

  .grow::after {
    content: '';
    position: absolute;
    top: 5px;
    bottom: 5px;
    width: 6px;
    border-top: 1px solid var(--legend);
    border-bottom: 1px solid var(--legend);
  }

  .grow.left::after {
    left: 0;
  }

  .grow.right::after {
    right: 0;
  }
</style>
