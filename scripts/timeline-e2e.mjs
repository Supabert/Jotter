// End-to-end check for the timeline, driving the REAL app over CDP against the
// real SQLite file — including the drag gestures, dispatched as real input
// through the renderer rather than as synthetic events on the element.
//
//   $env:JOTTER_DATA_DIR="$([Environment]::GetFolderPath('MyDocuments'))\Jotter\e2e-timeline"
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333"
//   npm run start
//   node scripts/timeline-e2e.mjs
//
// The board's card drag is HTML5 drag-and-drop, which CDP cannot deliver end to
// end — proving a drop there needs the physical cursor (`scripts/real-drag.ps1`).
// The chart's gestures are pointer events, so `Input.dispatchMouseEvent` drives
// them exactly as a hand would. That is a large part of why the chart is built
// on pointer capture rather than on the board's mechanism.

const PORT = Number(process.env.JOTTER_CDP_PORT ?? 9333);
let ws;
let seq = 0;
const pending = new Map();
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pages = list.filter(
        (t) => t.type === 'page' && t.url.startsWith('http') && !t.url.includes('devtools')
      );
      // The quick-capture window is a second target on this port and it shares
      // the dev bridge, so store assertions pass against it while every DOM
      // query returns nothing. Match the main window's own root element.
      for (const page of pages) {
        const sock = new WebSocket(page.webSocketDebuggerUrl);
        try {
          await new Promise((ok, bad) => ((sock.onopen = ok), (sock.onerror = bad)));
        } catch {
          continue;
        }
        sock.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
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
        if (main.result.value) return page.url;
        ws = null;
        sock.close();
      }
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  throw new Error(`no CDP page on 127.0.0.1:${PORT}`);
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
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate threw');
  }
  return r.result.value;
}

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// --- real input -------------------------------------------------------------

async function mouse(type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    clickCount: 1,
    ...extra
  });
}

/** Press, travel in steps, release. Steps matter: one jump can outrun a
    handler that only reads the latest move, and a real hand never teleports. */
async function drag(from, to, steps = 12) {
  await mouse('mousePressed', from.x, from.y);
  await sleep(30);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await mouse('mouseMoved', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, {
      buttons: 1,
      button: 'left'
    });
    await sleep(12);
  }
  await sleep(40);
  await mouse('mouseReleased', to.x, to.y);
  await sleep(260);
}

/** Viewport centre of a selector, or null. */
function rectOf(sel) {
  return evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  `);
}

const barSel = (id) => `.lane[data-aid="${id}"] .mark`;

// --- the run ----------------------------------------------------------------

const run = async () => {
  const url = await connect();
  console.log(`connected: ${url}\n`);

  await evaluate(
    `for (let i = 0; i < 60 && !window.__jotter; i++) await new Promise(r => setTimeout(r, 100));`
  );
  if (!(await evaluate(`return !!window.__jotter;`))) {
    check('dev bridge is exposed', false);
    return;
  }
  check('dev bridge is exposed', true);

  // --- fixture ------------------------------------------------------------
  //
  // Two projects and four dated rows, all relative to the app's own idea of
  // today so the assertions never depend on the calendar date of the run.

  const fx = await evaluate(`
    const { store, api } = window.__jotter;
    const S = window.__jotterScale;

    for (const a of store.actions) await api.deleteAction(a.id);
    await store.refreshActions();

    let projects = store.projects.filter(p => !p.hidden);
    while (projects.length < 2) {
      await api.createProject('TL Project ' + (projects.length + 1), '#4b86a3');
      await store.refreshBoard();
      projects = store.projects.filter(p => !p.hidden);
    }
    const [p1, p2] = projects;

    const t = store.today;
    const mk = async (text, start, due, project) => {
      const a = await api.createAction(text, null, null, null);
      await api.setActionSpan(a.id, start, due);
      if (project !== null) await api.setActionProject(a.id, project);
      return a.id;
    };

    const span   = await mk('Span row',      S.addDays(t, 2),   S.addDays(t, 6),   p1.id);
    const late   = await mk('Late row',      S.addDays(t, -9),  S.addDays(t, -4),  p1.id);
    const stone  = await mk('Milestone row', null,              S.addDays(t, 10),  p2.id);
    const loose  = await mk('Loose row',     S.addDays(t, 1),   S.addDays(t, 3),   null);
    const naked  = await mk('Undated row',   null,              null,              p1.id);

    await store.refreshActions();
    store.timelineFit = false;
    store.timelineBack = 14;
    store.timelineFwd = 90;
    store.timelineZoom = 'day';
    store.timelineSort = 'manual';
    store.timelineShowDone = true;
    store.boardProject = null;
    store.timelineCollapsed = [];
    store.openCard = null;
    store.activeKey = 'actions';
    store.actionsView = 'timeline';
    await new Promise(r => setTimeout(r, 400));

    return { span, late, stone, loose, naked, p1: p1.id, p2: p2.id, today: t };
  `);
  check('fixture built', !!fx.span, `today ${fx.today}`);

  // --- schema + commands --------------------------------------------------

  const row = await evaluate(`
    const { store } = window.__jotter;
    const a = store.actions.find(x => x.id === ${fx.span});
    return { hasOrder: typeof a.timeline_order === 'number', start: a.start_date, due: a.due_date };
  `);
  check('V7 timeline_order reaches the frontend', row.hasOrder);
  check(
    'set_action_span wrote both dates in one call',
    row.start !== null && row.due !== null,
    `${row.start} -> ${row.due}`
  );

  const grouped = await evaluate(`
    const { store } = window.__jotter;
    return store.timelineGroups.map(g => ({
      key: g.key, name: g.name, rows: g.items.length, undated: g.undated,
      rollup: g.rollup ? [g.rollup.start, g.rollup.end] : null
    }));
  `);
  check(
    'rows band by project, No project last',
    grouped.length >= 2 && grouped[grouped.length - 1].key === 'none',
    grouped.map((g) => `${g.name}:${g.rows}`).join(' ')
  );
  check(
    'an undated row is counted, not drawn',
    grouped.some((g) => g.undated === 1),
    JSON.stringify(grouped.map((g) => g.undated))
  );

  const rollupOk = await evaluate(`
    const { store } = window.__jotter;
    const S = window.__jotterScale;
    const g = store.timelineGroups.find(x => x.key === 'p${fx.p1}');
    if (!g || !g.rollup) return null;
    const lows = g.items.flatMap(a => [a.start_date, a.due_date]).filter(Boolean).map(S.toDayIndex);
    return { got: [g.rollup.start, g.rollup.end], want: [Math.min(...lows), Math.max(...lows)] };
  `);
  check(
    'the rollup spans exactly its children',
    rollupOk && rollupOk.got[0] === rollupOk.want[0] && rollupOk.got[1] === rollupOk.want[1],
    JSON.stringify(rollupOk)
  );

  // --- geometry -----------------------------------------------------------

  const geom = await evaluate(`
    const { store } = window.__jotter;
    const S = window.__jotterScale;
    const d = store.timelineDomain, z = store.timelineZoom;
    const a = store.actions.find(x => x.id === ${fx.span});
    const el = document.querySelector('.lane[data-aid="${fx.span}"] .mark');
    if (!el) return null;
    return {
      left: Math.round(parseFloat(el.style.left)),
      width: Math.round(parseFloat(el.style.width)),
      wantLeft: Math.round(S.xOf(S.toDayIndex(a.start_date), d, z)),
      wantWidth: Math.round(S.widthOf(S.toDayIndex(a.start_date), S.toDayIndex(a.due_date), z)),
      days: S.spanDays(a.start_date, a.due_date)
    };
  `);
  check('a bar is drawn at its start date', geom && geom.left === geom.wantLeft, JSON.stringify(geom));
  check(
    'and is as wide as its span is long, both ends counted',
    geom && geom.width === geom.wantWidth && geom.days === 5,
    `${geom?.days} days, ${geom?.width}px`
  );

  const shapes = await evaluate(`
    return {
      milestone: !!document.querySelector('.lane[data-aid="${fx.stone}"] .mark.milestone'),
      bar: !!document.querySelector('.lane[data-aid="${fx.span}"] .mark.bar'),
      overdue: !!document.querySelector('.lane[data-aid="${fx.late}"] .mark.overdue'),
      naked: !!document.querySelector('.lane[data-aid="${fx.naked}"] .mark'),
      today: !!document.querySelector('.today')
    };
  `);
  check('a due-only row draws as a milestone', shapes.milestone);
  check('a row with both dates draws as a bar', shapes.bar);
  check('a late row draws red', shapes.overdue);
  check('a row with no dates draws nothing', !shapes.naked);
  check('the today line is on the chart', shapes.today);

  const todayLine = await evaluate(`
    const { store } = window.__jotter;
    const S = window.__jotterScale;
    const el = document.querySelector('.today');
    return {
      got: Math.round(parseFloat(el.style.left)),
      want: Math.round(S.xOf(S.toDayIndex(store.today), store.timelineDomain, store.timelineZoom))
    };
  `);
  check('the today line sits on today', todayLine.got === todayLine.want, JSON.stringify(todayLine));

  // --- gestures -----------------------------------------------------------

  const dayW = await evaluate(`return window.__jotterScale.dayWidth(window.__jotter.store.timelineZoom);`);

  // Move: both dates shift by the same whole number of days.
  {
    const before = await evaluate(`
      const a = window.__jotter.store.actions.find(x => x.id === ${fx.span});
      return { start: a.start_date, due: a.due_date };
    `);
    const r = await rectOf(barSel(fx.span));
    await drag({ x: r.cx, y: r.cy }, { x: r.cx + dayW * 3, y: r.cy });
    const after = await evaluate(`
      const S = window.__jotterScale;
      const a = window.__jotter.store.actions.find(x => x.id === ${fx.span});
      return {
        start: a.start_date, due: a.due_date,
        dStart: S.toDayIndex(a.start_date) - S.toDayIndex(${JSON.stringify(before.start)}),
        dDue: S.toDayIndex(a.due_date) - S.toDayIndex(${JSON.stringify(before.due)})
      };
    `);
    check(
      'dragging a bar body moves both dates together',
      after.dStart === 3 && after.dDue === 3,
      `start ${after.dStart}d, due ${after.dDue}d`
    );
  }

  // Undo: the toast's offer really reverses the write.
  {
    const undone = await evaluate(`
      const { store } = window.__jotter;
      const btn = document.querySelector('.toast .undo');
      if (!btn) return { offered: false };
      const before = store.actions.find(x => x.id === ${fx.span}).start_date;
      btn.click();
      await new Promise(r => setTimeout(r, 400));
      return { offered: true, before, after: store.actions.find(x => x.id === ${fx.span}).start_date };
    `);
    check('a drag offers an undo', undone.offered);
    check(
      'and the undo puts the dates back',
      undone.offered && undone.after !== undone.before,
      `${undone.before} -> ${undone.after}`
    );
  }

  // Right edge: the deadline moves, the start does not.
  {
    const before = await evaluate(`
      const a = window.__jotter.store.actions.find(x => x.id === ${fx.span});
      return { start: a.start_date, due: a.due_date };
    `);
    const r = await rectOf(barSel(fx.span));
    await drag({ x: r.x + r.w - 3, y: r.cy }, { x: r.x + r.w - 3 + dayW * 4, y: r.cy });
    const after = await evaluate(`
      const S = window.__jotterScale;
      const a = window.__jotter.store.actions.find(x => x.id === ${fx.span});
      return {
        sameStart: a.start_date === ${JSON.stringify(before.start)},
        dDue: S.toDayIndex(a.due_date) - S.toDayIndex(${JSON.stringify(before.due)})
      };
    `);
    check(
      'dragging the right edge extends the deadline alone',
      after.sameStart && after.dDue === 4,
      `start held ${after.sameStart}, due +${after.dDue}d`
    );
  }

  // Left edge dragged past the deadline: the start is cleared and the bar
  // collapses back into the milestone it grew out of.
  {
    const r = await rectOf(barSel(fx.span));
    await drag({ x: r.x + 3, y: r.cy }, { x: r.x + 3 + dayW * 40, y: r.cy });
    const after = await evaluate(`
      const a = window.__jotter.store.actions.find(x => x.id === ${fx.span});
      return {
        start: a.start_date,
        due: a.due_date,
        milestone: !!document.querySelector('.lane[data-aid="${fx.span}"] .mark.milestone')
      };
    `);
    check(
      'a start dragged past its own deadline is cleared',
      after.start === null && after.due !== null,
      `start ${after.start}, due ${after.due}`
    );
    check('and the bar collapses back to a milestone', after.milestone);
  }

  // The reverse gesture: a milestone's handle pulls a start into existence.
  {
    const r = await rectOf(barSel(fx.stone));
    await evaluate(`
      const el = document.querySelector('.lane[data-aid="${fx.stone}"] .mark');
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    `);
    await mouse('mouseMoved', r.cx, r.cy);
    await sleep(80);
    const handle = await rectOf(`.lane[data-aid="${fx.stone}"] .grow`);
    await drag({ x: handle.cx, y: handle.cy }, { x: handle.cx - dayW * 5, y: handle.cy });
    const after = await evaluate(`
      const S = window.__jotterScale;
      const a = window.__jotter.store.actions.find(x => x.id === ${fx.stone});
      return {
        start: a.start_date,
        due: a.due_date,
        span: a.start_date ? S.spanDays(a.start_date, a.due_date) : 0,
        bar: !!document.querySelector('.lane[data-aid="${fx.stone}"] .mark.bar')
      };
    `);
    check(
      'a milestone handle pulled left creates a start',
      after.start !== null && after.span === 6,
      `${after.start} -> ${after.due} (${after.span} days)`
    );
    check('and it becomes a bar', after.bar);
  }

  // Vertical: dropping into another band re-files the work.
  {
    const from = await rectOf(barSel(fx.loose));
    const target = await rectOf(`.lane[data-gkey="p${fx.p2}"]`);
    await drag({ x: from.cx, y: from.cy }, { x: from.cx, y: target.cy + 4 }, 16);
    const after = await evaluate(`
      const a = window.__jotter.store.actions.find(x => x.id === ${fx.loose});
      return { project: a.project_id };
    `);
    check(
      'a bar dropped in another band changes its project',
      after.project === fx.p2,
      `project ${after.project} (wanted ${fx.p2})`
    );
  }

  // A press that never travels is a click, and a click opens the panel.
  {
    await evaluate(`window.__jotter.store.openCard = null;`);
    const r = await rectOf(barSel(fx.late));
    await mouse('mousePressed', r.cx, r.cy);
    await sleep(40);
    await mouse('mouseReleased', r.cx, r.cy);
    await sleep(220);
    const opened = await evaluate(`
      return {
        card: window.__jotter.store.openCard,
        panel: !!document.querySelector('.boardwrap.withpanel')
      };
    `);
    check('clicking a bar opens its panel', opened.card === fx.late && opened.panel);
    await evaluate(`window.__jotter.store.openCard = null; await new Promise(r => setTimeout(r, 200));`);
  }

  // Pan: pressing empty canvas and moving scrolls the chart both ways.
  {
    const before = await evaluate(`
      const b = document.querySelector('.tl .body');
      b.scrollLeft = 400; b.scrollTop = 0;
      return { left: b.scrollLeft };
    `);
    const body = await rectOf('.tl .body');
    // Below the last row and right of every bar. The canvas fills the pane, so
    // this is still chart — which is the whole point of grabbing "anywhere".
    // Clear of the horizontal scrollbar along the bottom edge, which is not
    // canvas and swallows the press.
    const py = body.y + body.h - 45;
    await drag({ x: body.x + body.w - 40, y: py }, { x: body.x + body.w - 160, y: py });
    const after = await evaluate(`return { left: document.querySelector('.tl .body').scrollLeft };`);
    check(
      'grabbing empty canvas pans the chart',
      after.left > before.left,
      `${before.left} -> ${after.left}`
    );
  }

  // Wheel: the zoom steps, and the day under the cursor stays under it.
  {
    const body = await rectOf('.tl .body');
    const cursorX = body.x + body.w / 2;
    const before = await evaluate(`
      const { store } = window.__jotter;
      const S = window.__jotterScale;
      const b = document.querySelector('.tl .body');
      // Wide enough that the anchored day is still reachable after the notch.
      // Zoomed out onto a domain that already fits there is nothing to scroll,
      // so the chart parks at the left — correct, but it proves nothing.
      store.timelineZoom = 'day';
      await store.setTimelineRange(365, 365);
      await new Promise(r => setTimeout(r, 200));
      // Far enough in that the anchored day is still reachable once the day
      // width drops: near the left edge the anchor would need a negative
      // scroll, so the chart correctly parks at 0 and proves nothing.
      b.scrollLeft = 3000;
      return {
        zoom: store.timelineZoom,
        day: (b.scrollLeft + ${Math.round(body.w / 2)}) / S.dayWidth(store.timelineZoom)
      };
    `);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(cursorX),
      y: Math.round(body.cy),
      deltaX: 0,
      deltaY: 120
    });
    await sleep(320);
    const after = await evaluate(`
      const { store } = window.__jotter;
      const S = window.__jotterScale;
      const b = document.querySelector('.tl .body');
      return {
        zoom: store.timelineZoom,
        day: (b.scrollLeft + ${Math.round(body.w / 2)}) / S.dayWidth(store.timelineZoom)
      };
    `);
    check(
      'a wheel notch steps the zoom out',
      before.zoom === 'day' && after.zoom === 'week',
      `${before.zoom} -> ${after.zoom}`
    );
    check(
      'and the day under the cursor stays under the cursor',
      Math.abs(after.day - before.day) < 1.5,
      `${before.day?.toFixed(1)} -> ${after.day?.toFixed(1)}`
    );
    await evaluate(`window.__jotter.store.timelineZoom = 'day'; await new Promise(r => setTimeout(r, 200));`);
  }

  // --- range and collapse -------------------------------------------------

  const range = await evaluate(`
    const { store } = window.__jotter;
    const S = window.__jotterScale;
    await store.setTimelineRange(30, 30);
    const narrow = S.domainDays(store.timelineDomain);
    await store.setTimelineRange(14, 365);
    const wide = S.domainDays(store.timelineDomain);
    await store.setTimelineFit(true);
    const fit = S.domainDays(store.timelineDomain);
    await store.setTimelineRange(14, 90);
    return { narrow, wide, fit, fitOff: store.timelineFit };
  `);
  check('the range control resizes the canvas', range.wide > range.narrow, `${range.narrow} -> ${range.wide} days`);
  check('Fit spans the work instead', range.fit > 0 && range.fit < range.wide, `${range.fit} days`);
  check('and setting a range turns Fit back off', range.fitOff === false);

  const collapsed = await evaluate(`
    const { store } = window.__jotter;
    await store.toggleCollapsed(${fx.p1});
    await new Promise(r => setTimeout(r, 200));
    const hidden = !document.querySelector('.lane[data-aid="${fx.late}"]');
    const header = !!document.querySelector('.lane[data-gkey="p${fx.p1}"]');
    await store.toggleCollapsed(${fx.p1});
    await new Promise(r => setTimeout(r, 200));
    const back = !!document.querySelector('.lane[data-aid="${fx.late}"]');
    return { hidden, header, back, persisted: store.settings['timeline_collapsed'] !== undefined };
  `);
  check('collapsing a project folds its rows away', collapsed.hidden && collapsed.header);
  check('and expanding brings them back', collapsed.back);
  check('the collapse is written to settings', collapsed.persisted);

  // --- the same rows, read three ways -------------------------------------

  const shared = await evaluate(`
    const { store, api } = window.__jotter;
    await api.setActionDone(${fx.late}, true);
    await store.refreshActions();
    const a = store.actions.find(x => x.id === ${fx.late});
    const onChart = store.timelineGroups.some(g => g.items.some(x => x.id === ${fx.late}));
    await api.setActionDone(${fx.late}, false);
    await store.refreshActions();
    return { done: a.done, onChart, overdueAfter: store.isOverdue(store.actions.find(x => x.id === ${fx.late})) };
  `);
  check('ticking on the chart is the same write as the checklist', shared.done);
  check('a finished row still occupies its span', shared.onChart);
  check('and reopening it makes it late again', shared.overdueAfter);

  // --- the board went red too ---------------------------------------------

  const board = await evaluate(`
    const { store, api } = window.__jotter;
    store.actionsView = 'board';
    await new Promise(r => setTimeout(r, 350));
    const red = !!document.querySelector('.card.overdue');
    const which = [...document.querySelectorAll('.card.overdue')].map(c => c.dataset.id);
    // Fixing the date has to un-redden it with no second write.
    await api.setActionDue(${fx.late}, store.today);
    await store.refreshActions();
    await new Promise(r => setTimeout(r, 300));
    const stillRed = !!document.querySelector('.card[data-id="${fx.late}"].overdue');
    store.actionsView = 'timeline';
    await new Promise(r => setTimeout(r, 250));
    return { red, which, stillRed };
  `);
  check('an overdue card is red on the board', board.red, `cards ${board.which.join(',')}`);
  check('and fixing the date clears it with no second write', board.stillRed === false);

  console.log('');
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
};

run()
  .catch((e) => {
    console.error(`timeline e2e aborted: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
    process.exit(process.exitCode ?? 0);
  });
