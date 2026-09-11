/**
 * Rich-text operations over a contenteditable.
 *
 * `execCommand` is formally deprecated and still the only formatting API every
 * Chromium ships with working undo integration. A real editor engine
 * (ProseMirror, TipTap) would cost 200 KB+ and a document model this app has no
 * use for. The deprecation risk is accepted deliberately: WebView2 is Chromium,
 * and the surface used here is the part nothing has ever removed.
 */

const FONT_SIZES = [11, 12, 13, 14, 16, 18, 21, 24, 28, 34, 42];

export function exec(command: string, value?: string): void {
  document.execCommand(command, false, value);
}

/** CSS-based formatting rather than <font> tags, so output stays sanitizable. */
export function initFormatting(): void {
  document.execCommand('styleWithCSS', false, 'true');
  document.execCommand('defaultParagraphSeparator', false, 'p');
}

export function queryState(command: string): boolean {
  try {
    return document.queryCommandState(command);
  } catch {
    return false;
  }
}

/**
 * `execCommand('fontSize')` only understands the legacy 1-7 scale. Applying the
 * unused 7 and rewriting the resulting <font> elements is the standard way to
 * reach an arbitrary px size while keeping the operation inside the browser's
 * own undo stack.
 */
export function setFontSize(root: HTMLElement, px: number): void {
  document.execCommand('fontSize', false, '7');
  root.querySelectorAll('font[size="7"]').forEach((el) => {
    const span = document.createElement('span');
    span.style.fontSize = `${px}px`;
    while (el.firstChild) span.appendChild(el.firstChild);
    el.replaceWith(span);
  });
  // styleWithCSS makes Chromium emit its own span with a keyword size; rewrite
  // those too or the toolbar and the document disagree about the current size.
  root.querySelectorAll<HTMLElement>('span[style*="font-size"]').forEach((el) => {
    if (/xxx-large|x-large|larger|smaller/.test(el.style.fontSize)) {
      el.style.fontSize = `${px}px`;
    }
  });
}

export function currentFontSize(): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 14;
  let node: Node | null = sel.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!(node instanceof HTMLElement)) return 14;
  return Math.round(parseFloat(getComputedStyle(node).fontSize)) || 14;
}

export function stepFontSize(root: HTMLElement, direction: 1 | -1): number {
  const current = currentFontSize();
  let idx = FONT_SIZES.findIndex((s) => s >= current);
  if (idx < 0) idx = FONT_SIZES.length - 1;
  const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, idx + direction))];
  setFontSize(root, next);
  return next;
}

export { FONT_SIZES };

export function setColor(hex: string): void {
  document.execCommand('foreColor', false, hex);
}

export function setHighlight(hex: string | null): void {
  document.execCommand('hiliteColor', false, hex ?? 'transparent');
}

export function clearFormatting(): void {
  document.execCommand('removeFormat');
}

export function insertImageRef(file: string, src: string): void {
  const img = document.createElement('img');
  img.setAttribute('data-jt-img', file);
  img.src = src;
  insertNode(img);
}

/** Insert at the caret and leave the caret after the inserted node. */
export function insertNode(node: Node): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

export interface WrappedAction {
  anchorId: string;
  text: string;
}

/**
 * The Ctrl+Shift+A move. The selected text is wrapped in place rather than
 * copied out, so the note keeps reading as the sentence the user wrote while
 * the Actions page gains a row anchored to that exact span.
 *
 * Returns null when the selection is empty, collapsed, or already inside an
 * action — an action is never nested inside another.
 */
export function wrapSelectionAsAction(root: HTMLElement): WrappedAction | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (!text) return null;

  let probe: Node | null = range.commonAncestorContainer;
  while (probe && probe !== root) {
    if (probe instanceof HTMLElement && probe.classList.contains('jt-action')) return null;
    probe = probe.parentNode;
  }

  const anchorId = crypto.randomUUID();
  const span = document.createElement('span');
  span.className = 'jt-action';
  span.setAttribute('data-action-id', anchorId);

  try {
    span.appendChild(range.extractContents());
    range.insertNode(span);
  } catch {
    // A selection spanning block boundaries cannot be surrounded in one node;
    // fall back to wrapping the plain text, which is what the action needs.
    span.textContent = text;
    range.deleteContents();
    range.insertNode(span);
  }

  sel.removeAllRanges();
  const after = document.createRange();
  after.setStartAfter(span);
  after.collapse(true);
  sel.addRange(after);

  return { anchorId, text };
}

/** Paint completion onto the note without ever rewriting its stored HTML. */
export function applyDoneAnchors(root: HTMLElement, doneIds: Set<string>): void {
  root.querySelectorAll<HTMLElement>('.jt-action').forEach((el) => {
    const id = el.getAttribute('data-action-id');
    el.classList.toggle('jt-done', !!id && doneIds.has(id));
  });
}
