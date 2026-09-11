<script lang="ts">
  import { api, type Action, type Stage } from '../api';
  import { store } from '../store.svelte';

  const today = $derived(store.today);

  const stages = $derived(store.visibleStages);
  /** A computed order has nothing for a within-column drag to write. */
  const sorted = $derived(store.boardSort !== 'manual');

  /** One drag at a time, and the board has two kinds: a card between columns
      and a column across the board. Without a kind, a column header dragged
      over a card list reads as a card drop. */
  let dragKind = $state<'card' | 'col' | null>(null);
  let dragId = $state<number | null>(null);
  /** The card a drop would land in front of. */
  let overId = $state<number | null>(null);
  let overStage = $state<number | null>(null);
  /** Set while the pointer is over a column's empty tail, where a drop appends. */
  let overTail = $state<number | null>(null);
  let overCol = $state<number | null>(null);

  let menuFor = $state<number | null>(null);
  let renaming = $state<number | null>(null);
  let armedDelete = $state<number | null>(null);
  let composing = $state<number | null>(null);
  let addingCol = $state(false);
  let newCol = $state('');
  let drafts = $state<Record<number, string>>({});
  let showDone = $state<Record<number, boolean>>({});

  function clearDrag() {
    dragKind = null;
    dragId = null;
    overId = null;
    overStage = null;
    overTail = null;
    overCol = null;
  }

  function closeMenu() {
    menuFor = null;
    armedDelete = null;
  }

  function dueTone(a: Action): 'anc-red' | 'anc-amber' | 'anc-off' {
    if (!a.due_date || a.done) return 'anc-off';
    if (a.due_date < today) return 'anc-red';
    if (a.due_date === today) return 'anc-amber';
    return 'anc-off';
  }

  /**
   * Chromium will not begin a drag from an arbitrary element unless the
   * dragstart handler puts something on the dataTransfer. Nothing reads this
   * payload — the drag state lives in the component — but without it the whole
   * gesture is dead on arrival.
   */
  function beginDrag(e: DragEvent, kind: 'card' | 'col', id: number) {
    dragKind = kind;
    dragId = id;
    e.dataTransfer?.setData('text/plain', `${kind}:${id}`);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  /**
   * Accepting a drop takes two things, and the second one is easy to miss.
   * `preventDefault` says "a drop may happen here"; `dropEffect` says which
   * one. With `effectAllowed = 'move'` set at the source and no `dropEffect`
   * named here, Chromium resolves the operation to none and delivers `dragend`
   * to the page instead of `drop` — the card lifts, the target lights up, and
   * releasing does nothing at all.
   */
  function accept(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  // --- cards ----------------------------------------------------------------

  /**
   * A drop writes the destination column's whole order back, so a dropped event
   * can never leave two cards claiming one slot. `before` null means the end.
   */
  async function place(id: number, stageId: number, before: number | null) {
    const order = store.columnOrder(stageId).filter((x) => x !== id);
    const at = before === null ? order.length : order.indexOf(before);
    order.splice(at < 0 ? order.length : at, 0, id);
    clearDrag();
    await store.moveAction(id, stageId, order);
  }

  function dropCard(stageId: number, before: number | null) {
    if (dragKind !== 'card' || dragId === null) return;
    // Under a computed sort there is no position to drop into, only a column.
    void place(dragId, stageId, sorted ? null : before);
  }

  /**
   * Every drag has a keyboard route: Alt+←/→ walks a card across columns,
   * Alt+↑/↓ moves it inside one. A board that can only be operated with a
   * mouse is a board half of this app cannot reach.
   */
  async function onCardKey(e: KeyboardEvent, a: Action) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      store.openCard = a.id;
      return;
    }
    if (!e.altKey) return;
    const stageId = store.stageOf(a);
    if (stageId === null) return;
    const col = stages.findIndex((s) => s.id === stageId);

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const next = stages[col + (e.key === 'ArrowRight' ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      // Onto the top of the next column, where it can be seen after it lands.
      await place(a.id, next.id, store.columnOrder(next.id)[0] ?? null);
      return;
    }

    if (sorted) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const order = store.columnOrder(stageId);
      const i = order.indexOf(a.id);
      const j = i + (e.key === 'ArrowDown' ? 1 : -1);
      if (j < 0 || j >= order.length) return;
      e.preventDefault();
      await place(a.id, stageId, e.key === 'ArrowDown' ? (order[j + 1] ?? null) : order[j]);
    }
  }

  async function addTo(stageId: number) {
    const text = (drafts[stageId] ?? '').trim();
    if (!text) return;
    drafts[stageId] = '';
    const created = await api.createAction(text, null, null, null);
    if (store.boardProject !== null && store.boardProject !== 0) {
      await api.setActionProject(created.id, store.boardProject);
    }
    await store.refreshActions();
    // New work goes to the top of the column it was typed into, where the eye
    // already is, rather than at the far end of a list you would have to hunt.
    await place(created.id, stageId, store.columnOrder(stageId).filter((x) => x !== created.id)[0] ?? null);
  }

  function startCompose(stageId: number) {
    composing = composing === stageId ? null : stageId;
  }

  // --- columns --------------------------------------------------------------

  function dropColumn(targetId: number) {
    if (dragKind !== 'col' || dragId === null || dragId === targetId) return;
    const ids = store.stages.map((s) => s.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    ids.splice(to, 0, ...ids.splice(from, 1));
    clearDrag();
    void store.reorderStages(ids);
  }

  function commitRename(s: Stage, value: string) {
    renaming = null;
    void store.renameStage(s.id, value);
  }

  /** Same idiom as the sidebar's bin: the confirm is the same control clicked
      again, in place, so nothing has to be re-aimed at. */
  async function onDelete(id: number) {
    if (armedDelete !== id) {
      armedDelete = id;
      return;
    }
    closeMenu();
    await store.deleteStage(id);
  }

  async function addColumn() {
    const name = newCol.trim();
    if (!name) return;
    newCol = '';
    addingCol = false;
    await store.addStage(name);
  }

  /** Hiding keeps the column and its name; the cards go to the first visible
      one and the count is reported, the same as hiding from Settings does. */
  async function hide(s: Stage) {
    const moved = await api.updateStage(s.id, s.name, true);
    await Promise.all([store.refreshBoard(), store.refreshActions()]);
    store.flash(
      moved > 0
        ? `${s.name} hidden — ${moved} card${moved === 1 ? '' : 's'} moved`
        : `${s.name} hidden`,
      'amber'
    );
  }
</script>

<svelte:window onclick={closeMenu} onkeydown={(e) => e.key === 'Escape' && closeMenu()} />

<div class="board scroll-x">
  {#each stages as s, ci (s.id)}
    {@const cards = store.cardsIn(s.id)}
    {@const done = store.completedIn(s.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <section
      class="col"
      class:target={overStage === s.id && dragKind === 'card'}
      class:col-target={overCol === s.id && dragKind === 'col'}
      ondragover={(e) => {
        accept(e);
        if (dragKind === 'col') overCol = s.id;
      }}
      ondrop={() => dropColumn(s.id)}
    >
      <!-- The header is the column's handle, the way a bucket title is in
           Planner: grab the name, the whole column comes with it. No grab
           cursor — the pointer stays the pointer, the drag still works. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <header
        class="col-head"
        draggable={renaming === s.id ? 'false' : 'true'}
        ondragstart={(e) => beginDrag(e, 'col', s.id)}
        ondragend={clearDrag}
        ondblclick={() => (renaming = s.id)}
      >
        {#if renaming === s.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="rename"
            type="text"
            autofocus
            value={s.name}
            aria-label="Column name"
            onblur={(e) => commitRename(s, e.currentTarget.value)}
            onkeydown={(e) => {
              if (e.key === 'Enter') commitRename(s, e.currentTarget.value);
              if (e.key === 'Escape') renaming = null;
            }}
          />
        {:else}
          <!-- A span, not a button, and that is load-bearing: Chromium will not
               start an element drag from a form control, so a <button> here made
               the whole header undraggable by exactly the grip a user reaches
               for first. -->
          <span
            class="name legend"
            role="button"
            tabindex="0"
            title="Rename this column"
            onclick={(e) => {
              e.stopPropagation();
              renaming = s.id;
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                renaming = s.id;
              }
            }}>{s.name}</span
          >
          <span class="mono n">{cards.length}</span>

          <button
            class="sw sw-icon plus"
            aria-label={`Add an action to ${s.name}`}
            title="Add an action here"
            aria-expanded={composing === s.id}
            onclick={(e) => {
              e.stopPropagation();
              startCompose(s.id);
            }}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.4" />
            </svg>
          </button>

          <button
            class="sw sw-icon more"
            aria-label={`Column menu for ${s.name}`}
            aria-expanded={menuFor === s.id}
            onclick={(e) => {
              e.stopPropagation();
              const open = menuFor === s.id;
              closeMenu();
              menuFor = open ? null : s.id;
            }}>⋯</button
          >
        {/if}

        {#if menuFor === s.id}
          <!-- The stop matters: without it the window handler that closes menus
               would also clear the delete arm on its own first click. -->
          <div
            class="menu"
            role="menu"
            tabindex="-1"
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => e.key === 'Escape' && closeMenu()}
          >
            <button class="mi" role="menuitem" onclick={() => ((renaming = s.id), closeMenu())}
              >Rename</button
            >
            <button
              class="mi"
              role="menuitem"
              disabled={ci === 0}
              onclick={() => (store.moveStage(s.id, -1), closeMenu())}>Move left</button
            >
            <button
              class="mi"
              role="menuitem"
              disabled={ci === stages.length - 1}
              onclick={() => (store.moveStage(s.id, 1), closeMenu())}>Move right</button
            >
            <hr />
            <button
              class="mi"
              role="menuitem"
              title="Keeps the column and its name; takes it off the board"
              onclick={() => (closeMenu(), hide(s))}>Hide</button
            >
            <button
              class="mi danger"
              role="menuitem"
              class:live={armedDelete === s.id}
              disabled={store.stages.length <= 1}
              title={store.stages.length > 1
                ? 'Deletes the column; its cards move to the first one'
                : 'The last column cannot be deleted'}
              onclick={() => onDelete(s.id)}
              >{armedDelete === s.id ? 'Click again to delete' : 'Delete column'}</button
            >
          </div>
        {/if}
      </header>

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="cards scroll"
        ondragover={(e) => {
          accept(e);
          if (dragKind !== 'card') return;
          overStage = s.id;
        }}
        ondrop={(e) => {
          // A column dragged over this area is still a column drop. Swallowing
          // it here is what made dropping a column onto another column's cards
          // do nothing at all.
          if (dragKind !== 'card') return;
          e.stopPropagation();
          dropCard(s.id, null);
        }}
      >
        {#if composing === s.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="compose"
            type="text"
            autofocus
            placeholder="What needs doing"
            aria-label={`New action in ${s.name}`}
            value={drafts[s.id] ?? ''}
            oninput={(e) => (drafts[s.id] = e.currentTarget.value)}
            onblur={() => (drafts[s.id]?.trim() ? addTo(s.id) : (composing = null))}
            onkeydown={(e) => {
              if (e.key === 'Enter') addTo(s.id);
              if (e.key === 'Escape') ((drafts[s.id] = ''), (composing = null));
            }}
          />
        {/if}

        {#each cards as a (a.id)}
          {@const project = store.projectById(a.project_id)}
          <div
            class="card"
            class:overdue={store.isOverdue(a)}
            data-id={a.id}
            class:lifted={dragKind === 'card' && dragId === a.id}
            class:before={overId === a.id && dragKind === 'card' && !sorted}
            class:open={store.openCard === a.id}
            role="button"
            tabindex="0"
            aria-label={`Open "${a.text}"`}
            draggable="true"
            onclick={() => (store.openCard = a.id)}
            onkeydown={(e) => onCardKey(e, a)}
            ondragstart={(e) => beginDrag(e, 'card', a.id)}
            ondragend={clearDrag}
            ondragover={(e) => {
              accept(e);
              if (dragKind !== 'card') return;
              e.stopPropagation();
              overId = a.id;
              overStage = s.id;
              overTail = null;
            }}
            ondrop={(e) => {
              if (dragKind !== 'card') return;
              e.stopPropagation();
              dropCard(s.id, a.id);
            }}
          >
            <span class="edge" style:background={project?.color ?? 'transparent'}></span>

            <!-- The quick tick. Planner puts a completion control on the face of
                 the card and so does this: the most common thing anyone does to
                 a card should not require opening it. -->
            <button
              class="tick"
              role="checkbox"
              aria-checked="false"
              aria-label="Mark as done"
              title="Mark as done"
              onclick={(e) => {
                e.stopPropagation();
                store.toggleAction(a.id, true);
                showDone[s.id] = showDone[s.id] ?? false;
              }}
            >
              <svg viewBox="0 0 14 14" width="10" height="10" aria-hidden="true">
                <path
                  d="M2.6 7.3 5.6 10.2 11.4 4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.9"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>

            <div class="body">
              <p class="text">{a.text}</p>

              <div class="meta">
                {#if project}
                  <span class="chip" style:border-color={project.color}>{project.name}</span>
                {/if}

                {#if a.due_date}
                  <span class="anc {dueTone(a)} mono due">{a.due_date.slice(5)}</span>
                {/if}

                {#if a.notes.trim()}
                  <span class="ind legend-sm" title="Has notes" aria-label="Has notes">≡</span>
                {/if}

                {#if a.attach_count}
                  <span
                    class="ind clip legend-sm"
                    title={`${a.attach_count} attached`}
                    aria-label={`${a.attach_count} attached`}
                  >
                    <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
                      <path
                        d="M8.4 3.1 4.2 7.3a1.4 1.4 0 0 0 2 2l4.1-4.2a2.7 2.7 0 0 0-3.8-3.8L2.3 5.5a4 4 0 0 0 5.6 5.6"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.1"
                        stroke-linecap="round"
                      />
                    </svg>
                    {#if a.attach_count > 1}<span class="mono">{a.attach_count}</span>{/if}
                  </span>
                {/if}

                {#if a.note_id}
                  <span class="src legend legend-sm" title={`From ${a.note_title || 'Untitled'}`}>
                    {a.note_title || 'Untitled'}
                  </span>
                {/if}
              </div>
            </div>
          </div>
        {/each}

        <!-- The tail is a real drop target, so an empty column and the space
             under the last card both accept a card instead of doing nothing. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="tail"
          class:live={overTail === s.id && dragKind === 'card'}
          ondragover={(e) => {
            accept(e);
            if (dragKind !== 'card') return;
            e.stopPropagation();
            overStage = s.id;
            overTail = s.id;
            overId = null;
          }}
          ondrop={(e) => {
            if (dragKind !== 'card') return;
            e.stopPropagation();
            dropCard(s.id, null);
          }}
        >
          {#if cards.length === 0 && overTail !== s.id && composing !== s.id}
            <p class="empty legend legend-sm">Nothing here</p>
          {/if}
        </div>
      </div>

      <!-- Finished work stays in the column it was done in, folded away. The
           column keeps saying where the work happened; the checkbox says
           whether it is finished. Two questions, two places to read them. -->
      {#if done.length > 0}
        <div class="finished">
          <button
            class="disc legend legend-sm"
            aria-expanded={showDone[s.id] === true}
            onclick={() => (showDone[s.id] = !showDone[s.id])}
          >
            <svg
              class="chev"
              class:down={showDone[s.id] === true}
              viewBox="0 0 12 12"
              width="9"
              height="9"
              aria-hidden="true"
            >
              <path
                d="M4 2.5 8 6l-4 3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            Show completed
            <span class="mono n">{done.length}</span>
          </button>

          {#if showDone[s.id]}
            <div class="donelist scroll">
              {#each done as a (a.id)}
                {@const project = store.projectById(a.project_id)}
                <div
                  class="card done"
                  class:open={store.openCard === a.id}
                  role="button"
                  tabindex="0"
                  aria-label={`Open "${a.text}"`}
                  onclick={() => (store.openCard = a.id)}
                  onkeydown={(e) => onCardKey(e, a)}
                >
                  <span class="edge" style:background={project?.color ?? 'transparent'}></span>
                  <button
                    class="tick on"
                    role="checkbox"
                    aria-checked="true"
                    aria-label="Put this back"
                    title="Put this back — it is not finished"
                    onclick={(e) => {
                      e.stopPropagation();
                      store.toggleAction(a.id, false);
                    }}
                  >
                    <svg viewBox="0 0 14 14" width="10" height="10" aria-hidden="true">
                      <path
                        d="M2.6 7.3 5.6 10.2 11.4 4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.9"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </button>
                  <div class="body">
                    <p class="text strike">{a.text}</p>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </section>
  {/each}

  <!-- Add a column where a new column would go: at the end of the board. -->
  <div class="addcol">
    {#if addingCol}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="newcol"
        type="text"
        autofocus
        placeholder="Column name"
        aria-label="New column name"
        bind:value={newCol}
        onblur={() => (newCol.trim() ? addColumn() : (addingCol = false))}
        onkeydown={(e) => {
          if (e.key === 'Enter') addColumn();
          if (e.key === 'Escape') ((newCol = ''), (addingCol = false));
        }}
      />
    {:else}
      <button
        class="sw newbtn"
        onclick={(e) => {
          e.stopPropagation();
          addingCol = true;
        }}>+ Add column</button
      >
    {/if}
  </div>

  {#if stages.length === 0}
    <p class="none legend">Every column is hidden. Add one, or unhide one in Settings.</p>
  {/if}
</div>

<style>
  .board {
    display: flex;
    align-items: stretch;
    gap: 1px;
    min-height: 0;
    background: var(--hairline-soft);
    overflow-x: auto;
    overflow-y: hidden;
  }

  /* Columns are planes on the panel, separated by the same hairline everything
     else is. The cards sit on them like paper on a desk. */
  .col {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    /* Columns share the width when they fit and hold a floor when they do not.
       `flex-shrink: 0` here cost three pixels to the gaps and put a scrollbar
       under a board that fitted. */
    flex: 1 1 232px;
    max-width: 320px;
    min-width: 188px;
    background: var(--panel-0);
    transition: background var(--dur-fast) var(--ease);
  }

  .col.target {
    background: var(--panel-1);
  }

  .col.col-target {
    box-shadow: inset 2px 0 0 0 var(--anc-amber);
  }

  .col-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 3px 0 10px;
    border-bottom: 1px solid var(--hairline);
    background: var(--panel-1);
    /* Otherwise a press-and-move over the title starts a text selection and the
       drag never begins. No grab cursor: the pointer stays the pointer. */
    user-select: none;
  }

  .col-head .name {
    color: var(--ink-soft);
    font-size: 11px;
    letter-spacing: 0.1em;
    max-width: 54%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: text;
  }

  .col-head .n {
    color: var(--legend-dim);
    font-size: 10px;
  }

  .col-head .plus {
    margin-left: auto;
  }

  .plus,
  .more {
    width: 20px;
    height: 20px;
    line-height: 1;
  }

  .rename {
    width: 100%;
    height: 21px;
    font-size: 11px;
    background: var(--panel-2);
  }

  .menu {
    position: absolute;
    top: 28px;
    right: 4px;
    z-index: 40;
    display: grid;
    min-width: 168px;
    padding: 3px;
    background: var(--panel-2);
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.34);
  }

  .menu hr {
    height: 1px;
    background: var(--hairline);
    border: 0;
    margin: 3px 0;
  }

  .mi {
    text-align: left;
    background: none;
    border: 0;
    padding: 5px 8px;
    color: var(--ink-soft);
    font-size: 11.5px;
    border-radius: var(--r);
    cursor: default;
    transition: background var(--dur-blip) var(--ease);
  }

  .mi:hover:not(:disabled) {
    background: var(--panel-3);
    color: var(--ink);
  }

  .mi:disabled {
    color: var(--legend-dim);
  }

  .mi.danger:hover:not(:disabled),
  .mi.danger.live {
    background: var(--anc-red);
    color: var(--panel-0);
  }

  .cards {
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    align-content: start;
  }

  .compose {
    width: 100%;
    height: 26px;
    font-size: 12px;
    background: var(--panel-2);
    border-color: var(--legend-dim);
  }

  /* A card is a piece of paper on the column, not a region of it. The shadow is
     small and low — enough to lift it off the plane, never enough to become the
     thing you look at. */
  .card {
    position: relative;
    display: grid;
    grid-template-columns: 3px 16px minmax(0, 1fr);
    gap: 6px;
    align-items: start;
    background: var(--panel-2);
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    box-shadow:
      inset 0 1px 0 0 var(--bezel),
      0 1px 2px rgba(0, 0, 0, 0.28),
      0 2px 5px rgba(0, 0, 0, 0.16);
    padding: 6px 8px 6px 0;
    text-align: left;
    cursor: default;
    transition:
      background var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease),
      opacity var(--dur-fast) var(--ease),
      transform var(--dur-fast) var(--ease);
  }

  /* Late. Derived from the date every render and never written down, so
     fixing the date un-reddens the card with no second write to forget.
     The border and the date chip carry it; the ground is only tinted enough to
     be findable while scanning a full column, because a solid red card is a
     card whose text you cannot read. */
  .card.overdue {
    background: var(--anc-red-bg);
    border-color: var(--anc-red);
  }

  .card.overdue:hover {
    background: color-mix(in srgb, var(--anc-red-bg) 70%, var(--panel-3));
  }

  .card.overdue .text {
    color: var(--ink);
  }

  /* Completion is what clears it, so a finished card never argues with the
     column it is folded into. */
  .card.done.overdue {
    background: transparent;
    border-color: var(--hairline);
  }

  :root[data-theme='day'] .card {
    box-shadow:
      inset 0 1px 0 0 var(--bezel),
      0 1px 2px rgba(0, 0, 0, 0.14),
      0 2px 6px rgba(0, 0, 0, 0.09);
  }

  /* Picking up: the paper rises a hair. Transform and shadow only. */
  .card:hover {
    background: var(--panel-3);
    transform: translateY(-1px);
    box-shadow:
      inset 0 1px 0 0 var(--bezel),
      0 2px 4px rgba(0, 0, 0, 0.3),
      0 5px 12px rgba(0, 0, 0, 0.2);
  }

  .card:focus-visible {
    outline: 1px solid var(--anc-amber);
    outline-offset: -1px;
  }

  /* The card the detail panel is showing keeps a mark, so the panel is never
     describing a row the eye cannot find. */
  .card.open {
    background: var(--panel-3);
    border-color: var(--legend-dim);
  }

  /* The card being carried dims and settles back onto the plane: the drop
     target is what should read as live, not the thing under the cursor. */
  .card.lifted {
    opacity: 0.4;
    transform: none;
    box-shadow: inset 0 1px 0 0 var(--bezel);
  }

  /* Where it would land. A hairline, not a gap — nothing reflows mid-drag. */
  .card.before {
    box-shadow:
      inset 0 3px 0 0 var(--anc-amber),
      inset 0 1px 0 0 var(--bezel),
      0 1px 2px rgba(0, 0, 0, 0.28);
  }

  /* Same thumb-tab edge the sidebar uses, carrying the project's colour. One
     edge mechanism in the whole app. */
  .edge {
    border-radius: 0 1px 1px 0;
    align-self: stretch;
  }

  .tick {
    display: grid;
    place-items: center;
    width: 15px;
    height: 15px;
    margin-top: 1px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--hairline);
    border-radius: 50%;
    color: transparent;
    cursor: default;
    transition:
      background var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }

  .card:hover .tick,
  .tick:focus-visible {
    border-color: var(--legend);
    color: var(--legend);
  }

  .tick.on,
  .card:hover .tick.on {
    background: var(--anc-green);
    border-color: var(--anc-green);
    color: var(--panel-0);
  }

  .body {
    display: grid;
    gap: 5px;
    min-width: 0;
  }

  .text {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .meta:empty {
    display: none;
  }

  .chip {
    padding: 0 4px;
    height: 15px;
    line-height: 14px;
    border: 1px solid var(--hairline);
    border-left-width: 2px;
    border-radius: var(--r);
    color: var(--legend);
    font-size: 9.5px;
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .due {
    font-size: 10px;
  }

  .ind {
    color: var(--legend-dim);
    font-size: 11px;
    line-height: 1;
  }

  .clip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: 9.5px;
  }

  .src {
    color: var(--legend-dim);
    font-size: 9.5px;
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tail {
    flex: 1 1 auto;
    min-height: 26px;
    border-radius: var(--r);
    transition: box-shadow var(--dur-blip) var(--ease);
  }

  .tail.live {
    box-shadow: inset 0 3px 0 0 var(--anc-amber);
  }

  .empty {
    padding: 10px 4px;
    color: var(--legend-dim);
  }

  .finished {
    border-top: 1px solid var(--hairline);
    background: var(--panel-0);
  }

  .disc {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 7px 10px;
    background: none;
    border: 0;
    color: var(--legend);
    font-size: 10px;
    cursor: default;
    transition: color var(--dur-fast) var(--ease);
  }

  .disc:hover {
    color: var(--ink-soft);
  }

  .chev {
    transition: transform var(--dur-fast) var(--ease);
  }

  .chev.down {
    transform: rotate(90deg);
  }

  .disc .n {
    margin-left: auto;
    color: var(--legend-dim);
  }

  .donelist {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 232px;
    padding: 0 6px 6px;
  }

  /* Finished paper lies flat: no lift, no shadow, muted ink. It is still here,
     it is just no longer in the way. */
  .card.done {
    grid-template-columns: 3px 16px minmax(0, 1fr);
    background: var(--panel-1);
    box-shadow: none;
    opacity: 0.72;
  }

  .card.done:hover {
    background: var(--panel-2);
    opacity: 1;
    transform: none;
    box-shadow: none;
  }

  .card.done .text {
    font-size: 12px;
    color: var(--legend);
  }

  .addcol {
    flex: 0 0 156px;
    padding: 6px;
    background: var(--panel-0);
  }

  .newbtn,
  .newcol {
    width: 100%;
    height: 26px;
    font-size: 11px;
  }

  .newbtn {
    color: var(--legend);
    border-style: dashed;
  }

  .none {
    padding: 24px;
    color: var(--legend-dim);
  }
</style>
