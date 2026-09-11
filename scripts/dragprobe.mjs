// Proves that a real mouse gesture drags and drops inside the app.
//
// Synthetic `new DragEvent(...)` only proves the handlers are wired; it says
// nothing about whether the gesture ever reaches them. On Windows a Tauri
// webview with `dragDropEnabled` left on takes drag over at the OS level and
// HTML5 drag never begins, which looks exactly like a code bug and is not one.
//
// Input.setInterceptDrags(true) makes Chromium hand a started drag back as an
// `Input.dragIntercepted` event instead of giving it to the OS. The gesture
// below is the same code path the user's mouse takes, and it is carried all the
// way to a drop, then checked against SQLite.
//
// An intercepted drag MUST be finished (drop) or cancelled. Leaving one pending
// wedges the renderer and every later drag silently fails to start.
//
//   node scripts/dragprobe.mjs

const PORT = Number(process.env.JOTTER_CDP_PORT ?? 9333);
let ws, seq = 0;
const pending = new Map();
let onDrag = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw');
  return r.result.value;
};

function check(name, pass, detail = '') {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
for (const page of list.filter((t) => t.type === 'page' && t.url.startsWith('http'))) {
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, bad) => ((sock.onopen = ok), (sock.onerror = bad)));
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Input.dragIntercepted' && onDrag) onDrag(m.params.data);
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  ws = sock;
  const main = await send('Runtime.evaluate', {
    expression: `!!document.querySelector('.app')`,
    returnByValue: true
  });
  if (main.result.value) break;
  ws = null;
  sock.close();
}
if (!ws) {
  console.error('no main window');
  process.exit(1);
}

/** Press and move until Chromium reports a drag, or give up. */
async function startDrag(from) {
  const got = new Promise((resolve) => {
    onDrag = resolve;
    setTimeout(() => resolve(null), 1500);
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  });
  for (const dx of [3, 10, 26, 52]) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + dx,
      y: from.y,
      button: 'left',
      buttons: 1
    });
    await sleep(30);
  }
  const data = await got;
  onDrag = null;
  if (!data) {
    // Never leave the button down: a stuck mouse-down poisons every later
    // gesture and makes the next failure look like the same bug.
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: from.x + 52,
      y: from.y,
      button: 'left',
      buttons: 0,
      clickCount: 1
    });
  }
  return data;
}

/** Carry an intercepted drag to a drop on `to`, then let the mouse up. */
async function dropAt(data, to) {
  for (const type of ['dragEnter', 'dragOver']) {
    await send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data });
    await sleep(40);
  }
  await send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: to.x,
    y: to.y,
    button: 'left',
    buttons: 0,
    clickCount: 1
  });
  await sleep(60);
}

// A drag left pending by an earlier run wedges the renderer, and nothing about
// that is visible from the page. Start from a fresh document every time.
await send('Runtime.evaluate', { expression: `location.reload()` });
await sleep(1200);
await evaluate(
  `for (let i = 0; i < 60 && !window.__jotter; i++) await new Promise(r => setTimeout(r, 100));`
);

await send('Input.setInterceptDrags', { enabled: true });

// --- a card, from the first column into the second -------------------------
const g1 = await evaluate(`
  const { store } = window.__jotter;
  await store.setActionsView('board');
  store.openActions();
  store.openCard = null;
  await store.setBoardSort('manual');
  await new Promise(r => setTimeout(r, 320));
  const cols = [...document.querySelectorAll('.col')];
  const card = cols[0].querySelector('.card');
  const tail = cols[1].querySelector('.tail');
  const c = card.getBoundingClientRect(), t = tail.getBoundingClientRect();
  const id = Number(card.getAttribute('data-id'));
  return {
    id,
    stageBefore: store.stageOf(store.actions.find(a => a.id === id)),
    target: store.visibleStages[1].id,
    from: { x: Math.round(c.left + 90), y: Math.round(c.top + c.height / 2) },
    to: { x: Math.round(t.left + t.width / 2), y: Math.round(t.top + 12) }
  };
`);

const d1 = await startDrag(g1.from);
check('a real mouse gesture starts a drag from a card', !!d1);
if (d1) {
  await dropAt(d1, g1.to);
  await sleep(400);
  const after = await evaluate(`
    const { store } = window.__jotter;
    await store.refreshActions();
    return store.stageOf(store.actions.find(a => a.id === ${g1.id}));
  `);
  check(
    'dropping it in another column moves it there',
    after === g1.target,
    `stage ${g1.stageBefore} → ${after}`
  );
}

// --- a column, by its header ------------------------------------------------
const g2 = await evaluate(`
  const { store } = window.__jotter;
  await new Promise(r => setTimeout(r, 200));
  const cols = [...document.querySelectorAll('.col')];
  const head = cols[0].querySelector('.col-head .name');
  const h = head.getBoundingClientRect(), t = cols[1].getBoundingClientRect();
  return {
    order: store.stages.map(s => s.id).join(','),
    from: { x: Math.round(h.left + h.width / 2), y: Math.round(h.top + h.height / 2) },
    to: { x: Math.round(t.left + t.width / 2), y: Math.round(t.top + t.height / 2) }
  };
`);

const d2 = await startDrag(g2.from);
check('a real mouse gesture starts a drag from a column header', !!d2);
if (d2) {
  await dropAt(d2, g2.to);
  await sleep(400);
  const after = await evaluate(`
    const { store } = window.__jotter;
    await store.refreshBoard();
    return store.stages.map(s => s.id).join(',');
  `);
  check('dropping it on another column reorders the board', after !== g2.order, `${g2.order} → ${after}`);
}

await send('Input.setInterceptDrags', { enabled: false });
console.log('');
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
ws.close();
process.exit(results.every(Boolean) ? 0 : 1);
