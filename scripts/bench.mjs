// Performance bench against a RELEASE jotter.exe on its own throwaway database.
//
//   node scripts/bench.mjs <path-to-jotter.exe> [label]
//
// Measures cold start (spawn → main window rendered), main-thread cost of typing
// into a large note (CDP Performance.getMetrics delta, covers input handling,
// recount and the debounced autosave), and the round trip of saving a pasted
// screenshot. Data lives under Documents\Jotter\bench-* (inside the asset scope)
// and is deleted at the end. Never touches the real jotter.db.

import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const exe = process.argv[2];
const label = process.argv[3] ?? 'run';
if (!exe) throw new Error('usage: node scripts/bench.mjs <jotter.exe> [label]');

const PORT = 9341;
const dataDir = join(homedir(), 'Documents', 'Jotter', `bench-${process.pid}`);
const profile = join(tmpdir(), `jotter-bench-webview-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, seq = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

function launch() {
  return spawn(exe, [], {
    env: {
      ...process.env,
      JOTTER_DATA_DIR: dataDir,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`
    },
    stdio: 'ignore'
  });
}

/** Spawn → first moment the main window's `.app` root has painted sidebar rows. */
async function coldStart() {
  const t0 = performance.now();
  const child = launch();
  for (;;) {
    if (performance.now() - t0 > 30000) throw new Error('app never came up');
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && !t.url.includes('capture') && !t.url.includes('viewer'));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          const p = pending.get(m.id);
          if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
        };
        for (;;) {
          const up = await evaluate(`return !!document.querySelector('.app')`).catch(() => false);
          if (up) return { child, ms: performance.now() - t0 };
          await sleep(10);
        }
      }
    } catch { /* port not open yet */ }
    await sleep(20);
  }
}

async function stop(child) {
  try { ws?.close(); } catch {}
  const gone = new Promise((r) => child.once('exit', r));
  child.kill();
  await Promise.race([gone, sleep(5000)]);
  await sleep(1000); // WebView2 helper processes release the profile a beat later
}

const invoke = (cmd, args) =>
  `return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${args});`;

async function metric(name) {
  const { metrics } = await send('Performance.getMetrics');
  return metrics.find((m) => m.name === name)?.value ?? 0;
}

const out = { label };
try {
  mkdirSync(dataDir, { recursive: true });

  // Cold start: first launch creates the database, so measure launches 2–4.
  let r = await coldStart();
  await stop(r.child);
  const starts = [];
  for (let i = 0; i < 3; i++) {
    r = await coldStart();
    starts.push(Math.round(r.ms));
    if (i < 2) await stop(r.child);
  }
  out.coldStartMs = starts;

  // A ~2 MB note: 4000 paragraphs of mixed formatting.
  const para = '<p>Paragraph NUM — the quick <b>brown</b> fox jumps over the <i>lazy</i> dog, then files a report about it. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua; ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit.</p>';
  const id = await evaluate(`
    const p = ${JSON.stringify(para)};
    let html = ''; for (let i = 0; i < 4000; i++) html += p.replace('NUM', i);
    const text = html.replace(/<[^>]+>/g, '');
    return await window.__TAURI_INTERNALS__.invoke('create_note', { title: 'BENCH-BIG', bodyHtml: html, bodyText: text, labelId: null });
  `);
  out.bigNoteKB = Math.round((para.length * 4000) / 1024);
  await evaluate(`location.reload()`).catch(() => {});
  await sleep(2500);
  for (let i = 0; i < 50 && !(await evaluate(`return !!document.querySelector('.app')`).catch(() => false)); i++) await sleep(100);

  // Open it the way a user does: click its sidebar row.
  const tOpen = performance.now();
  await evaluate(`
    const row = [...document.querySelectorAll('button, [role=button], li, a')].find(e => e.textContent.includes('BENCH-BIG'));
    row.click();
    for (let i = 0; i < 200 && !document.querySelector('[contenteditable=true]')?.textContent.includes('Paragraph 3999'); i++)
      await new Promise(r => setTimeout(r, 10));
  `);
  out.openBigNoteMs = Math.round(performance.now() - tOpen);

  // Caret to the end of the document, then type 60 characters one at a time.
  await evaluate(`
    const page = document.querySelector('[contenteditable=true]');
    page.focus();
    const sel = getSelection(); sel.selectAllChildren(page); sel.collapseToEnd();
  `);
  await send('Performance.enable');
  await sleep(1500);
  const before = await metric('TaskDuration');
  const lat = [];
  for (const ch of 'typing into a big note to see how it holds up under load ok') {
    const t = performance.now();
    await send('Input.insertText', { text: ch });
    await evaluate(`await new Promise(r => requestAnimationFrame(() => setTimeout(r)))`);
    lat.push(performance.now() - t);
  }
  await sleep(1500); // let the 400 ms autosave fire and finish
  const after = await metric('TaskDuration');
  lat.sort((a, b) => a - b);
  out.typeP50Ms = +lat[Math.floor(lat.length / 2)].toFixed(1);
  out.typeP95Ms = +lat[Math.floor(lat.length * 0.95)].toFixed(1);
  out.mainThreadMsPerChar = +(((after - before) * 1000) / lat.length).toFixed(1);

  // Where a keystroke's time goes: the app's input handler alone, versus the
  // browser's own edit of the document.
  out.split = await evaluate(`
    const page = document.querySelector('[contenteditable=true]');
    const time = (f) => { const t = performance.now(); for (let i = 0; i < 10; i++) f(); return +((performance.now() - t) / 10).toFixed(1); };
    return {
      handlerMs: time(() => page.dispatchEvent(new InputEvent('input', { bubbles: true }))),
      keyupMs: time(() => page.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))),
      editMs: time(() => { document.execCommand('insertText', false, 'x'); page.offsetHeight; })
    };
  `);

  // Save timing: the same autosave command, 10 times, on the 2 MB body.
  out.saveNoteMs = await evaluate(`
    const n = await window.__TAURI_INTERNALS__.invoke('get_note', { id: ${id} });
    const t = performance.now();
    for (let i = 0; i < 10; i++)
      await window.__TAURI_INTERNALS__.invoke('save_note', { id: ${id}, title: 'BENCH-BIG', bodyHtml: (n.body_html ?? n.bodyHtml) + i, bodyText: n.body_html.replace(/<[^>]+>/g, '') });
    return +((performance.now() - t) / 10).toFixed(1);
  `);

  // A 2560x1440 "screenshot": UI-like flat colour blocks plus text, as PNG.
  out.image = await evaluate(`
    const c = new OffscreenCanvas(2560, 1440); const g = c.getContext('2d');
    g.fillStyle = '#f3f3f3'; g.fillRect(0, 0, 2560, 1440);
    for (let i = 0; i < 300; i++) { g.fillStyle = ['#fff','#e0e0e0','#2b6cb0','#333'][i % 4]; g.fillRect((i * 97) % 2400, (i * 53) % 1300, 160, 40); }
    g.fillStyle = '#111'; g.font = '16px Segoe UI';
    for (let y = 20; y < 1440; y += 22) g.fillText('Row ' + y + ' — the quick brown fox jumps over the lazy dog 0123456789', 40 + (y % 300), y);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const file = new File([blob], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(file);
    const page = document.querySelector('[contenteditable=true]');
    page.focus();
    const t = performance.now();
    page.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    for (let i = 0; i < 500 && !page.querySelector('img[data-jt-img][src]'); i++) await new Promise(r => setTimeout(r, 10));
    const pasteMs = Math.round(performance.now() - t);
    const img = page.querySelector('img[data-jt-img][src]');
    await img?.decode().catch(() => {});
    // Lossless check on the encoder the app uses: WebP at quality 1 must decode
    // back to exactly the pixels it was given.
    const a = g.getImageData(0, 0, 2560, 1440).data;
    const webp = await c.convertToBlob({ type: 'image/webp', quality: 1 });
    const d = new OffscreenCanvas(2560, 1440); const dg = d.getContext('2d');
    dg.drawImage(await createImageBitmap(webp, { colorSpaceConversion: 'none' }), 0, 0);
    const b = dg.getImageData(0, 0, 2560, 1440).data;
    const identical = a.length === b.length && a.every((v, i) => v === b[i]);
    return { pngBytes: blob.size, pasteMs, rendered: !!img?.naturalWidth, identical };
  `);
  const imgDir = join(dataDir, 'images');
  const files = readdirSync(imgDir);
  out.image.storedFiles = files.map((f) => `${f.split('.').pop()}:${statSync(join(imgDir, f)).size}`);

  await stop(r.child);
  // The WAL is folded back at the next open; measure it after a relaunch.
  r = await coldStart();
  await sleep(1000);
  await stop(r.child);
  const wal = join(dataDir, 'jotter.db-wal');
  out.walBytesAfterRelaunch = (() => { try { return statSync(wal).size; } catch { return 0; } })();
} catch (err) {
  out.error = String(err?.stack ?? err);
} finally {
  try { ws?.close(); } catch {}
  for (const dir of [dataDir, profile]) {
    for (let i = 0; i < 10; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(1000); }
    }
  }
}
console.log(JSON.stringify(out));
process.exit(0);
