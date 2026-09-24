<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { api, resolveImageSrc } from '../api';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { store } from '../store.svelte';
  import { sanitizeHtml, htmlToText, deriveTitle } from '../editor/sanitize';
  import {
    applyDoneAnchors,
    clearFormatting,
    exec,
    initFormatting,
    insertImageRef,
    queryState,
    setColor,
    setFontSize,
    setHighlight,
    stepFontSize,
    currentFontSize,
    wrapSelectionAsAction
  } from '../editor/commands';
  import FormatRail from './FormatRail.svelte';

  let { noteId }: { noteId: number } = $props();

  let page = $state<HTMLDivElement | null>(null);
  let loaded = $state(false);
  let dirty = false;
  let saveTimer: number | undefined;

  let marks = $state<Record<string, boolean>>({});
  let size = $state(14);

  let findOpen = $state(false);
  let findText = $state('');
  let findInput = $state<HTMLInputElement | null>(null);

  const note = $derived(store.notes.find((n) => n.id === noteId));

  // --- load ----------------------------------------------------------------

  onMount(async () => {
    initFormatting();
    const n = await api.getNote(noteId);
    if (!page) return;

    page.innerHTML = sanitizeHtml(n.body_html, { keepFileChips: true });
    await hydrateImages();
    await paintDoneAnchors();

    loaded = true;
    recount();
    store.stats.savedAt = n.updated_at;

    await tick();
    if (!n.body_html) page.focus();
    await maybeReveal();
  });

  onDestroy(() => {
    clearTimeout(saveTimer);
    // A tab closing, a note switching, or the window parking to tray all land
    // here; none of them may leave the last keystroke unwritten.
    void flush();
  });

  $effect(() => {
    if (store.revealAnchor?.noteId === noteId) void maybeReveal();
  });

  async function maybeReveal() {
    const target = store.revealAnchor;
    if (!target || target.noteId !== noteId || !page) return;
    store.revealAnchor = null;
    await tick();
    const el = page.querySelector<HTMLElement>(`[data-action-id="${CSS.escape(target.anchorId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('jt-flash');
    setTimeout(() => el.classList.remove('jt-flash'), 1200);
  }

  /**
   * Stored HTML carries only a file name; the asset URL is attached here at
   * render time and stripped again on save, so nothing absolute is ever
   * written into a note.
   */
  async function hydrateImages() {
    if (!page) return;
    const imgs = [...page.querySelectorAll<HTMLImageElement>('img[data-jt-img]')];
    await Promise.all(
      imgs.map(async (img) => {
        const file = img.getAttribute('data-jt-img')!;
        try {
          img.src = await resolveImageSrc(file);
        } catch {
          img.replaceWith(Object.assign(document.createElement('span'), {
            className: 'jt-missing',
            textContent: '[image missing]'
          }));
        }
      })
    );
  }

  async function paintDoneAnchors() {
    if (!page) return;
    const done = await api.doneAnchors(noteId);
    applyDoneAnchors(page, new Set(done));
  }

  // Repaint completion when the Actions page changes something in this note.
  $effect(() => {
    void store.actions.length;
    void store.actions.filter((a) => a.done).length;
    if (loaded) void paintDoneAnchors();
  });

  // --- save ----------------------------------------------------------------

  function markDirty() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flush(), 400) as unknown as number;
  }

  /** Snapshot the document without the render-time src attributes. */
  function serialize(): { html: string; text: string } {
    if (!page) return { html: '', text: '' };
    const clone = page.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('img[data-jt-img]').forEach((img) => img.removeAttribute('src'));
    clone.querySelectorAll('.jt-action').forEach((el) => {
      el.classList.remove('jt-done', 'jt-flash');
      if (!el.getAttribute('class')) el.removeAttribute('class');
    });
    const html = sanitizeHtml(clone.innerHTML, { keepFileChips: true });
    return { html, text: htmlToText(html) };
  }

  export async function flush(): Promise<void> {
    if (!dirty || !loaded) return;
    dirty = false;
    const { html, text } = serialize();
    const savedAt = await api.saveNote(noteId, deriveTitle(text), html, text);
    store.stats.savedAt = savedAt;
    await store.refreshNotes();
  }

  function recount() {
    const text = page?.innerText ?? '';
    store.stats.chars = text.length;
    store.stats.words = text.trim() ? text.trim().split(/\s+/).length : 0;
  }

  function onInput() {
    markDirty();
    recount();
    syncMarks();
  }

  function syncMarks() {
    marks = {
      bold: queryState('bold'),
      italic: queryState('italic'),
      underline: queryState('underline'),
      strike: queryState('strikeThrough'),
      ul: queryState('insertUnorderedList'),
      ol: queryState('insertOrderedList')
    };
    size = currentFontSize();
  }

  // --- paste and drop ------------------------------------------------------

  async function importImage(file: File) {
    const bytes = [...new Uint8Array(await file.arrayBuffer())];
    try {
      const saved = await api.saveImage(bytes);
      const src = await resolveImageSrc(saved.file);
      insertImageRef(saved.file, src);
      markDirty();
      recount();
    } catch (e) {
      store.flash(String(e), 'red');
    }
  }

  /** A file copied in Explorer is on the clipboard as a path, so a note can
      point at it where the cursor is. The file itself is not touched. */
  function fileChip(path: string): string {
    const name = path.split(/[\\/]/).pop() || path;
    const esc = (t: string) =>
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return `<a class="jt-file" data-jt-file="${esc(path)}">${esc(name)}</a>&nbsp;`;
  }

  async function pasteFilePaths(): Promise<boolean> {
    const paths = await api.clipboardFilePaths().catch(() => [] as string[]);
    if (!paths.length) return false;
    exec('insertHTML', paths.map(fileChip).join(''));
    markDirty();
    recount();
    return true;
  }

  /** Click a chip and the file opens where it lives. The path never becomes an
      href, so nothing here can navigate the webview. A real link in a note
      gets the same treatment: this window is a notes app, not a browser, so a
      plain click never goes anywhere — only Ctrl+click on an http(s) link
      hands it to the system browser instead. Bound to both click and
      auxclick, so a middle click cannot navigate here either. */
  async function onPageClick(e: MouseEvent) {
    const el = e.target as HTMLElement | null;

    // Click an image to see it full size in its own window.
    const img = el?.closest('img[data-jt-img]')?.getAttribute('data-jt-img');
    if (img && e.button === 0) {
      try {
        await api.openImageViewer(img);
      } catch (err) {
        store.flash(String(err), 'amber');
      }
      return;
    }

    const chip = el?.closest('a.jt-file');
    if (chip) {
      const path = chip.getAttribute('data-jt-file');
      if (!path) return;
      e.preventDefault();
      try {
        await api.openLinkedPath(path);
      } catch (err) {
        store.flash(String(err), 'amber');
      }
      return;
    }

    const link = el?.closest('a[href]');
    if (!link) return;
    e.preventDefault();
    if (!e.ctrlKey) return;
    const href = link.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href)) return;
    try {
      await openUrl(href);
    } catch (err) {
      store.flash(String(err), 'amber');
    }
  }

  async function onPaste(e: ClipboardEvent) {
    const dt = e.clipboardData;
    if (!dt) return;

    if (await pasteFilePaths()) {
      e.preventDefault();
      return;
    }

    // Excel and Word put a picture of the selection on the clipboard beside
    // the table itself. The table is the thing that was copied.
    const html = dt.getData('text/html');
    const image = [...dt.items].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (image && !/<table[\s>]/i.test(html)) {
      e.preventDefault();
      const file = image.getAsFile();
      if (file) await importImage(file);
      return;
    }

    // Pasted markup is re-inserted only after the allowlist has been through
    // it. The clipboard's own HTML never reaches the document intact.
    if (html) {
      e.preventDefault();
      exec('insertHTML', sanitizeHtml(html));
      markDirty();
      recount();
    }
  }

  // --- image resize --------------------------------------------------------

  /** The image under the pointer, and where its corner grip sits in the sheet. */
  let sheet = $state<HTMLDivElement | null>(null);
  let gripImg = $state<HTMLImageElement | null>(null);
  let grip = $state({ x: 0, y: 0 });
  let dragging = false;

  function placeGrip(img: HTMLImageElement) {
    if (!sheet) return;
    const r = img.getBoundingClientRect();
    const s = sheet.getBoundingClientRect();
    grip = { x: r.right - s.left + sheet.scrollLeft, y: r.bottom - s.top + sheet.scrollTop };
    gripImg = img;
  }

  function onSheetMove(e: MouseEvent) {
    if (dragging) return;
    const el = e.target as HTMLElement;
    if (el.classList.contains('img-grip')) return;
    const img = el.closest<HTMLImageElement>('img[data-jt-img]');
    if (img) placeGrip(img);
    else gripImg = null;
  }

  /** Drag the corner to set the width; height follows the aspect ratio. The
      width is stored on the image itself, so the note keeps it. */
  function onGripDown(e: PointerEvent) {
    const img = gripImg;
    if (!img || !page) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    dragging = true;
    const startX = e.clientX;
    const startW = img.getBoundingClientRect().width;
    const cs = getComputedStyle(page);
    const maxW = page.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);

    const move = (ev: PointerEvent) => {
      const w = Math.round(Math.min(maxW, Math.max(48, startW + ev.clientX - startX)));
      img.setAttribute('width', String(w));
      placeGrip(img);
    };
    const up = () => {
      dragging = false;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      markDirty();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  /** A drag that began on this page — moving a sentence around — is left to
      the browser's own handling; only a drop carrying markup from outside has
      to go through the allowlist first. */
  let dragStartedHere = false;

  function onDragStart() {
    dragStartedHere = true;
  }

  async function onDrop(e: DragEvent) {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      for (const f of files) await importImage(f);
      dragStartedHere = false;
      return;
    }

    if (dragStartedHere) {
      dragStartedHere = false;
      return;
    }

    // A selection dragged in from outside the app — a browser tab, an email —
    // carries raw markup the same way a paste does, and it has not been near
    // the allowlist yet: the browser would otherwise drop it into the page
    // natively and unsanitized.
    const html = e.dataTransfer?.getData('text/html');
    if (!html) return;
    e.preventDefault();

    const range = document.caretRangeFromPoint(e.clientX, e.clientY);
    page?.focus();
    if (range) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    exec('insertHTML', sanitizeHtml(html));
    markDirty();
    recount();
  }

  // --- commands ------------------------------------------------------------

  export function focus() {
    page?.focus();
  }

  export function openFind() {
    findOpen = true;
    tick().then(() => findInput?.select());
  }

  function findNext(backwards = false) {
    if (!findText) return;
    // window.find keeps the search entirely outside the document, so nothing in
    // the note is mutated to draw a highlight.
    const w = window as unknown as {
      find?: (s: string, cs: boolean, back: boolean, wrap: boolean) => boolean;
    };
    w.find?.(findText, false, backwards, true);
  }

  export async function runCommand(id: string, value?: string) {
    if (!page) return;
    switch (id) {
      case 'fmt.bold': exec('bold'); break;
      case 'fmt.italic': exec('italic'); break;
      case 'fmt.underline': exec('underline'); break;
      case 'fmt.strike': exec('strikeThrough'); break;
      case 'fmt.ul': exec('insertUnorderedList'); break;
      case 'fmt.ol': exec('insertOrderedList'); break;
      case 'fmt.left': exec('justifyLeft'); break;
      case 'fmt.center': exec('justifyCenter'); break;
      case 'fmt.clear': clearFormatting(); break;
      case 'fmt.bigger': size = stepFontSize(page, 1); break;
      case 'fmt.smaller': size = stepFontSize(page, -1); break;
      case 'fmt.size': setFontSize(page, Number(value)); size = Number(value); break;
      case 'fmt.ink': setColor(value || 'var(--ink)'); break;
      case 'fmt.marker': setHighlight(value || null); break;
      case 'action.make': await makeAction(); return;
      case 'note.pin': await store.setPinned(noteId, !note?.pinned); return;
      case 'note.complete': await store.setArchived(noteId, !note?.archived); return;
      case 'note.label': await store.setLabel(noteId, value ? Number(value) : null); return;
      default: return;
    }
    markDirty();
    syncMarks();
  }

  /**
   * Ctrl+Shift+A. The selection is wrapped in place and a row is created that
   * points back at it — the note keeps reading as what was written, and the
   * checklist gains an entry that knows where it came from.
   */
  async function makeAction() {
    if (!page) return;
    const wrapped = wrapSelectionAsAction(page);
    if (!wrapped) {
      store.flash('Select some text first', 'amber');
      return;
    }
    markDirty();
    await flush();
    await api.createAction(wrapped.text, noteId, wrapped.anchorId, null);
    await Promise.all([store.refreshActions(), store.refreshNotes()]);
    store.blip++;
  }
</script>

<div class="wrap">
  <FormatRail
    {marks}
    {size}
    labelId={note?.label_id ?? null}
    pinned={note?.pinned ?? false}
    archived={note?.archived ?? false}
    cmd={(id, v) => runCommand(id, v)}
  />

  {#if findOpen}
    <div class="find">
      <span class="legend legend-sm">Find</span>
      <input
        bind:this={findInput}
        bind:value={findText}
        type="search"
        placeholder="in this note"
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            findNext(e.shiftKey);
          }
          if (e.key === 'Escape') {
            findOpen = false;
            page?.focus();
          }
        }}
      />
      <button class="sw" onclick={() => findNext(true)}>Prev</button>
      <button class="sw" onclick={() => findNext()}>Next</button>
      <button class="sw sw-icon" aria-label="Close find" onclick={() => (findOpen = false)}>✕</button>
    </div>
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sheet scroll" bind:this={sheet} onmousemove={onSheetMove} onmouseleave={() => !dragging && (gripImg = null)}>
    <!-- The page: a lit plane inset behind a hairline margin rule, which is the
         printed checklist inside the panel. -->
    <div
      bind:this={page}
      class="page"
      class:stowed={note?.archived}
      contenteditable="true"
      role="textbox"
      tabindex="0"
      aria-multiline="true"
      aria-label="Note body"
      spellcheck="true"
      oninput={onInput}
      onpaste={onPaste}
      ondrop={onDrop}
      ondragover={(e) => e.preventDefault()}
      ondragstart={onDragStart}
      ondragend={() => (dragStartedHere = false)}
      onclick={onPageClick}
      onauxclick={onPageClick}
      onblur={() => void flush()}
      onkeyup={syncMarks}
      onmouseup={syncMarks}
    ></div>
    {#if gripImg}
      <div
        class="img-grip"
        style="left: {grip.x}px; top: {grip.y}px"
        role="separator"
        aria-label="Drag to resize image"
        onpointerdown={onGripDown}
      ></div>
    {/if}
  </div>
</div>

<style>
  /* Column flex, not a three-row grid: the find bar is conditional, so with it
     closed the rail and the sheet fell into the two `auto` tracks and the
     `1fr` track sat empty below them — the sheet stopped at the height of its
     text and the panel showed through underneath. Flex has no fixed track to
     land in the wrong one. */
  .wrap {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--panel-0);
  }

  .find {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    background: var(--panel-1);
    border-bottom: 1px solid var(--hairline);
  }

  .find input {
    flex: 1 1 auto;
    max-width: 320px;
  }

  /* Flex, not grid: `min-height: 100%` on a grid item resolves against the
     item's own size and constrains nothing, so the page stopped at the height
     of its text instead of filling the panel. In a flex row with a definite
     height it resolves against the container, which is what it has to do for
     the sheet to read as a plane rather than a card. */
  .sheet {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    justify-content: center;
    align-items: stretch;
    position: relative;
  }

  .page {
    flex: 0 1 820px;
    min-height: 100%;
    height: max-content;
    padding: 26px 34px 40px;
    background: var(--panel-2);
    border-left: 1px solid var(--hairline);
    border-right: 1px solid var(--hairline);
    color: var(--ink);
    font-size: 14px;
    line-height: 1.62;
    outline: none;
  }

  .page.stowed {
    opacity: 0.62;
  }

  .page:empty::before {
    content: 'Start typing';
    color: var(--legend-dim);
    pointer-events: none;
  }

  /* Note content styling lives here rather than in a global sheet so the
     editor owns exactly what it renders. */
  .page :global(p) {
    margin: 0 0 0.62em;
  }

  .page :global(h1) {
    font-family: var(--font-legend);
    font-variation-settings: var(--wdth-legend);
    font-size: 21px;
    letter-spacing: 0.02em;
    margin: 0.2em 0 0.4em;
  }

  .page :global(h2) {
    font-size: 17px;
    margin: 0.9em 0 0.35em;
  }

  .page :global(h3) {
    font-size: 15px;
    margin: 0.9em 0 0.3em;
    color: var(--ink-soft);
  }

  .page :global(ul),
  .page :global(ol) {
    margin: 0 0 0.62em;
    padding-left: 1.5em;
  }

  .page :global(li) {
    margin: 0.1em 0;
  }

  .page :global(blockquote) {
    margin: 0.6em 0;
    padding-left: 12px;
    border-left: 2px solid var(--hairline);
    color: var(--ink-soft);
  }

  .page :global(pre),
  .page :global(code) {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--panel-0);
  }

  .page :global(pre) {
    padding: 9px 11px;
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    overflow-x: auto;
  }

  /* Natural size up to the page width; the corner grip sets a width of its
     own, stored on the image. A click opens it full size in its own window. */
  .page :global(img) {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 10px 0;
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    cursor: zoom-in;
  }

  .img-grip {
    position: absolute;
    width: 12px;
    height: 12px;
    margin: -8px 0 0 -8px;
    background: var(--ink);
    border: 2px solid var(--panel-2);
    border-radius: 2px;
    cursor: nwse-resize;
    touch-action: none;
    z-index: 2;
  }

  .page :global(table) {
    border-collapse: collapse;
    margin: 10px 0;
    max-width: 100%;
  }

  .page :global(th),
  .page :global(td) {
    border: 1px solid var(--hairline);
    padding: 4px 8px;
    vertical-align: top;
    text-align: left;
  }

  .page :global(th) {
    background: var(--panel-1);
    font-weight: 600;
  }

  /* A file the note points at. Reads as an object in the prose rather than as
     a link, because it does not go anywhere on the web — it opens a file. */
  .page :global(a.jt-file) {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    padding: 1px 5px;
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    background: var(--panel-2);
    color: var(--ink);
    font-size: 0.92em;
    text-decoration: none;
    cursor: pointer;
  }

  .page :global(a.jt-file)::before {
    content: '';
    width: 7px;
    height: 7px;
    border: 1px solid currentColor;
    border-radius: 2px;
    opacity: 0.5;
  }

  .page :global(a.jt-file:hover) {
    border-color: var(--legend-dim);
    background: var(--panel-3);
  }

  .page :global(.jt-missing) {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--anc-red);
  }

  /* An actioned sentence keeps its place in the prose and gains a caution
     rule beneath it — the checklist mark, not a highlight. */
  .page :global(.jt-action) {
    box-shadow: inset 0 -2px 0 0 var(--anc-amber);
  }

  .page :global(.jt-done) {
    box-shadow: inset 0 -2px 0 0 var(--anc-green);
    text-decoration: line-through;
    text-decoration-thickness: 1px;
    color: var(--legend);
  }

  .page :global(.jt-flash) {
    animation: flash 1.2s var(--ease);
  }

  @keyframes flash {
    0%,
    100% {
      background: transparent;
    }
    18% {
      background: var(--anc-amber-bg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .page :global(.jt-flash) {
      animation: none;
      background: var(--anc-amber-bg);
    }
  }
</style>
