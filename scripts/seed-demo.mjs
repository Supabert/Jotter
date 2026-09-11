// Fills an isolated JOTTER_DATA_DIR with realistic content so the interface can
// be reviewed at working density rather than empty. Never point this at the
// live data dir — it writes notes and actions.
//
//   node scripts/seed-demo.mjs

const PORT = Number(process.env.JOTTER_CDP_PORT ?? 9333);
let ws, seq = 0;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      // The capture window is a second CDP target on the same port, so match the
      // app's own page rather than whichever target happens to be first.
      const page = list.find(
        (t) => t.type === 'page' && t.url.startsWith('http') && !t.url.includes('devtools')
      );
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, bad) => ((ws.onopen = ok), (ws.onerror = bad)));
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          const p = pending.get(m.id);
          if (p) {
            pending.delete(m.id);
            m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
          }
        };
        return;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  throw new Error('no CDP page');
}

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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw');
  return r.result.value;
}

const NOTES = [
  {
    label: 'Now',
    title: 'Jotter — what this replaces',
    html: `<h1>Jotter — what this replaces</h1>
<p>Notepad was fine for a decade and then stopped being fine. Three things were missing.</p>
<ul><li>A pasted screenshot had nowhere to go.</li>
<li>Half of what I write is a thing I need to do, and it stayed buried in prose.</li>
<li>Anything I wanted back six weeks later was a filename I never chose well.</li></ul>
<p><span class="jt-action" data-action-id="seed-a1">Check the tray icon reads correctly at 16px</span> before anything else ships.</p>
<p>Everything here is local. No accounts, no sync, and completing a note stows it rather than destroying it.</p>`
  },
  {
    label: 'Work',
    title: 'Workstation — RAM baseline notes',
    html: `<h2>Workstation — RAM baseline notes</h2>
<p>47–53% of 32&nbsp;GB at idle is normal on this box. Windows itself is roughly two thirds of that, so the number is not a leak and not something to chase.</p>
<p><span class="jt-action" data-action-id="seed-a2">Re-measure after the next driver update</span></p>
<p style="color: #8d9699">Committed memory is not resident memory — reading the wrong column started this whole thread.</p>`
  },
  {
    label: 'Ideas',
    title: 'Sidebar should remember its scroll',
    html: `<p>The list scrolls back to the top after a restart instead of returning to where it was left.</p>
<p>Worth doing, not worth doing now.</p>`
  },
  {
    label: 'Reference',
    title: 'Keyboard map I actually use',
    html: `<h3>Daily</h3>
<ul><li><code>Ctrl+Alt+N</code> — capture from anywhere</li>
<li><code>Ctrl+Shift+A</code> — turn a sentence into an action</li>
<li><code>Ctrl+K</code> — jump to any note</li>
<li><code>Ctrl+Shift+E</code> — show the archive</li></ul>
<h3>Rarely</h3>
<ul><li><code>F11</code> — focus mode</li><li><code>Ctrl+,</code> — settings</li></ul>`
  },
  {
    label: 'Scratch',
    title: 'call re: the thing',
    html: `<p>tues 2pm — ask about the invoice, the delivery window, and whether the older unit is still under warranty</p>`
  },
  {
    label: 'Work',
    title: 'Cargo build is slow the first time only',
    html: `<p>SQLite is compiled in, so the first <code>cargo</code> build takes minutes. Every build after is seconds. This is the trade for having no system SQLite dependency at all.</p>`
  },
  {
    label: null,
    title: 'grocery',
    html: `<p>rice, olive oil, the good coffee, batteries (AA)</p>`
  },
  {
    label: 'Ideas',
    title: 'Old shipping estimate — superseded',
    html: `<p>Two weeks. Wrong by a factor of three; kept because the reasoning is still interesting.</p>`,
    archived: true
  }
];

const LOOSE_ACTIONS = [
  { text: 'Book the annual service', due: 0 },
  { text: 'Reply to the warranty email', due: -2 },
  { text: 'Renew the domain', due: 6 }
];

const run = async () => {
  await connect();
  await evaluate(`for (let i = 0; i < 60 && !window.__jotter; i++) await new Promise(r => setTimeout(r, 100));`);

  const made = await evaluate(`
    const { api, store } = window.__jotter;
    const existing = await api.listNotes();
    if (existing.length > 0) return { skipped: true, count: existing.length };

    const labels = await api.listLabels();
    const byName = Object.fromEntries(labels.map(l => [l.name, l.id]));
    const notes = ${JSON.stringify(NOTES)};
    const loose = ${JSON.stringify(LOOSE_ACTIONS)};

    const toText = (html) => {
      const d = document.createElement('div');
      d.innerHTML = html;
      d.querySelectorAll('p,div,li,h1,h2,h3').forEach(b => b.append('\\n'));
      return (d.textContent ?? '').replace(/\\n{3,}/g, '\\n\\n').trim();
    };

    const day = (offset) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    };

    for (const n of notes) {
      const id = await api.createNote(n.title, n.html, toText(n.html), byName[n.label] ?? null);
      const d = document.createElement('div');
      d.innerHTML = n.html;
      for (const span of d.querySelectorAll('.jt-action')) {
        await api.createAction(span.textContent.trim(), id, span.getAttribute('data-action-id'), null);
      }
      if (n.archived) await api.setNoteArchived(id, true);
    }

    for (const a of loose) await api.createAction(a.text, null, null, day(a.due));

    await store.load();
    const all = await api.listNotes();
    const acts = await api.listActions();
    return { skipped: false, notes: all.length, actions: acts.length };
  `);

  console.log(JSON.stringify(made));
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
