<script lang="ts">
  import { api, type Action } from '../api';
  import { store } from '../store.svelte';
  import Board from './Board.svelte';
  import CardPanel from './CardPanel.svelte';
  import Timeline from './Timeline.svelte';
  import { RANGE_STEPS, ZOOMS, ZOOM_ORDER, type Zoom } from '../timeline/scale';

  let chart = $state<ReturnType<typeof Timeline> | null>(null);

  type View = 'open' | 'today' | 'overdue' | 'done';
  type GroupMode = 'none' | 'note' | 'label' | 'project' | 'due';

  let view = $state<View>('open');
  let groupMode = $state<GroupMode>('none');
  let draft = $state('');
  let dragId = $state<number | null>(null);

  /* Read from the store rather than computed here: this page can sit open
     across midnight, and a `today` frozen at mount would quietly stop
     reporting what is overdue. */
  const today = $derived(store.today);

  const filtered = $derived.by(() => {
    const a = store.actions;
    switch (view) {
      case 'done':
        return a.filter((x) => x.done);
      case 'today':
        return a.filter((x) => !x.done && x.due_date !== null && x.due_date <= today);
      case 'overdue':
        return a.filter((x) => !x.done && x.due_date !== null && x.due_date < today);
      default:
        return a.filter((x) => !x.done);
    }
  });

  interface Group {
    key: string;
    name: string;
    color: string | null;
    items: Action[];
  }

  const groups = $derived.by((): Group[] => {
    if (groupMode === 'none') {
      return [{ key: 'all', name: '', color: null, items: filtered }];
    }
    const buckets = new Map<string, Group>();
    for (const a of filtered) {
      let key: string, name: string, color: string | null;
      if (groupMode === 'note') {
        key = a.note_id ? `n${a.note_id}` : 'loose';
        name = a.note_title || (a.note_id ? 'Untitled' : 'Not from a note');
        color = store.labelById(a.label_id)?.color ?? null;
      } else if (groupMode === 'label') {
        const l = store.labelById(a.label_id);
        key = l ? `l${l.id}` : 'none';
        name = l?.name ?? 'Unlabelled';
        color = l?.color ?? null;
      } else if (groupMode === 'project') {
        const pr = store.projectById(a.project_id);
        key = pr ? `p${pr.id}` : 'noproject';
        name = pr?.name ?? 'No project';
        color = pr?.color ?? null;
      } else {
        key = a.due_date ?? 'nodue';
        name = a.due_date ? dueName(a.due_date) : 'No date';
        color = a.due_date && a.due_date < today ? 'var(--anc-red)' : null;
      }
      if (!buckets.has(key)) buckets.set(key, { key, name, color, items: [] });
      buckets.get(key)!.items.push(a);
    }
    return [...buckets.values()];
  });

  function dueName(d: string): string {
    if (d === today) return 'Today';
    if (d < today) return `Overdue · ${d}`;
    return d;
  }

  function dueTone(a: Action): 'anc-red' | 'anc-amber' | 'anc-off' {
    if (!a.due_date || a.done) return 'anc-off';
    if (a.due_date < today) return 'anc-red';
    if (a.due_date === today) return 'anc-amber';
    return 'anc-off';
  }

  async function addDraft() {
    const text = draft.trim();
    if (!text) return;
    draft = '';
    await api.createAction(text, null, null, null);
    await store.refreshActions();
  }

  async function commitText(a: Action, next: string) {
    const text = next.trim();
    if (!text || text === a.text) return;
    await api.setActionText(a.id, text);
    await store.refreshActions();
  }

  async function setDue(a: Action, value: string) {
    await api.setActionDue(a.id, value || null);
    await store.refreshActions();
  }

  /* Reorder writes the whole visible order back, so a dropped drag event can
     never leave two rows claiming the same slot. */
  async function drop(target: Action) {
    if (dragId === null || dragId === target.id) return;
    const ids = filtered.map((a) => a.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(target.id);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    dragId = null;
    await api.reorderActions(ids);
    await store.refreshActions();
  }

  const VIEWS: { id: View; label: string }[] = [
    { id: 'open', label: 'Open' },
    { id: 'today', label: 'Today' },
    { id: 'overdue', label: 'Overdue' },
    { id: 'done', label: 'Done' }
  ];
</script>

<div class="wrap">
  <header class="head">
    <div class="mode" role="tablist" aria-label="Actions layout">
      {#each ['list', 'board', 'timeline'] as const as m (m)}
        <button
          class="sw"
          role="tab"
          aria-selected={store.actionsView === m}
          class:latched={store.actionsView === m}
          onclick={() => store.setActionsView(m)}
        >
          {m === 'list' ? 'List' : m === 'board' ? 'Board' : 'Timeline'}
        </button>
      {/each}
    </div>

    <span class="divider"></span>

    {#if store.actionsView === 'board'}
      <label class="group-by">
        <span class="legend legend-sm">Project</span>
        <select
          aria-label="Filter the board by project"
          value={store.boardProject ?? ''}
          onchange={(e) =>
            (store.boardProject =
              e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
        >
          <option value="">All projects</option>
          {#each store.projects.filter((p) => !p.hidden) as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
          <option value="0">No project</option>
        </select>
      </label>

      <label class="group-by">
        <span class="legend legend-sm">Sort</span>
        <select
          aria-label="Sort cards inside every column"
          value={store.boardSort}
          onchange={(e) =>
            store.setBoardSort(e.currentTarget.value as 'manual' | 'due' | 'project')}
        >
          <option value="manual">Hand-sorted</option>
          <option value="due">Due date</option>
          <option value="project">Project</option>
        </select>
      </label>

      <span class="spacer"></span>

      <button class="sw" onclick={() => store.openSettings()}>Edit columns</button>
    {:else if store.actionsView === 'timeline'}
      <label class="group-by">
        <span class="legend legend-sm">Project</span>
        <select
          aria-label="Filter the chart by project"
          value={store.boardProject ?? ''}
          onchange={(e) =>
            (store.boardProject =
              e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
        >
          <option value="">All projects</option>
          {#each store.projects.filter((p) => !p.hidden) as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
          <option value="0">No project</option>
        </select>
      </label>

      <label class="group-by">
        <span class="legend legend-sm">Zoom</span>
        <select
          aria-label="Timeline zoom"
          value={store.timelineZoom}
          onchange={(e) => store.setTimelineZoom(e.currentTarget.value as Zoom)}
        >
          {#each ZOOM_ORDER as z (z)}
            <option value={z}>{ZOOMS[z].label}</option>
          {/each}
        </select>
      </label>

      <!-- Two halves of one window: how far back it reaches and how far
           forward. `Fit` answers the same question from the work instead, so
           setting either half turns it off. -->
      <label class="group-by">
        <span class="legend legend-sm">Range</span>
        <select
          aria-label="How far back the chart reaches"
          value={store.timelineBack}
          onchange={(e) =>
            store.setTimelineRange(Number(e.currentTarget.value), store.timelineFwd)}
        >
          {#each RANGE_STEPS as r (r.days)}
            <option value={r.days}>-{r.label}</option>
          {/each}
        </select>
        <select
          aria-label="How far forward the chart reaches"
          value={store.timelineFwd}
          onchange={(e) =>
            store.setTimelineRange(store.timelineBack, Number(e.currentTarget.value))}
        >
          {#each RANGE_STEPS as r (r.days)}
            <option value={r.days}>+{r.label}</option>
          {/each}
        </select>
      </label>

      <button
        class="sw"
        class:latched={store.timelineFit}
        aria-pressed={store.timelineFit}
        title="Span the dated work instead of a fixed window"
        onclick={() => store.setTimelineFit(!store.timelineFit)}
      >
        Fit
      </button>

      <label class="group-by">
        <span class="legend legend-sm">Order</span>
        <select
          aria-label="Order rows inside each project"
          value={store.timelineSort}
          onchange={(e) =>
            store.setTimelineSort(e.currentTarget.value as 'manual' | 'start' | 'due')}
        >
          <option value="manual">Hand-sorted</option>
          <option value="start">Start date</option>
          <option value="due">Due date</option>
        </select>
      </label>

      <span class="spacer"></span>

      <div class="tail">
        <!-- The chart draws only what carries a date, so it says out loud how
             much it is not drawing. A timeline that silently omits work is a
             timeline you cannot trust. -->
        {#if store.timelineUndated > 0}
          <span class="legend legend-sm undated" title="Open actions with no dates are not drawn">
            {store.timelineUndated} undated
          </span>
        {/if}

        <button
          class="sw"
          class:latched={store.timelineShowDone}
          aria-pressed={store.timelineShowDone}
          onclick={() => store.setTimelineShowDone(!store.timelineShowDone)}
        >
          Completed
        </button>

        <button class="sw" onclick={() => chart?.scrollToToday()}>Today</button>
      </div>
    {:else}
    <div class="views" role="tablist" aria-label="Action view">
      {#each VIEWS as v (v.id)}
        <button
          class="sw"
          role="tab"
          aria-selected={view === v.id}
          class:latched={view === v.id}
          onclick={() => (view = v.id)}
        >
          {v.label}
          {#if v.id === 'open'}<span class="mono n">{store.openActionCount}</span>{/if}
          {#if v.id === 'overdue' && store.overdueCount > 0}
            <span class="mono n red">{store.overdueCount}</span>
          {/if}
        </button>
      {/each}
    </div>

    <span class="spacer"></span>

    <label class="group-by">
      <span class="legend legend-sm">Group</span>
      <select bind:value={groupMode} aria-label="Group actions by">
        <option value="none">None</option>
        <option value="note">Source note</option>
        <option value="label">Label</option>
        <option value="project">Project</option>
        <option value="due">Due date</option>
      </select>
    </label>
    {/if}
  </header>

  {#if store.actionsView === 'board'}
    <!-- The panel is a track, not an overlay. Floated over the board it covered
         the finish column, which is the one you most want to see while you are
         moving something towards it. -->
    <div class="boardwrap" class:withpanel={store.openCard !== null}>
      <Board />
      <!-- Keyed on the card, so the panel's own drafts belong to the row it is
           showing and never carry over to the next one opened. -->
      {#if store.openCard !== null}
        {#key store.openCard}
          <CardPanel />
        {/key}
      {/if}
    </div>
  {:else if store.actionsView === 'timeline'}
    <!-- Same track discipline as the board: the panel narrows the chart rather
         than covering the part of it you are dragging towards. -->
    <div class="boardwrap" class:withpanel={store.openCard !== null}>
      <Timeline bind:this={chart} />
      {#if store.openCard !== null}
        {#key store.openCard}
          <CardPanel />
        {/key}
      {/if}
    </div>
  {:else}
  <div class="sheet scroll">
    <div class="page">
      <div class="add">
        <span class="anc anc-off"></span>
        <input
          type="text"
          bind:value={draft}
          placeholder="Add an action — or highlight a sentence in a note and press Ctrl+Shift+A"
          onkeydown={(e) => e.key === 'Enter' && addDraft()}
        />
        <button class="sw" disabled={!draft.trim()} onclick={addDraft}>Add</button>
      </div>

      {#each groups as g (g.key)}
        {#if g.name}
          <div class="group-head">
            {#if g.color}<span class="swatch" style:background={g.color}></span>{/if}
            <span class="legend legend-sm">{g.name}</span>
            <span class="mono group-n">{g.items.length}</span>
          </div>
        {/if}

        {#each g.items as a (a.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="row"
            class:done={a.done}
            draggable={groupMode === 'none' && !a.done}
            ondragstart={() => (dragId = a.id)}
            ondragover={(e) => e.preventDefault()}
            ondrop={() => drop(a)}
          >
            <button
              class="check"
              role="checkbox"
              aria-checked={a.done}
              aria-label={a.done ? 'Reopen action' : 'Complete action'}
              onclick={() => store.toggleAction(a.id, !a.done)}
            >
              {#if a.done}
                <svg viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
                  <path d="M2 7.5l3.2 3.2L12 3.6" fill="none" stroke="currentColor" stroke-width="2" />
                </svg>
              {/if}
            </button>

            <span
              class="text"
              contenteditable="plaintext-only"
              role="textbox"
              tabindex="0"
              aria-label="Action text"
              onblur={(e) => commitText(a, e.currentTarget.textContent ?? '')}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.currentTarget as HTMLElement).blur();
                }
              }}>{a.text}</span
            >

            <div class="meta">
              <select
                class="proj legend legend-sm"
                aria-label="Project"
                value={a.project_id ?? ''}
                onchange={(e) =>
                  store.setActionProject(
                    a.id,
                    e.currentTarget.value === '' ? null : Number(e.currentTarget.value)
                  )}
              >
                <option value="">No project</option>
                {#each store.projects.filter((p) => !p.hidden || p.id === a.project_id) as p (p.id)}
                  <option value={p.id}>{p.name}</option>
                {/each}
              </select>

              {#if a.note_id}
                <button
                  class="src legend legend-sm"
                  title="Open the source note at this line"
                  onclick={() => store.reveal(a.note_id!, a.anchor_id)}
                >
                  {a.note_title || 'Untitled'}
                </button>
              {/if}

              <label class="due {dueTone(a)}" class:unset={!a.due_date} title="Due date">
                <span class="anc"></span>
                <input
                  type="date"
                  value={a.due_date ?? ''}
                  aria-label="Due date"
                  onchange={(e) => setDue(a, e.currentTarget.value)}
                />
              </label>
            </div>
          </div>
        {/each}
      {/each}

      {#if filtered.length === 0}
        <p class="none legend">
          {view === 'done' ? 'Nothing completed yet' : 'Checklist clear'}
        </p>
      {/if}
    </div>
  </div>
  {/if}
</div>

<style>
  .wrap {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
    background: var(--panel-0);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--rail);
    padding: 0 8px;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    scrollbar-color: var(--hairline) transparent;
    background: var(--panel-1);
    border-bottom: 1px solid var(--hairline);
    box-shadow: inset 0 1px 0 0 var(--bezel);
  }

  .views,
  .mode {
    display: flex;
    gap: 1px;
  }

  /* The two ways of reading the same actions. Kept at the far left, ahead of
     the filters, because it changes what the filters even apply to. */
  .divider {
    width: 1px;
    align-self: stretch;
    margin: 6px 2px;
    background: var(--hairline);
  }

  /* A tab cannot carry aria-pressed, so the latched switch look is reproduced
     here rather than borrowed from the .sw[aria-pressed] rule. */
  .mode .latched,
  .views .latched {
    background: var(--panel-0);
    border-color: var(--hairline);
    color: var(--anc-amber);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.25);
  }

  .n {
    font-size: 10px;
    color: var(--legend-dim);
  }

  .n.red {
    color: var(--anc-red);
  }

  /* Everything on the rail keeps its size when the rail runs out of room; the
     spacer is the one thing allowed to collapse, so the clusters close up
     before any control starts squashing. Written as `:not(.spacer)` rather
     than a pair of rules because a `.head > *` child selector would outrank
     `.spacer` on specificity and silently win. */
  .head > *:not(.spacer) {
    flex-shrink: 0;
  }

  .spacer {
    flex: 1;
    min-width: 0;
  }

  /* The chart's controls can outrun a narrow rail, and the rail scrolls rather
     than pushing the window wide. What must not scroll away is the pair that
     acts on what is on screen right now — a Today button you have to go and
     find is not a Today button. They ride the end of the rail instead, with
     the rail's own background so the scrolled controls pass under them. */
  .tail {
    position: sticky;
    right: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding-left: 10px;
    background: var(--panel-1);
  }

  /* The project a row belongs to, set without leaving the checklist. Reads as
     a legend chip until it is opened. */
  .proj {
    appearance: none;
    height: 19px;
    max-width: 108px;
    padding: 0 3px;
    background: transparent;
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    color: var(--legend);
    font-size: 9.5px;
  }

  .row:not(:hover) .proj:not(:focus) {
    border-color: transparent;
    color: var(--legend-dim);
  }

  .group-by {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .group-by select {
    font-family: var(--font-legend);
    font-variation-settings: var(--wdth-legend);
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.07em;
    color: var(--legend);
    height: 22px;
  }

  /* Each variant spells out its own track list. A single fixed list plus a
     conditional child is how content ends up in the wrong track. */
  .undated {
    color: var(--anc-amber);
    white-space: nowrap;
  }

  .boardwrap {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
  }

  .boardwrap.withpanel {
    grid-template-columns: minmax(0, 1fr) 336px;
  }

  .sheet {
    display: flex;
    justify-content: center;
    align-items: stretch;
  }

  .page {
    flex: 0 1 880px;
    min-height: 100%;
    height: max-content;
    background: var(--panel-2);
    border-left: 1px solid var(--hairline);
    border-right: 1px solid var(--hairline);
    padding: 14px 0 30px;
  }

  .add {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    padding: 0 18px 12px;
    border-bottom: 1px solid var(--hairline);
  }

  .add input {
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--hairline);
    border-radius: 0;
    height: 28px;
    font-size: 13px;
  }

  .add input:focus {
    outline: none;
    border-bottom-color: var(--focus);
  }

  .group-head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 16px 18px 5px;
  }

  .swatch {
    width: 7px;
    height: 7px;
    border-radius: 1px;
  }

  .group-n {
    margin-left: auto;
    font-size: 10px;
    color: var(--legend-dim);
  }

  /* A checklist line: lamp, item, provenance. The rule under each row is the
     printed page's own ruling, not a card edge. */
  .row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 11px;
    padding: 8px 18px;
    border-bottom: 1px solid var(--hairline-soft);
    transition: background var(--dur-fast) var(--ease);
  }

  .row:hover {
    background: var(--panel-3);
  }

  .check {
    width: 15px;
    height: 15px;
    flex: none;
    align-self: center;
    display: grid;
    place-items: center;
    background: var(--panel-0);
    border: 1px solid var(--legend-dim);
    border-radius: 1px;
    color: var(--anc-green);
    cursor: default;
    transition:
      border-color var(--dur-fast) var(--ease),
      background var(--dur-fast) var(--ease);
  }

  .check:hover {
    border-color: var(--anc-amber);
  }

  .row.done .check {
    border-color: var(--anc-green);
    background: var(--anc-green-bg);
  }

  /* Completing draws the line rather than snapping it on: text-decoration
     cannot animate, so the strike is a rule that wipes across from the left,
     which is what striking an item on paper looks like. */
  .text {
    position: relative;
    font-size: 13.5px;
    line-height: 1.5;
    outline: none;
    min-width: 0;
    transition: color var(--dur-base) var(--ease);
  }

  .text::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 1px;
    background: currentColor;
    transform: scaleX(0);
    transform-origin: left center;
    transition: transform var(--dur-base) var(--ease);
    pointer-events: none;
  }

  .row.done .text {
    color: var(--legend-dim);
  }

  .row.done .text::after {
    transform: scaleX(1);
  }

  .text:focus {
    box-shadow: inset 0 -1px 0 var(--focus);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
  }

  .src {
    background: none;
    border: 0;
    border-left: 2px solid var(--hairline);
    padding: 1px 0 1px 7px;
    color: var(--legend-dim);
    max-width: 170px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: default;
  }

  .src:hover {
    color: var(--anc-amber);
    border-left-color: var(--anc-amber);
  }

  .due {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .due input {
    background: transparent;
    border: 0;
    color: var(--legend);
    font-family: var(--font-mono);
    font-size: 10.5px;
    width: 106px;
    height: 20px;
    padding: 0;
  }

  /* An empty date input paints its own `mm/dd/yyyy` skeleton, which put a loud
     placeholder on every undated row — most of them. The field stays there and
     stays reachable; it just does not shout until the row is under the pointer
     or the field has focus. */
  .due.unset input {
    color: transparent;
    transition: color var(--dur-fast) var(--ease);
  }

  .row:hover .due.unset input,
  .due.unset input:focus {
    color: var(--legend-dim);
  }

  .due .anc {
    gap: 0;
  }

  .due.anc-off .anc::before {
    opacity: 0.35;
  }

  .none {
    padding: 44px 18px;
    text-align: center;
    color: var(--legend-dim);
    font-size: 11px;
  }
</style>
