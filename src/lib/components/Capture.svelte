<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { emit, listen } from '@tauri-apps/api/event';
  import { api } from '../api';
  import { store } from '../store.svelte';

  const DRAFT_KEY = 'jotter.capture.draft';

  let text = $state('');
  let box = $state<HTMLTextAreaElement | null>(null);
  let saved = $state(false);
  const win = getCurrentWindow();

  onMount(() => {
    // Whatever survived a crash, a hide, or a reboot comes straight back. The
    // capture window's whole promise is that nothing typed into it is ever lost.
    text = localStorage.getItem(DRAFT_KEY) ?? '';
    void store.loadTheme();
    void focusBox();

    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onScheme = () => store.theme === 'system' && store.applyTheme();
    media.addEventListener('change', onScheme);

    const unFocus = listen('capture:focus', () => {
      void store.loadTheme();
      void focusBox();
    });
    const unFlush = listen('capture:flush', () => void file());

    return () => {
      media.removeEventListener('change', onScheme);
      unFocus.then((f) => f());
      unFlush.then((f) => f());
    };
  });

  async function focusBox() {
    await tick();
    box?.focus();
    box?.setSelectionRange(text.length, text.length);
  }

  function onInput() {
    localStorage.setItem(DRAFT_KEY, text);
    saved = false;
  }

  /** File the draft as a note and clear. An empty draft just dismisses. */
  async function file() {
    const body = text.trim();
    if (!body) {
      await dismiss();
      return;
    }
    const title = body.split('\n').find((l) => l.trim())?.trim().slice(0, 120) ?? '';
    const html = body
      .split('\n')
      .map((line) => `<p>${escapeHtml(line) || '<br>'}</p>`)
      .join('');

    await api.createNote(title, html, body, null);
    await emit('capture:saved', {});

    text = '';
    localStorage.removeItem(DRAFT_KEY);
    saved = true;
    setTimeout(() => void dismiss(), 220);
  }

  async function dismiss() {
    saved = false;
    await win.hide();
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      // Escape puts the window away without filing. It is not a discard: the
      // draft is written to storage on every keystroke and comes back on the
      // next summon, so the reflexive key costs nothing and does not litter
      // the sidebar with half-thoughts either.
      e.preventDefault();
      void dismiss();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void file();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="capture">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header class="bar" onmousedown={() => win.startDragging()}>
    <span class="legend mark">Jotter · capture</span>
    <span class="spacer"></span>
    <span class="anc {saved ? 'anc-green' : 'anc-amber'} legend legend-sm">
      {saved ? 'Filed' : 'Recording'}
    </span>
  </header>

  <textarea
    bind:this={box}
    bind:value={text}
    oninput={onInput}
    placeholder="Throw it in here"
    aria-label="Quick capture"
    spellcheck="false"
  ></textarea>

  <footer class="foot">
    <span class="legend legend-sm">Ctrl+Enter files it · Esc keeps the draft</span>
    <span class="spacer"></span>
    <button class="sw" onclick={file}>File it</button>
  </footer>
</div>

<style>
  .capture {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100vh;
    background: var(--panel-1);
    border: 1px solid var(--hairline);
    box-shadow: inset 0 1px 0 0 var(--bezel);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    padding: 0 9px;
    border-bottom: 1px solid var(--hairline);
    cursor: default;
    user-select: none;
  }

  .mark {
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--legend-dim);
  }

  .spacer {
    flex: 1;
  }

  textarea {
    background: var(--panel-2);
    border: 0;
    color: var(--ink);
    font-family: var(--font-body);
    font-size: 14px;
    line-height: 1.55;
    padding: 12px 14px;
    resize: none;
    outline: none;
  }

  textarea::placeholder {
    color: var(--legend-dim);
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 6px 0 10px;
    border-top: 1px solid var(--hairline);
  }
</style>
