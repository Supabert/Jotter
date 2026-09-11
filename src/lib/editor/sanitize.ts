import DOMPurify from 'dompurify';

/**
 * Pasting from a browser drops arbitrary markup straight into a WebView, so
 * everything that enters or leaves the editor passes through here. The list is
 * an allowlist by construction: a tag, attribute, class or CSS property that is
 * not named below does not survive, whatever it claims to be.
 */
const ALLOWED_TAGS = [
  'p', 'br', 'div', 'span',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'mark',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3',
  'blockquote', 'pre', 'code', 'hr',
  'img', 'a'
];

const ALLOWED_ATTR = [
  'style',
  'class',
  'data-action-id',
  'data-jt-img',
  'data-jt-file',
  'width',
  'href'
];

/** Presentation only. Nothing here can position, layer, or load a resource. */
const ALLOWED_STYLE = new Set([
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'font-style',
  'font-family',
  'text-decoration',
  'text-decoration-line',
  'text-align'
]);

const ALLOWED_CLASS = new Set(['jt-action', 'jt-done', 'jt-file']);

let hooked = false;

// Set right before each `sanitize()` call below and read from inside the
// hook, since DOMPurify's hook is installed once and re-runs on every call —
// there is nowhere else for that call's option to live.
let keepFileChips = false;

function install() {
  if (hooked) return;
  hooked = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!el.getAttribute) return;

    if (el.hasAttribute('style')) {
      const kept: string[] = [];
      for (const decl of el.getAttribute('style')!.split(';')) {
        const idx = decl.indexOf(':');
        if (idx < 0) continue;
        const prop = decl.slice(0, idx).trim().toLowerCase();
        const value = decl.slice(idx + 1).trim();
        // url() is the one construct that can still reach outward from inside
        // an otherwise harmless property such as background-color.
        if (ALLOWED_STYLE.has(prop) && value && !/url\s*\(/i.test(value)) {
          kept.push(`${prop}: ${value}`);
        }
      }
      if (kept.length) el.setAttribute('style', kept.join('; '));
      else el.removeAttribute('style');
    }

    if (el.hasAttribute('class')) {
      const kept = el
        .getAttribute('class')!
        .split(/\s+/)
        .filter((c) => ALLOWED_CLASS.has(c));
      if (kept.length) el.setAttribute('class', kept.join(' '));
      else el.removeAttribute('class');
    }

    // An image is only ever a reference into Jotter's own content-addressed
    // store. A pasted src — remote, data:, or file: — is dropped, and the image
    // is re-imported through the Rust side instead.
    if (el.tagName === 'IMG') {
      el.removeAttribute('src');
      const ref = el.getAttribute('data-jt-img') ?? '';
      if (!/^[0-9a-f]{64}\.(png|jpg|gif|bmp|webp)$/.test(ref)) {
        el.remove();
        return;
      }
    }

    if (el.tagName === 'A') {
      // A file chip is a place the user pointed at, not a URL. It never gets an
      // href: the path is handed to the Rust side on click, which checks that
      // the file is still there and refuses to launch an executable. Chips are
      // only ever minted by `fileChip()`, from the app's own clipboard-file
      // read, so markup arriving from anywhere else — a paste, a dropped
      // selection, HTML pulled back out of the DOM by something other than a
      // save — has no business carrying one. `keepFileChips` is how a caller
      // says "this is our own content, not someone else's markup"; without it
      // every `a.jt-file` is unwrapped to plain text, path or no path, so
      // nothing outside the app can forge one.
      if (el.classList.contains('jt-file')) {
        if (!keepFileChips) {
          el.replaceWith(...el.childNodes);
          return;
        }
        el.removeAttribute('href');
        const path = el.getAttribute('data-jt-file') ?? '';
        if (!path.trim()) {
          el.replaceWith(...el.childNodes);
        }
        return;
      }
      el.removeAttribute('data-jt-file');
      const href = el.getAttribute('href') ?? '';
      if (!/^https?:\/\//i.test(href)) el.removeAttribute('href');
      else el.setAttribute('rel', 'noreferrer noopener');
    }
  });
}

/**
 * `keepFileChips` must be true only for markup the app already trusts — a
 * note's own `body_html` coming back out of the database, or the editor's own
 * DOM being serialized for a save. Anything that can carry someone else's
 * markup — a clipboard paste, a dropped selection — leaves it at the default
 * `false`, or a chip's `data-jt-file` becomes a way to point the app at an
 * arbitrary path with nothing more than pasted HTML.
 */
export function sanitizeHtml(html: string, opts: { keepFileChips?: boolean } = {}): string {
  install();
  keepFileChips = opts.keepFileChips ?? false;
  try {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      // A Windows path starts with a drive letter and a colon, which DOMPurify
      // reads as a URI scheme it does not know — so `C:/notes/plan.pptx` gets
      // dropped as if it were `javascript:`. Naming the attribute URI-safe skips
      // that check for it, which is sound because the value never becomes a URL:
      // it is handed to the Rust side, which checks the file is there and refuses
      // to launch an executable.
      ADD_URI_SAFE_ATTR: ['data-jt-file'],
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'link', 'meta'],
      KEEP_CONTENT: true
    });
  } finally {
    keepFileChips = false;
  }
}

/** Plaintext mirror written on every save so FTS never has to parse HTML. */
export function htmlToText(html: string): string {
  const el = document.createElement('div');
  el.innerHTML = sanitizeHtml(html);
  el.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  el.querySelectorAll('p, div, li, h1, h2, h3, blockquote, pre').forEach((b) => {
    b.append('\n');
  });
  return (el.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The first non-empty line becomes the note's title. Notepad never asked for a
 * filename either — the note names itself from what was typed.
 */
export function deriveTitle(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.trim().slice(0, 120);
}
