<script lang="ts">
  import { store } from '../store.svelte';

  let { run }: { run: (id: string) => void } = $props();

  const isNote = $derived(store.active?.kind === 'note');

  const savedLabel = $derived.by(() => {
    if (!store.stats.savedAt) return 'Ready';
    const d = new Date(store.stats.savedAt);
    return `Saved ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
</script>

<footer class="strip">
  <!-- There is no unsaved state to report, so this lamp is green whenever a
       note is open. That is the honest reading, not reassurance. -->
  <span class="anc {isNote ? 'anc-green' : 'anc-off'} legend cell">{isNote ? savedLabel : 'Ready'}</span>

  {#if isNote}
    <span class="mono cell dim">{store.stats.words} w</span>
    <span class="mono cell dim">{store.stats.chars} ch</span>
  {/if}

  <span class="spacer"></span>

  <button class="cell tap" onclick={() => store.openActions()} title="Open Actions · Ctrl+0">
    <span
      class="anc {store.overdueCount > 0
        ? 'anc-red'
        : store.openActionCount > 0
          ? 'anc-amber'
          : 'anc-green'} legend"
    >
      {store.openActionCount} open{store.overdueCount > 0 ? ` · ${store.overdueCount} overdue` : ''}
    </span>
  </button>

  <button
    class="cell tap legend"
    aria-pressed={store.showArchived}
    onclick={() => run('view.archived')}
    title="Show or hide archived · Ctrl+Shift+E"
  >
    Archived {store.showArchived ? 'shown' : 'hidden'}
  </button>

  <button class="cell tap legend" onclick={() => run('view.theme')} title="Switch day / night">
    {store.lighting === 'day' ? 'Day' : 'Night'}
  </button>

  <button
    class="cell tap legend"
    aria-pressed={store.focusMode}
    onclick={() => run('view.focus')}
    title="Focus mode · F11"
  >
    Focus {store.focusMode ? 'on' : 'off'}
  </button>

  <button class="cell tap legend" onclick={() => run('settings')} title="Settings · Ctrl+,">
    Settings
  </button>
</footer>

<style>
  .strip {
    display: flex;
    align-items: stretch;
    height: var(--strip);
    background: var(--panel-1);
    border-top: 1px solid var(--hairline);
    box-shadow: inset 0 1px 0 0 var(--bezel);
  }

  .cell {
    display: inline-flex;
    align-items: center;
    padding: 0 10px;
    border-right: 1px solid var(--hairline);
    font-size: 10px;
    letter-spacing: 0.07em;
    white-space: nowrap;
  }

  .cell.dim {
    color: var(--legend-dim);
    font-size: 10.5px;
  }

  .spacer {
    flex: 1 1 auto;
    border-right: 1px solid var(--hairline);
  }

  .tap {
    background: none;
    border: 0;
    border-left: 1px solid var(--hairline);
    border-right: 0;
    color: var(--legend);
    font-family: var(--font-legend);
    font-variation-settings: var(--wdth-legend);
    text-transform: uppercase;
    font-weight: 600;
    cursor: default;
    transition: background var(--dur-fast) var(--ease);
  }

  .tap:hover {
    background: var(--panel-3);
    color: var(--ink-soft);
  }

  .tap[aria-pressed='true'] {
    color: var(--anc-amber);
  }

  .tap .anc {
    font-size: 10px;
    color: var(--lamp);
  }
</style>
