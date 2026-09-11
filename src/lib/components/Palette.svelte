<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { excerptOf, store } from '../store.svelte';
  import { BINDINGS } from '../keys';

  let { run }: { run: (id: string) => void } = $props();

  let q = $state('');
  let cursor = $state(0);
  let input = $state<HTMLInputElement | null>(null);

  interface Row {
    key: string;
    kind: 'note' | 'command';
    label: string;
    hint: string;
    color?: string | null;
    go: () => void;
  }

  onMount(() => tick().then(() => input?.focus()));

  /** Subsequence match, the same rule an editor's go-to-file uses: every typed
      character must appear in order, so "acp" finds "Actions page". */
  function fuzzy(hay: string, needle: string): boolean {
    if (!needle) return true;
    const h = hay.toLowerCase();
    let i = 0;
    for (const ch of needle.toLowerCase()) {
      i = h.indexOf(ch, i);
      if (i < 0) return false;
      i++;
    }
    return true;
  }

  const rows = $derived.by((): Row[] => {
    const out: Row[] = [];

    for (const n of store.notes) {
      if (!store.showArchived && n.archived) continue;
      const title = n.title || 'Untitled';
      if (!fuzzy(`${title} ${n.excerpt}`, q)) continue;
      out.push({
        key: `n${n.id}`,
        kind: 'note',
        label: title,
        hint: n.archived ? 'Stowed' : excerptOf(n).slice(0, 60),
        color: store.labelById(n.label_id)?.color ?? null,
        go: () => store.openNote(n.id)
      });
    }

    for (const b of BINDINGS) {
      if (b.editorOnly && store.active?.kind !== 'note') continue;
      if (!fuzzy(`${b.label} ${b.group}`, q)) continue;
      out.push({
        key: `c${b.id}`,
        kind: 'command',
        label: b.label,
        hint: b.keys,
        go: () => run(b.id)
      });
    }

    return out.slice(0, 60);
  });

  $effect(() => {
    void rows.length;
    cursor = 0;
  });

  function choose(r: Row | undefined) {
    if (!r) return;
    store.overlay = 'none';
    r.go();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cursor = Math.min(rows.length - 1, cursor + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = Math.max(0, cursor - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[cursor]);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="scrim" onclick={() => (store.overlay = 'none')}>
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="panel plate" onclick={(e) => e.stopPropagation()}>
    <div class="field">
      <span class="legend legend-sm cue">Go</span>
      <input
        bind:this={input}
        bind:value={q}
        onkeydown={onKey}
        type="text"
        placeholder="Jump to a note, or run a command"
        aria-label="Command palette"
      />
    </div>

    <div class="rows scroll">
      {#each rows as r, i (r.key)}
        <button class="row" class:on={i === cursor} onmouseenter={() => (cursor = i)} onclick={() => choose(r)}>
          <span class="edge" style:background={r.color ?? 'transparent'}></span>
          <span class="label">{r.label}</span>
          <span class="hint {r.kind === 'command' ? 'mono' : ''}">{r.hint}</span>
        </button>
      {/each}

      {#if rows.length === 0}
        <p class="none legend legend-sm">Nothing matches</p>
      {/if}
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.42);
    display: grid;
    justify-items: center;
    align-content: start;
    padding-top: 13vh;
    z-index: 50;
  }

  .panel {
    width: min(620px, 88vw);
    background: var(--panel-1);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    max-height: 62vh;
    overflow: hidden;
    animation: drop var(--dur-base) var(--ease);
  }

  @keyframes drop {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
  }

  .field {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 9px;
    padding: 0 11px;
    height: 40px;
    border-bottom: 1px solid var(--hairline);
  }

  .cue {
    color: var(--anc-amber);
  }

  .field input {
    background: transparent;
    border: 0;
    height: 38px;
    font-size: 14px;
  }

  .field input:focus {
    outline: none;
  }

  .rows {
    padding: 3px 0 5px;
  }

  .row {
    display: grid;
    grid-template-columns: 3px minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    width: 100%;
    height: 28px;
    padding: 0 11px 0 0;
    background: none;
    border: 0;
    text-align: left;
    cursor: default;
    color: var(--ink-soft);
  }

  .row.on {
    background: var(--panel-2);
    color: var(--ink);
  }

  .edge {
    height: 100%;
  }

  .label {
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* A percentage max-width inside an `auto` grid track is circular, and the
     browser resolves it by collapsing the track — which turned every shortcut
     into "C…". The shortcut is the whole reason the column exists, so it sizes
     to its content and the label ellipsizes instead. Note excerpts, which are
     expendable, keep an absolute cap. */
  .hint {
    font-size: 10.5px;
    color: var(--legend-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hint:not(.mono) {
    max-width: 264px;
  }

  .none {
    padding: 22px;
    text-align: center;
    color: var(--legend-dim);
  }

  @media (prefers-reduced-motion: reduce) {
    .panel {
      animation: none;
    }
  }
</style>
