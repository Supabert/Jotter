// Drives the running app into each state worth reviewing and captures the real
// window for each one. Run against a demo JOTTER_DATA_DIR, never the live data.
//
//   node scripts/shots.mjs <out-dir>

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const OUT = resolve(process.argv[2] ?? '.');
const PORT = Number(process.env.JOTTER_CDP_PORT ?? 9333);

let ws, appSocketUrl, seq = 0;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function onMessage(ev) {
  const m = JSON.parse(ev.data);
  const p = pending.get(m.id);
  if (p) {
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
}

/**
 * Both windows are the same bundle on the same dev URL with the same title, so
 * nothing in `/json/list` tells them apart — the capture window stays a live
 * target after it is hidden, and picking the first match aimed every shot at
 * it. Ask each candidate what it rendered instead: only the main window has a
 * shell.
 */
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pages = list.filter(
        (t) => t.type === 'page' && t.url.startsWith('http') && !t.url.includes('devtools')
      );

      for (const page of pages) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, bad) => ((socket.onopen = ok), (socket.onerror = bad)));
        socket.onmessage = onMessage;

        const probe = await send(
          'Runtime.evaluate',
          { expression: `!!document.querySelector('.app')`, returnByValue: true },
          socket
        );

        if (probe.result?.value) {
          appSocketUrl = page.webSocketDebuggerUrl;
          ws = socket;
          return;
        }
        socket.close();
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('no CDP page with the app shell');
}

function send(method, params = {}, socket = ws) {
  const id = ++seq;
  return new Promise((resolve_, reject) => {
    pending.set(id, { resolve: resolve_, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw');
  return r.result.value;
}

/**
 * CDP renders the page itself, so what lands on disk is what the DOM says.
 * Going through PrintWindow meant going through the Windows compositor, and
 * WebView2 serves unchanged regions of that surface from cached tiles: it
 * returned a light editor beside a still-dark sidebar after a theme flip, and
 * later returned frames two states behind the one that had been set up.
 */
async function capture(name, socket = ws) {
  const out = join(OUT, `${name}.png`);
  const r = await send('Page.captureScreenshot', { format: 'png' }, socket);
  writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log(`  ${name}: ${out}`);
}

const run = async () => {
  mkdirSync(OUT, { recursive: true });

  // Linked files have to exist on disk for the panel to show them as live, and
  // one of them has to stop existing for the broken state to be real.
  const linkDir = join(tmpdir(), 'jotter-shot-links');
  mkdirSync(linkDir, { recursive: true });
  const deck = join(linkDir, 'kickoff deck.pptx');
  const spec = join(linkDir, 'rollout spec.md');
  const strayed = join(linkDir, 'moved to the NAS.xlsx');
  writeFileSync(deck, 'PK');
  writeFileSync(spec, '# rollout');
  writeFileSync(strayed, 'x');
  const q = (p) => p.replace(/\\/g, '/');
  await connect();
  await evaluate(`for (let i = 0; i < 60 && !window.__jotter; i++) await new Promise(r => setTimeout(r, 100));`);
  // The bridge appears before the first load() resolves, so waiting only for
  // it hands the setup steps an empty note list.
  await evaluate(
    `for (let i = 0; i < 80 && !window.__jotter.store.notes.length; i++) await new Promise(r => setTimeout(r, 100));`
  );

  const states = [
    {
      name: '01-editor-night',
      setup: `
        const { store } = window.__jotter;
        await store.setTheme('night');
        if (store.showArchived) await store.toggleArchived();
        store.groupBy = 'label';
        const n = store.notes.find(x => x.title.startsWith('Jotter —'));
        store.history = [];
        store.openActions();
        store.openNote(n.id);
      `
    },
    {
      name: '02-actions',
      setup: `window.__jotter.store.openActions();`
    },
    {
      name: '03-palette',
      setup: `window.__jotter.store.overlay = 'palette';`
    },
    {
      name: '04-search',
      setup: `
        const { store } = window.__jotter;
        store.overlay = 'search';
        await new Promise(r => setTimeout(r, 260));
        const box = document.querySelector('input[aria-label="Search every note"]');
        if (box) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(box, 'action');
          box.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await new Promise(r => setTimeout(r, 500));
      `
    },
    {
      name: '05-settings',
      setup: `
        const { store } = window.__jotter;
        store.overlay = 'none';
        store.openSettings();
      `
    },
    {
      name: '06-editor-day',
      setup: `
        const { store } = window.__jotter;
        await store.setTheme('day');
        const n = store.notes.find(x => x.title.startsWith('Workstation'));
        store.openNote(n.id);
      `
    },
    {
      name: '07-actions-day',
      setup: `window.__jotter.store.openActions();`
    },
    {
      name: '08-archived-shown',
      setup: `
        const { store } = window.__jotter;
        await store.setTheme('night');
        if (!store.showArchived) await store.toggleArchived();
        store.groupBy = 'none';
        const n = store.notes.find(x => x.title.startsWith('Old shipping'));
        store.openNote(n.id);
      `
    },
    {
      name: '15-settings-columns',
      setup: `
        const { store } = window.__jotter;
        await store.setTheme('night');
        store.openSettings();
        await new Promise(r => setTimeout(r, 200));
        const head = [...document.querySelectorAll('h2')].find(h => h.textContent.trim() === 'Board columns');
        head?.scrollIntoView({ block: 'start' });
        await new Promise(r => setTimeout(r, 200));
      `
    },
    {
      name: '22-timeline-night',
      setup: `
        const { store } = window.__jotter;
        await store.setTheme('night');
        store.boardProject = null;
        store.openCard = null;
        await store.setActionsView('timeline');
        store.openActions();
        await store.setTimelineZoom('day');
        await store.setTimelineRange(14, 90);
        await new Promise(r => setTimeout(r, 260));
        document.querySelector('.tl .body')?.dispatchEvent(new Event('scroll'));
        await new Promise(r => setTimeout(r, 200));
      `
    },
    {
      name: '23-timeline-panel',
      setup: `
        const bar = document.querySelector('.lane .mark');
        if (bar) bar.click();
        await new Promise(r => setTimeout(r, 300));
      `
    },
    {
      name: '24-timeline-week',
      setup: `
        const { store } = window.__jotter;
        store.openCard = null;
        await store.setTimelineZoom('week');
        await store.setTimelineRange(90, 365);
        await new Promise(r => setTimeout(r, 300));
      `
    },
    {
      name: '25-timeline-collapsed',
      setup: `
        const { store } = window.__jotter;
        await store.setTimelineZoom('day');
        await store.setTimelineRange(14, 90);
        await new Promise(r => setTimeout(r, 200));
        const g = document.querySelector('.grouplbl .twist');
        if (g) g.click();
        await new Promise(r => setTimeout(r, 300));
      `
    },
    {
      name: '26-timeline-day',
      setup: `
        const { store } = window.__jotter;
        await store.setTheme('day');
        const g = document.querySelector('.grouplbl .twist');
        if (g) g.click();
        await new Promise(r => setTimeout(r, 300));
      `
    },
    {
      name: '12-board-night',
      setup: `
        const { store, api } = window.__jotter;
        await store.setTheme('night');
        store.boardProject = null;
        store.openCard = null;
        await store.setBoardSort('manual');
        await store.setActionsView('board');
        store.openActions();
        await new Promise(r => setTimeout(r, 200));
        // One finished card, so the disclosure this board is built around is
        // actually in the picture.
        const col = store.visibleStages[0];
        const open = store.cardsIn(col.id);
        if (store.completedIn(col.id).length === 0 && open.length > 1) {
          await store.toggleAction(open[open.length - 1].id, true);
        }
        await new Promise(r => setTimeout(r, 240));
      `
    },
    {
      name: '19-completed-open',
      setup: `
        const d = document.querySelector('.disc');
        if (d) d.click();
        await new Promise(r => setTimeout(r, 260));
      `
    },
    {
      name: '16-card-panel-night',
      setup: `
        const { store, api } = window.__jotter;
        const first = document.querySelector('.card');
        if (first) first.click();
        await new Promise(r => setTimeout(r, 320));

        // Give the open card the things the panel is now built around: a span
        // rather than a deadline, and material attached to it. The image is
        // drawn here rather than shipped, so the shot needs no fixture files.
        const id = store.openCard;
        if (id && store.attachments.length === 0) {
          await store.setActionStart(id, '2026-09-01');
          await store.setActionDue(id, '2026-09-12');

          const c = document.createElement('canvas');
          c.width = 640; c.height = 360;
          const g = c.getContext('2d');
          const grad = g.createLinearGradient(0, 0, 640, 360);
          grad.addColorStop(0, '#2b3f52'); grad.addColorStop(1, '#7a5c3e');
          g.fillStyle = grad; g.fillRect(0, 0, 640, 360);
          g.fillStyle = 'rgba(255,255,255,.86)';
          g.font = '600 30px system-ui';
          g.fillText('pasted screenshot', 34, 196);
          const blob = await new Promise(r => c.toBlob(r, 'image/png'));
          const png = [...new Uint8Array(await blob.arrayBuffer())];
          await store.attachBytes(id, 'screenshot 2026-08-27.png', png);

          const md = [...new TextEncoder().encode('# Rollout: staging, then production')];
          await store.attachBytes(id, 'rollout-notes.md', md);
          await store.attachBytes(id, 'kickoff deck.pptx', [80,75,3,4,20,0,6,0,8,0,0,0]);
        }
        await new Promise(r => setTimeout(r, 420));
      `
    },
    {
      name: '20-linked-files',
      setup: `
        const { store } = window.__jotter;
        const id = store.openCard;
        if (id) {
          for (const t of store.attachments.filter(t => t.mode === 'linked')) {
            await store.detach(t.id, id);
          }
          await store.linkPaths(id, ['${q(deck)}', '${q(spec)}', '${q(strayed)}']);
        }
        await new Promise(r => setTimeout(r, 320));
        // The strip is the point of these two shots, and it sits below the
        // notes field in a 336px column.
        document.querySelector('.fields')?.scrollTo({ top: 99999 });
        await new Promise(r => setTimeout(r, 200));
      `
    },
    {
      // The file is gone by the time this runs: a link that has gone stale has
      // to look different from one that has not.
      name: '21-link-broken',
      before: () => rmSync(strayed, { force: true }),
      setup: `
        const { store } = window.__jotter;
        await store.loadAttachments(store.openCard);
        await new Promise(r => setTimeout(r, 300));
        document.querySelector('.fields')?.scrollTo({ top: 99999 });
        await new Promise(r => setTimeout(r, 200));
      `
    },
    {
      name: '17-column-menu-night',
      setup: `
        const { store } = window.__jotter;
        store.openCard = null;
        await new Promise(r => setTimeout(r, 160));
        const more = document.querySelector('.col .more');
        if (more) more.click();
        await new Promise(r => setTimeout(r, 200));
      `
    },
    {
      name: '13-board-day',
      setup: `
        const { store } = window.__jotter;
        window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await store.setTheme('day');
        await new Promise(r => setTimeout(r, 200));
      `
    },
    {
      name: '18-card-panel-day',
      setup: `
        const first = document.querySelector('.card');
        if (first) first.click();
        await new Promise(r => setTimeout(r, 320));
      `
    },
    {
      name: '14-actions-list-day',
      setup: `
        const { store } = window.__jotter;
        store.openCard = null;
        await store.setActionsView('list');
        await new Promise(r => setTimeout(r, 200));
      `
    },
    {
      name: '10-delete-armed',
      setup: `
        const { store } = window.__jotter;
        await store.setTheme('night');
        if (store.showArchived) await store.toggleArchived();
        store.groupBy = 'none';
        store.openActions();
        await new Promise(r => setTimeout(r, 140));
        // The delete button is hidden until its row is hovered, which a
        // screenshot cannot do; clicking it directly arms the same state.
        const btn = document.querySelectorAll('aside .row .del')[1];
        if (btn) btn.click();
        await new Promise(r => setTimeout(r, 180));
      `
    },
    {
      name: '11-delete-armed-day',
      setup: `
        const { store } = window.__jotter;
        await store.setTheme('day');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 140));
        const btn = document.querySelectorAll('aside .row .del')[1];
        if (btn) btn.click();
        await new Promise(r => setTimeout(r, 180));
      `
    }
  ];

  for (const s of states) {
    if (s.before) await s.before();
    await evaluate(s.setup);
    // Two presented frames, then a real pause: WebView2 rasterises a theme flip
    // over several frames, and a screenshot taken a quarter-second in still
    // catches the half-repainted window.
    await evaluate(
      `await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));`
    );
    await sleep(900);
    await capture(s.name);
  }

  // The capture window is a second top-level window and therefore a second CDP
  // target; screenshot it through its own socket rather than by window title.
  await evaluate(`await window.__jotter.api.openCapture();`);
  await sleep(1800);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const other = list.find(
    (t) => t.type === 'page' && t.webSocketDebuggerUrl !== appSocketUrl
  );
  if (other) {
    const cw = new WebSocket(other.webSocketDebuggerUrl);
    await new Promise((ok, bad) => ((cw.onopen = ok), (cw.onerror = bad)));
    cw.onmessage = onMessage;
    await capture('09-quick-capture', cw);
    cw.close();
  } else {
    console.log('  09-quick-capture: no second target');
  }
  await evaluate(`await window.__jotter.api.openCapture();`);

  await evaluate(`
    const { store } = window.__jotter;
    await store.setTheme('night');
    if (store.showArchived) await store.toggleArchived();
  `);
  rmSync(linkDir, { recursive: true, force: true });
  console.log('done');
};

run()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  // The open CDP socket keeps the event loop alive, so the process has to
  // let go of it explicitly or the script looks hung after it finished.
  .finally(() => {
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
    process.exit(process.exitCode ?? 0);
  });
