<script lang="ts">
  import { excerptOf, store } from '../store.svelte';

  let { run }: { run: (id: string) => void } = $props();

  /* Grouping, sorting and the visible order all live in the store now, because
     Ctrl+Tab walks the same list this renders. Two copies of that ordering is
     two chances for the keyboard to disagree with what the user can see. */
  const groups = $derived(store.groups);
  const actionsActive = $derived(store.activeKey === 'actions');

  /* Delete is the one irreversible thing in the app, so it is armed in the row
     and confirmed in the row — no modal, and nothing is destroyed on a single
     click. Only ever one row is armed.

     Both clicks land on the same bin, in the same place: the row must not
     change height or move its controls between arming and confirming, or the
     second click becomes a second aiming problem. So the warning takes over
     the excerpt line rather than adding one. */
  let armed = $state<number | null>(null);
  let armTimer: number | undefined;

  /* An armed row disarms itself. A permanent delete that stays one click away
     while the user is off doing something else is a trap, not a shortcut. */
  const ARM_WINDOW = 5000;

  function arm(id: number) {
    armed = id;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => (armed = null), ARM_WINDOW) as unknown as number;
  }

  function disarm() {
    armed = null;
    clearTimeout(armTimer);
  }

  function actionCount(noteId: number): number {
    return store.actions.filter((a) => a.note_id === noteId).length;
  }

  function warning(noteId: number): string {
    const n = actionCount(noteId);
    if (n === 0) return 'Click again to delete permanently';
    return `Click again — deletes it and ${n} action${n === 1 ? '' : 's'}`;
  }

  async function onBin(id: number) {
    if (armed !== id) {
      arm(id);
      return;
    }
    disarm();
    await store.deleteNote(id);
  }

  function onWindowKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && armed !== null) disarm();
  }

  /* The signature move: logging an action makes the 00 lamp blip once, the way
     an annunciator acknowledges a new condition. One pulse, then it settles
     back to reporting the count — never a loop. */
  let blipping = $state(false);
  let blipTimer: number | undefined;

  $effect(() => {
    if (store.blip === 0) return;
    blipping = true;
    clearTimeout(blipTimer);
    blipTimer = setTimeout(() => (blipping = false), 620) as unknown as number;
  });

  /* An armed row that leaves the list — archived hidden, note deleted from
     elsewhere — must not stay armed behind the user's back. */
  $effect(() => {
    if (armed !== null && !store.visibleNotes.some((n) => n.id === armed)) disarm();
  });
</script>

<svelte:window onkeydown={onWindowKey} />

<aside class="sidebar">
  <header class="head">
    <span class="wordmark legend">Jotter</span>
    <button
      class="sw sw-icon"
      title="New note · Ctrl+N"
      aria-label="New note"
      onclick={() => run('note.new')}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.4" />
      </svg>
    </button>
  </header>

  <!-- Tab 00. Pinned above everything, because the checklist is the one page
       that is never a note and must never get buried under them. -->
  <button
    class="tab00"
    class:on={actionsActive}
    class:blip={blipping}
    onclick={() => store.openActions()}
    aria-current={actionsActive ? 'page' : undefined}
  >
    <span class="tab-edge edge00"></span>
    <span class="mono num">00</span>
    <span class="legend name">Actions</span>
    {#if store.overdueCount > 0}
      <span class="anc anc-red mono count">{store.overdueCount}</span>
    {:else if store.openActionCount > 0}
      <span class="anc anc-amber mono count">{store.openActionCount}</span>
    {:else}
      <span class="anc anc-green mono count">0</span>
    {/if}
  </button>

  <div class="controls">
    <select
      aria-label="Group notes by"
      value={store.groupBy}
      onchange={(e) => {
        store.groupBy = e.currentTarget.value as typeof store.groupBy;
        store.setSetting('group_by', store.groupBy);
      }}
    >
      <option value="none">No grouping</option>
      <option value="label">By label</option>
      <option value="date">By date</option>
    </select>

    <select
      aria-label="Sort notes by"
      value={store.sortBy}
      onchange={(e) => {
        store.sortBy = e.currentTarget.value as typeof store.sortBy;
        store.setSetting('sort_by', store.sortBy);
      }}
    >
      <option value="updated">Updated</option>
      <option value="created">Created</option>
      <option value="title">Title</option>
      <option value="label">Label</option>
    </select>

    <button
      class="sw sw-icon"
      aria-pressed={store.showArchived}
      title="Show or hide archived · Ctrl+Shift+E"
      aria-label="Show or hide archived"
      onclick={() => run('view.archived')}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <rect x="1.8" y="3.2" width="12.4" height="3" fill="none" stroke="currentColor" />
        <path d="M3.2 6.6V13h9.6V6.6M6.3 9.2h3.4" fill="none" stroke="currentColor" />
      </svg>
    </button>
  </div>

  <div class="list scroll">
    {#each groups as g (g.key)}
      {#if g.name}
        <div class="group-head">
          {#if g.color}<span class="swatch" style:background={g.color}></span>{/if}
          <span class="legend legend-sm">{g.name}</span>
          <span class="mono group-n">{g.notes.length}</span>
        </div>
      {/if}

      {#each g.notes as n (n.id)}
        {@const label = store.labelById(n.label_id)}
        <div
          class="row"
          class:on={store.activeKey === `note:${n.id}`}
          class:archived={n.archived}
          class:armed={armed === n.id}
        >
          <span class="tab-edge" style:background={label?.color ?? 'transparent'}></span>

          <!-- The title never moves and the row never changes height: an armed
               row that hid the note's name would ask the user to confirm a
               permanent delete against nothing but a list position, and one
               that grew would move the bin out from under the second click. -->
          <button
            class="row-open"
            onclick={() => (armed === n.id ? disarm() : store.openNote(n.id))}
          >
            <span class="title" class:strike={n.archived}>{n.title || 'Untitled'}</span>
            {#if armed === n.id}
              <span class="excerpt warn">{warning(n.id)}</span>
            {:else}
              <span class="excerpt">{excerptOf(n) || '—'}</span>
            {/if}
          </button>
          <span class="row-meta">
            {#if armed !== n.id}
              {#if n.pinned}<span class="pin" title="Pinned">▲</span>{/if}
              {#if n.open_actions > 0}
                <span class="anc anc-amber mono">{n.open_actions}</span>
              {/if}
            {/if}
            <button
              class="del"
              class:live={armed === n.id}
              title={armed === n.id ? 'Click again to delete permanently' : 'Delete permanently'}
              aria-label={armed === n.id
                ? `Confirm deleting ${n.title || 'Untitled'} permanently`
                : `Delete ${n.title || 'Untitled'} permanently`}
              onclick={() => onBin(n.id)}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path
                  d="M3 4.5h10M6.4 4.5V3h3.2v1.5M4.3 4.5l.6 8.2h6.2l.6-8.2M6.6 6.7v4M9.4 6.7v4"
                  fill="none"
                  stroke="currentColor"
                />
              </svg>
            </button>
          </span>
        </div>
      {/each}
    {/each}

    {#if store.visibleNotes.length === 0}
      <p class="none legend legend-sm">
        {store.notes.length ? 'Everything is stowed' : 'Nothing yet — press Ctrl+N'}
      </p>
    {/if}
  </div>
</aside>

<style>
  .sidebar {
    display: grid;
    grid-template-rows: auto auto auto minmax(0, 1fr);
    background: var(--panel-1);
    min-width: 0;
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 34px;
    padding: 0 5px 0 10px;
    border-bottom: 1px solid var(--hairline);
  }

  .wordmark {
    font-size: 12px;
    letter-spacing: 0.17em;
    color: var(--ink-soft);
  }

  /* The pinned checklist row. */
  .tab00 {
    display: grid;
    grid-template-columns: 3px auto 1fr auto;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 10px 0 0;
    background: var(--panel-1);
    border: 0;
    border-bottom: 1px solid var(--hairline);
    cursor: default;
    text-align: left;
    transition: background var(--dur-fast) var(--ease);
  }

  /* Same thumb-tab column every other row uses, so the sidebar has one edge
     mechanism rather than a border here and a span below. Amber because the
     page it opens is the one that reports outstanding work. */
  .edge00 {
    align-self: stretch;
    background: var(--anc-amber);
  }

  .tab00:hover {
    background: var(--panel-3);
  }

  .tab00.on {
    background: var(--panel-2);
  }

  /* Two beats of the caution wash, then done. Transform and background only —
     nothing here moves layout. */
  .tab00.blip {
    animation: blip 620ms var(--ease);
  }

  .tab00.blip .count {
    animation: lamp 620ms var(--ease);
  }

  @keyframes blip {
    0%,
    100% {
      background: var(--panel-1);
    }
    15%,
    55% {
      background: var(--anc-amber-bg);
    }
  }

  @keyframes lamp {
    0%,
    100% {
      transform: scale(1);
    }
    22% {
      transform: scale(1.35);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .tab00.blip,
    .tab00.blip .count {
      animation: none;
    }
  }

  .tab00 .num {
    color: var(--legend-dim);
    padding-left: 7px;
  }

  .tab00 .name {
    color: var(--ink-soft);
    font-size: 11.5px;
  }

  .count {
    font-size: 10.5px;
  }

  .controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    gap: 4px;
    padding: 5px 5px;
    border-bottom: 1px solid var(--hairline);
  }

  .controls select {
    font-family: var(--font-legend);
    font-variation-settings: var(--wdth-legend);
    font-size: 10px;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    height: 22px;
    min-width: 0;
    padding: 0 1px 0 4px;
    background: var(--panel-0);
    color: var(--legend);
  }

  .controls .sw {
    height: 22px;
    width: 24px;
  }

  .list {
    padding-bottom: 8px;
  }

  .group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 10px 4px;
    position: sticky;
    top: 0;
    background: var(--panel-1);
    z-index: 1;
  }

  .swatch {
    width: 7px;
    height: 7px;
    border-radius: 1px;
  }

  .group-n {
    margin-left: auto;
    color: var(--legend-dim);
    font-size: 10px;
  }

  .row {
    display: grid;
    grid-template-columns: 3px minmax(0, 1fr) auto;
    align-items: stretch;
    gap: 8px;
    width: 100%;
    padding: 6px 9px 7px 0;
    background: transparent;
    border-bottom: 1px solid var(--hairline-soft);
    transition: background var(--dur-fast) var(--ease);
  }

  .row:hover {
    background: var(--panel-3);
  }

  .row.on {
    background: var(--panel-2);
  }

  /* Armed to delete: the row wears the alert wash for as long as it is armed,
     which is the only place in the sidebar red is ever allowed. */
  .row.armed,
  .row.armed:hover {
    background: var(--anc-red-bg);
  }

  /* The thumb tab: a note's label reads as the coloured edge of a divider,
     which is what a tabbed handbook actually looks like. */
  .tab-edge {
    border-radius: 0 1px 1px 0;
  }

  .row.on .tab-edge {
    box-shadow: inset -1px 0 0 var(--bezel);
  }

  .row-open {
    display: grid;
    gap: 1px;
    min-width: 0;
    align-content: start;
    background: none;
    border: 0;
    padding: 0;
    text-align: left;
    color: inherit;
    cursor: default;
  }

  .title {
    font-size: 13px;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.35;
  }

  .excerpt {
    font-size: 11.5px;
    color: var(--legend);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.3;
  }

  .archived .excerpt {
    color: var(--legend-dim);
  }

  /* The warning takes the excerpt's line, at the excerpt's size, so arming a
     row recolours it instead of resizing it. */
  .excerpt.warn {
    color: var(--anc-red);
  }

  .row-meta {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .row-meta .anc {
    font-size: 10px;
  }

  .pin {
    font-size: 8px;
    color: var(--legend-dim);
  }

  /* Hidden until the row is under the pointer or the button has focus, so a
     destructive control is never sitting in the resting state of the list. */
  .del {
    background: none;
    border: 0;
    color: var(--legend-dim);
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border-radius: var(--r);
    cursor: default;
    opacity: 0;
    transition:
      opacity var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }

  .row:hover .del,
  .del:focus-visible,
  .del.live {
    opacity: 1;
  }

  .del:hover {
    color: var(--anc-red);
    background: var(--panel-0);
  }

  /* Armed: the same button, in the same place, now reading as the thing it is
     about to do. The second click never has to be aimed. */
  .del.live,
  .del.live:hover {
    color: var(--panel-0);
    background: var(--anc-red);
  }

  .none {
    padding: 18px 12px;
    text-align: center;
    color: var(--legend-dim);
  }
</style>
