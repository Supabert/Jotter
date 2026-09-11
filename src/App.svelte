<script lang="ts">
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { api } from './lib/api';
  import { store } from './lib/store.svelte';
  import { chord } from './lib/keys';
  import Sidebar from './lib/components/Sidebar.svelte';
  import Editor from './lib/components/Editor.svelte';
  import ActionsPage from './lib/components/ActionsPage.svelte';
  import SettingsPage from './lib/components/SettingsPage.svelte';
  import StatusStrip from './lib/components/StatusStrip.svelte';
  import Palette from './lib/components/Palette.svelte';
  import SearchPanel from './lib/components/SearchPanel.svelte';
  import Toast from './lib/components/Toast.svelte';

  let editor = $state<ReturnType<typeof Editor> | null>(null);
  let ready = $state(false);

  const active = $derived(store.active);

  onMount(() => {
    store.load().then(() => (ready = true));

    // Without this the red line and every overdue red would be frozen at
    // whatever the date was when Jotter last started.
    const stopClock = store.startClock();

    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onScheme = () => store.theme === 'system' && store.applyTheme();
    media.addEventListener('change', onScheme);

    // The window's close button parks to tray; Rust asks for a flush first so
    // the in-flight note is on disk before the webview stops running.
    const unlisten = listen('app:flush', () => editor?.flush());
    const unlistenCaptured = listen('capture:saved', async () => {
      await store.refreshNotes();
    });

    return () => {
      stopClock();
      media.removeEventListener('change', onScheme);
      unlisten.then((f) => f());
      unlistenCaptured.then((f) => f());
    };
  });

  async function run(id: string) {
    switch (id) {
      case 'note.new':
        await store.newNote();
        queueMicrotask(() => editor?.focus());
        break;
      case 'nav.back':
        store.back();
        break;
      case 'nav.next':
        store.cycle(1);
        break;
      case 'nav.prev':
        store.cycle(-1);
        break;
      case 'palette':
        store.overlay = 'palette';
        break;
      case 'switcher':
        store.overlay = 'palette';
        break;
      case 'search':
        store.overlay = 'search';
        break;
      case 'find':
        editor?.openFind();
        break;
      case 'actions.open':
        store.openActions();
        break;
      case 'actions.board':
        store.openActions();
        await store.setActionsView(store.actionsView === 'board' ? 'list' : 'board');
        break;
      // Toggles back to the list rather than cycling three ways: a key that
      // lands somewhere different depending on where you already were is a key
      // you have to look at the screen to use.
      case 'actions.timeline':
        store.openActions();
        await store.setActionsView(store.actionsView === 'timeline' ? 'list' : 'timeline');
        break;
      case 'settings':
        store.openSettings();
        break;
      case 'capture':
        await api.openCapture();
        break;
      case 'view.archived':
        await store.toggleArchived();
        break;
      case 'view.focus':
        store.focusMode = !store.focusMode;
        break;
      case 'view.theme':
        await store.setTheme(store.lighting === 'day' ? 'night' : 'day');
        break;
      case 'note.complete':
        if (active?.kind === 'note') {
          const n = store.notes.find((x) => x.id === active.id);
          await store.setArchived(active.id, !(n?.archived ?? false));
        }
        break;
      default:
        editor?.runCommand(id);
    }
  }

  function onKeydown(e: KeyboardEvent) {
    const c = chord(e);

    if (c === 'escape') {
      if (store.overlay !== 'none') {
        store.overlay = 'none';
        e.preventDefault();
      } else if (store.focusMode) {
        store.focusMode = false;
        e.preventDefault();
      }
      return;
    }

    // Ctrl+A is deliberately not in this table. It is select-all and nothing
    // else, in every context, forever.
    const map: Record<string, string> = {
      'ctrl+n': 'note.new',
      'ctrl+w': 'nav.back',
      'ctrl+tab': 'nav.next',
      'ctrl+shift+tab': 'nav.prev',
      'ctrl+k': 'palette',
      'ctrl+p': 'switcher',
      'ctrl+f': 'find',
      'ctrl+shift+f': 'search',
      'ctrl+0': 'actions.open',
      'ctrl+shift+b': 'actions.board',
      'ctrl+shift+g': 'actions.timeline',
      'ctrl+,': 'settings',
      'ctrl+shift+e': 'view.archived',
      f11: 'view.focus',
      'ctrl+enter': 'note.complete',
      'ctrl+shift+a': 'action.make',
      'ctrl+shift+x': 'fmt.strike',
      'ctrl+shift+8': 'fmt.ul',
      'ctrl+shift+7': 'fmt.ol',
      'ctrl+]': 'fmt.bigger',
      'ctrl+[': 'fmt.smaller',
      'ctrl+ ': 'fmt.clear'
    };

    const digit = /^ctrl\+([1-9])$/.exec(c);
    if (digit) {
      e.preventDefault();
      store.goto(Number(digit[1]));
      return;
    }

    const id = map[c];
    if (id) {
      e.preventDefault();
      void run(id);
    }
  }

  /**
   * WebView2's own context menu offers Back, Reload, Save as and Print, which
   * is a browser talking, not this app. It is suppressed everywhere except
   * inside the editor, where the native menu is genuinely the right one — it
   * carries cut, copy, paste and the spellchecker's suggestions.
   */
  function onContextMenu(e: MouseEvent) {
    const el = e.target as HTMLElement | null;
    if (!el?.closest('[contenteditable="true"], input, textarea')) e.preventDefault();
  }

  /** A file dropped anywhere but the editor would otherwise navigate the view. */
  function swallowDrop(e: DragEvent) {
    if (!(e.target as HTMLElement | null)?.closest('[contenteditable="true"]')) e.preventDefault();
  }
</script>

<svelte:window
  onkeydown={onKeydown}
  oncontextmenu={onContextMenu}
  ondragover={swallowDrop}
  ondrop={swallowDrop}
/>

<div class="app" class:focus={store.focusMode}>
  <Sidebar {run} />

  <main class="main">
    <div class="stage">
      {#if !ready}
        <div class="boot legend">Loading</div>
      {:else if active?.kind === 'note'}
        {#key active.id}
          <Editor bind:this={editor} noteId={active.id} />
        {/key}
      {:else if active?.kind === 'actions'}
        <ActionsPage />
      {:else if active?.kind === 'settings'}
        <SettingsPage />
      {:else}
        <div class="empty">
          <p class="legend">Nothing open</p>
          <button class="sw" onclick={() => run('note.new')}>New note · Ctrl+N</button>
        </div>
      {/if}
    </div>

    <StatusStrip {run} />
  </main>
</div>

{#if store.overlay === 'palette'}
  <Palette {run} />
{:else if store.overlay === 'search'}
  <SearchPanel />
{/if}

<Toast />

<style>
  /* The row is written out on purpose. Left implicit it is an `auto` row, and
     an auto row cannot shrink below a grid item's automatic minimum size — so
     a page taller than the window pushed the row past the window, and `body`
     clipped it with nothing left to scroll. Settings hit that the day it grew
     past 760px. `minmax(0, 1fr)` pins the row to the window instead. */
  .app {
    display: grid;
    grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    height: 100%;
    background: var(--panel-0);
  }

  /* Focus mode retracts the sidebar rather than hiding it with display:none,
     so the editor keeps its scroll position and the caret never jumps. */
  .app.focus {
    grid-template-columns: 0 minmax(0, 1fr);
  }

  /* And the other half of the same trap: this is a grid item with visible
     overflow, so without `min-height: 0` its minimum is its content. */
  .main {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--hairline);
  }

  .app.focus .main {
    border-left: 0;
  }

  .stage {
    min-height: 0;
    /* Grid items default to a content-based minimum. Left at `auto`, the
       widest descendant sets a floor for this whole column and the panes
       inside are pushed off the window instead of scrolling. */
    min-width: 0;
    display: grid;
    background: var(--panel-0);
  }

  .boot,
  .empty {
    display: flex;
    flex-direction: column;
    gap: 14px;
    align-items: center;
    justify-content: center;
  }

  .empty .sw {
    border-color: var(--hairline);
  }
</style>
