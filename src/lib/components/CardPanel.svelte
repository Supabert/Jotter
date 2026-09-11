<script lang="ts">
  import { convertFileSrc } from '@tauri-apps/api/core';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { store } from '../store.svelte';

  /* Mounted keyed on the open card, so these locals are this card's draft and
     nothing has to be re-synced when the board moves the row underneath. */
  const a = $derived(store.openAction);

  let text = $state(store.openAction?.text ?? '');
  let notes = $state(store.openAction?.notes ?? '');
  let armed = $state(false);
  let armTimer: number | undefined;

  const stageId = $derived(a ? store.stageOf(a) : null);

  /* A start after its own deadline is almost always a typo, and it is the one
     thing that would draw a backwards bar on the chart these dates are for. Say
     so; never refuse the input. */
  const backwards = $derived(!!a?.start_date && !!a?.due_date && a.start_date! > a.due_date!);

  $effect(() => {
    store.loadAttachments(a?.id ?? null);
  });

  function sizeOf(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
  }

  function extOf(name: string): string {
    const dot = name.lastIndexOf('.');
    const raw = dot > 0 ? name.slice(dot + 1) : '';
    return (raw || 'file').slice(0, 4).toUpperCase();
  }

  async function pickFiles() {
    if (!a) return;
    const picked = await openDialog({ multiple: true, title: 'Link a file to this action' });
    if (!picked) return;
    await store.linkPaths(a.id, Array.isArray(picked) ? picked : [picked]);
  }

  /** Ctrl+V with a card open.
   *
   * A file copied in Explorer arrives as a *path* on the Windows clipboard, so
   * it is linked and the file stays where it is. A screenshot arrives as pixels
   * with no place to point at, so those bytes are kept. Text still pastes as
   * text and never reaches this.
   */
  async function onPaste(e: ClipboardEvent) {
    if (!a) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest('.page')) return; // the note editor keeps its own paste

    if (await store.pasteAsLink(a.id)) {
      e.preventDefault();
      return;
    }

    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      const bytes = [...new Uint8Array(await f.arrayBuffer())];
      const name = f.name || `pasted-image.${(f.type.split('/')[1] || 'png').slice(0, 8)}`;
      await store.attachBytes(a.id, name, bytes);
    }
  }

  function close() {
    store.openCard = null;
  }

  async function saveText() {
    if (!a || text.trim() === a.text || !text.trim()) {
      text = a?.text ?? '';
      return;
    }
    await store.setActionText(a.id, text.trim());
  }

  async function saveNotes() {
    if (!a || notes === a.notes) return;
    await store.setActionNotes(a.id, notes);
  }

  /** Moving from the panel is the same write as dropping the card: it lands at
      the end of the column it is sent to. */
  async function moveTo(id: number) {
    if (!a) return;
    const order = store.columnOrder(id).filter((x) => x !== a.id);
    order.push(a.id);
    await store.moveAction(a.id, id, order);
  }

  function arm() {
    armed = true;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => (armed = false), 5000) as unknown as number;
  }

  async function onDelete() {
    if (!a) return;
    if (!armed) {
      arm();
      return;
    }
    clearTimeout(armTimer);
    await store.deleteAction(a.id);
  }

  function stamp(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
</script>

<svelte:window
  onpaste={onPaste}
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }}
  onpointerdown={(e) => {
    /* Click anywhere that is not this panel and not another card, and the panel
       goes away. Cards are excluded because pointerdown lands before click:
       closing first and letting the card's own click reopen is what makes
       clicking straight from one card to the next work. */
    const el = e.target as HTMLElement | null;
    if (el?.closest('.panel') || el?.closest('.card')) return;
    close();
  }}
/>

{#if a}
  <aside class="panel" aria-label="Action detail">
    <header class="head">
      <button
        class="tick"
        class:on={a.done}
        role="checkbox"
        aria-checked={a.done}
        aria-label={a.done ? 'Mark as not done' : 'Mark as done'}
        onclick={() => store.toggleAction(a.id, !a.done)}
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
      <span class="legend title">{a.done ? 'Completed' : 'Action'}</span>
      <button class="sw sw-icon x" aria-label="Close" onclick={close}>×</button>
    </header>

    <div class="fields scroll">
      <label class="f">
        <span class="legend legend-sm k">Action</span>
        <textarea
          class="t"
          rows="3"
          bind:value={text}
          onblur={saveText}
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        ></textarea>
      </label>

      <label class="f">
        <span class="legend legend-sm k">Column</span>
        <select
          value={stageId ?? ''}
          onchange={(e) => e.currentTarget.value !== '' && moveTo(Number(e.currentTarget.value))}
        >
          {#each store.visibleStages as s (s.id)}
            <option value={s.id}>{s.name}</option>
          {/each}
        </select>
      </label>

      <label class="f">
        <span class="legend legend-sm k">Project</span>
        <select
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
      </label>

      <div class="f">
        <span class="legend legend-sm k">Dates</span>
        <div class="dates">
          <div class="row">
            <span class="legend legend-sm w">Start</span>
            <input
              type="date"
              aria-label="Start date"
              value={a.start_date ?? ''}
              onchange={(e) =>
                store.setActionStart(
                  a.id,
                  e.currentTarget.value === '' ? null : e.currentTarget.value
                )}
            />
            <button
              class="sw sw-icon x2"
              aria-label="Clear start date"
              disabled={!a.start_date}
              onclick={() => store.setActionStart(a.id, null)}>×</button
            >
          </div>
          <div class="row">
            <span class="legend legend-sm w">Due</span>
            <input
              type="date"
              aria-label="Due date"
              value={a.due_date ?? ''}
              onchange={(e) =>
                store.setActionDue(
                  a.id,
                  e.currentTarget.value === '' ? null : e.currentTarget.value
                )}
            />
            <button
              class="sw sw-icon x2"
              aria-label="Clear due date"
              disabled={!a.due_date}
              onclick={() => store.setActionDue(a.id, null)}>×</button
            >
          </div>
          {#if backwards}
            <p class="warn legend legend-sm">Starts after it is due</p>
          {/if}
        </div>
      </div>

      <label class="f">
        <span class="legend legend-sm k">Notes</span>
        <textarea
          class="t notes"
          rows="7"
          placeholder="Anything the one line cannot hold"
          bind:value={notes}
          onblur={saveNotes}
        ></textarea>
      </label>

      <div class="f">
        <span class="legend legend-sm k">
          Files
          {#if store.attachments.length}<span class="mono n">{store.attachments.length}</span>{/if}
        </span>

        {#if store.attachments.length}
          <ul class="atts">
            {#each store.attachments as t (t.id)}
              <li
                class="att"
                class:img={t.kind === 'image' && !t.missing}
                class:gone={t.missing}
              >
                <button
                  class="body"
                  title={t.mode === 'linked'
                    ? `${t.src}${t.missing ? ' — not there any more' : ''}`
                    : `${t.name} · ${sizeOf(t.bytes)} · kept in Jotter`}
                  onclick={() => store.openAttachment(t.id)}
                >
                  {#if t.kind === 'image' && !t.missing}
                    <img src={convertFileSrc(t.src)} alt={t.name} />
                  {:else}
                    <span class="ext mono">{t.missing ? '!' : extOf(t.name)}</span>
                    <span class="nm">{t.name}</span>
                    <span class="sz mono">{t.missing ? 'moved' : sizeOf(t.bytes)}</span>
                  {/if}
                </button>
                {#if t.mode === 'linked' && !(t.kind === 'image' && !t.missing)}
                  <!-- A link is a different promise from a copy, and the strip
                       has to say which one this is without being asked. -->
                  <span class="linkmark" aria-hidden="true">
                    <svg viewBox="0 0 12 12" width="9" height="9">
                      <path
                        d="M4.9 7.1 7.1 4.9M5.2 3.1 6.4 1.9a2 2 0 0 1 2.8 2.8L8 5.9M6.8 8.9 5.6 10.1a2 2 0 0 1-2.8-2.8L4 6.1"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.1"
                        stroke-linecap="round"
                      />
                    </svg>
                  </span>
                {/if}
                <span class="acts">
                  <button
                    class="sw sw-icon"
                    aria-label="Show in folder"
                    title="Show in folder"
                    onclick={() => store.revealAttachment(t.id)}
                  >
                    <svg viewBox="0 0 14 14" width="10" height="10" aria-hidden="true">
                      <path
                        d="M1.4 3.4h4l1.2 1.4h6v6.2H1.4z"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.2"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </button>
                  <button
                    class="sw sw-icon"
                    aria-label={`Detach ${t.name}`}
                    title="Detach. The file itself stays on disk."
                    onclick={() => store.detach(t.id, a.id)}>×</button
                  >
                </span>
              </li>
            {/each}
          </ul>
        {/if}

        <div class="row">
          <button class="sw" disabled={store.attachBusy} onclick={pickFiles}>
            {store.attachBusy ? 'Linking…' : 'Link file'}
          </button>
          <span class="legend legend-sm hint">or paste — copy in Explorer first</span>
        </div>
      </div>

      {#if a.note_id}
        <div class="f">
          <span class="legend legend-sm k">From</span>
          <button class="sw src" onclick={() => store.reveal(a.note_id!, a.anchor_id)}>
            {a.note_title || 'Untitled'}
          </button>
        </div>
      {/if}

      <dl class="stamps">
        <dt class="legend legend-sm">Created</dt>
        <dd class="mono">{stamp(a.created_at)}</dd>
        <dt class="legend legend-sm">Completed</dt>
        <dd class="mono">{a.done_at ? stamp(a.done_at) : 'Not yet'}</dd>
      </dl>
    </div>

    <footer class="foot">
      <button
        class="sw del"
        class:live={armed}
        title="Permanent. Completing is the reversible one."
        onclick={onDelete}
      >
        {armed ? 'Click again to delete permanently' : 'Delete action'}
      </button>
    </footer>
  </aside>
{/if}

<style>
  /* A column of the board's own grid rather than a layer over it, so opening a
     card narrows the board instead of hiding part of it. */
  .panel {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    background: var(--panel-1);
    border-left: 1px solid var(--hairline);
    box-shadow: -14px 0 30px rgba(0, 0, 0, 0.28);
    animation: slide var(--dur-base) var(--ease);
  }

  @keyframes slide {
    from {
      opacity: 0;
      transform: translateX(14px);
    }
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 5px 0 10px;
    border-bottom: 1px solid var(--hairline);
    background: var(--panel-2);
  }

  .title {
    font-size: 10.5px;
    color: var(--legend);
  }

  .x {
    margin-left: auto;
    width: 22px;
    height: 22px;
    font-size: 14px;
    line-height: 1;
  }

  .tick {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--legend-dim);
    border-radius: 50%;
    color: transparent;
    cursor: default;
    transition:
      background var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }

  .tick:hover {
    border-color: var(--legend);
    color: var(--legend);
  }

  .tick.on {
    background: var(--anc-green);
    border-color: var(--anc-green);
    color: var(--panel-0);
  }

  .fields {
    padding: 12px 12px 18px;
    display: grid;
    gap: 12px;
    align-content: start;
  }

  .f {
    display: grid;
    gap: 4px;
  }

  .k {
    color: var(--legend-dim);
  }

  .t {
    width: 100%;
    resize: vertical;
    font-size: 12.5px;
    line-height: 1.45;
    padding: 6px 7px;
    background: var(--panel-2);
  }

  .notes {
    font-size: 12px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .row input {
    flex: 1 1 auto;
    min-width: 0;
  }

  .dates {
    display: grid;
    gap: 4px;
  }

  /* Both labels on one width, so the two date fields line up and read as the
     ends of one span rather than as two unrelated settings. */
  .w {
    width: 30px;
    color: var(--legend-dim);
  }

  .x2 {
    width: 20px;
    height: 20px;
    font-size: 13px;
    line-height: 1;
  }

  .x2:disabled {
    opacity: 0.25;
  }

  .warn {
    margin: 1px 0 0;
    color: var(--anc-amber);
  }

  .hint {
    color: var(--legend-dim);
  }

  .n {
    font-size: 10px;
    color: var(--legend-dim);
  }

  .atts {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 5px;
  }

  /* An attachment is one row: something to open on the left, and the two things
     you can do to it on the right, revealed on hover so the strip stays quiet. */
  .att {
    position: relative;
    display: grid;
  }

  .att .body {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 5px 6px;
    text-align: left;
    background: var(--panel-2);
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    color: inherit;
    font-size: 11.5px;
    transition:
      background var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease);
  }

  .att .body:hover {
    background: var(--panel-3);
    border-color: var(--legend-dim);
  }

  /* Capped hard: a pasted screenshot is a reminder of what the work is about,
     not the content of the panel. Full size is one click away. */
  .att.img .body {
    padding: 0;
    overflow: hidden;
  }

  .att.img img {
    display: block;
    width: 100%;
    max-height: 108px;
    object-fit: cover;
    object-position: top center;
  }

  .ext {
    flex: 0 0 auto;
    padding: 2px 4px;
    font-size: 9px;
    letter-spacing: 0.04em;
    color: var(--legend);
    background: var(--panel-0);
    border: 1px solid var(--hairline);
    border-radius: 3px;
  }

  .nm {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sz {
    flex: 0 0 auto;
    font-size: 9.5px;
    color: var(--legend-dim);
  }

  .acts {
    position: absolute;
    top: 3px;
    right: 3px;
    display: flex;
    gap: 3px;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }

  .att:hover .acts,
  .att:focus-within .acts {
    opacity: 1;
  }

  /* A linked file that is no longer there. The row stays: what broke is the
     link, and the name is the only clue left about what it pointed at. */
  .att.gone .body {
    border-color: var(--anc-red);
    color: var(--legend);
  }

  .att.gone .ext {
    color: var(--anc-red);
    border-color: var(--anc-red);
  }

  .linkmark {
    position: absolute;
    left: 4px;
    bottom: 3px;
    display: grid;
    place-items: center;
    color: var(--legend-dim);
    pointer-events: none;
  }

  .att:has(.linkmark) .ext {
    margin-left: 9px;
  }

  .acts .sw {
    width: 20px;
    height: 20px;
    padding: 0;
    font-size: 12px;
    line-height: 1;
    background: var(--panel-1);
  }

  .src {
    justify-self: start;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stamps {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 3px 10px;
    margin: 4px 0 0;
    padding-top: 10px;
    border-top: 1px solid var(--hairline);
  }

  .stamps dd {
    margin: 0;
    font-size: 10.5px;
    color: var(--legend);
  }

  .foot {
    padding: 8px 12px;
    border-top: 1px solid var(--hairline);
    background: var(--panel-2);
  }

  .del {
    width: 100%;
    color: var(--legend);
  }

  .del:hover:not(:disabled),
  .del.live {
    background: var(--anc-red);
    border-color: var(--anc-red);
    color: var(--panel-0);
  }
</style>
