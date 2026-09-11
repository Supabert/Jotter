<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { api, type SearchHit } from '../api';
  import { store } from '../store.svelte';

  let q = $state('');
  let hits = $state<SearchHit[]>([]);
  let cursor = $state(0);
  let input = $state<HTMLInputElement | null>(null);
  let timer: number | undefined;

  onMount(() => tick().then(() => input?.focus()));

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      hits = q.trim() ? await api.searchNotes(q) : [];
      cursor = 0;
    }, 120) as unknown as number;
  }

  function open(h: SearchHit | undefined) {
    if (!h) return;
    store.overlay = 'none';
    store.openNote(h.id);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cursor = Math.min(hits.length - 1, cursor + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = Math.max(0, cursor - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open(hits[cursor]);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="scrim" onclick={() => (store.overlay = 'none')}>
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="panel plate" onclick={(e) => e.stopPropagation()}>
    <div class="field">
      <span class="legend legend-sm cue">Find</span>
      <input
        bind:this={input}
        bind:value={q}
        oninput={schedule}
        onkeydown={onKey}
        type="search"
        placeholder="Search every note"
        aria-label="Search every note"
      />
      <span class="mono n">{hits.length}</span>
    </div>

    <div class="rows scroll">
      {#each hits as h, i (h.id)}
        {@const label = store.labelById(h.label_id)}
        <button class="row" class:on={i === cursor} onmouseenter={() => (cursor = i)} onclick={() => open(h)}>
          <span class="edge" style:background={label?.color ?? 'transparent'}></span>
          <span class="body">
            <span class="title" class:strike={h.archived}>{h.title || 'Untitled'}</span>
            <!-- snippet() output is a note's own text, HTML-escaped in Rust
                 before the sentinels snippet() wraps a hit in are swapped for
                 real <mark> tags — see notes.rs::snippet_to_html. -->
            <span class="snip">{@html h.snippet}</span>
          </span>
        </button>
      {/each}

      {#if q.trim() && hits.length === 0}
        <p class="none legend legend-sm">No note contains that</p>
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
    padding-top: 11vh;
    z-index: 50;
  }

  .panel {
    width: min(660px, 90vw);
    background: var(--panel-1);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    max-height: 70vh;
    overflow: hidden;
  }

  .field {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
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

  .n {
    color: var(--legend-dim);
  }

  .row {
    display: grid;
    grid-template-columns: 3px minmax(0, 1fr);
    gap: 10px;
    width: 100%;
    padding: 7px 12px 8px 0;
    background: none;
    border: 0;
    border-bottom: 1px solid var(--hairline-soft);
    text-align: left;
    cursor: default;
    color: var(--ink-soft);
  }

  .row.on {
    background: var(--panel-2);
  }

  .edge {
    align-self: stretch;
  }

  .body {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .title {
    font-size: 13px;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .snip {
    font-size: 11.5px;
    color: var(--legend);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .snip :global(mark) {
    background: var(--anc-amber-bg);
    color: var(--anc-amber);
    padding: 0 1px;
  }

  .none {
    padding: 22px;
    text-align: center;
    color: var(--legend-dim);
  }
</style>
