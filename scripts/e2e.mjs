// End-to-end check driving the REAL app through WebView2's CDP endpoint, not a
// browser stand-in. Everything here goes through the actual Tauri IPC and the
// actual SQLite file, so a pass means the shipped path works.
//
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333"
//   npm run start
//   node scripts/e2e.mjs

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = Number(process.env.JOTTER_CDP_PORT ?? 9333);
let ws, seq = 0;
const pending = new Map();
const results = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await targets();
      // The capture window is a second CDP target on the same port, so match the
      // app's own page rather than whichever target happens to be first.
      // The quick-capture window is a second CDP target on the same port and it
      // shares the dev bridge, so a store-only assertion passes against it while
      // every DOM assertion silently fails. Match on the main window's own root
      // element rather than on target order.
      const pages = list.filter(
        (t) => t.type === 'page' && t.url.startsWith('http') && !t.url.includes('devtools')
      );
      for (const page of pages) {
        const sock = new WebSocket(page.webSocketDebuggerUrl);
        try {
          await new Promise((ok, bad) => {
            sock.onopen = ok;
            sock.onerror = bad;
          });
        } catch {
          continue;
        }
        sock.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
          }
        };
        ws = sock;
        const isMain = await send('Runtime.evaluate', {
          expression: `!!document.querySelector('.app')`,
          returnByValue: true
        });
        if (isMain.result.value) return page.url;
        ws = null;
        sock.close();
      }
    } catch {
      /* the app has not opened its port yet */
    }
    await sleep(500);
  }
  throw new Error(`no CDP page on 127.0.0.1:${PORT} — is the app running with --remote-debugging-port?`);
}

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Evaluate in the page and return the JSON value, surfacing thrown errors. */
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

// Every assertion goes through window.__jotter, exposed only in dev, so the
// test drives the same store the UI drives rather than a parallel copy.
const run = async () => {
  const url = await connect();
  console.log(`connected: ${url}\n`);

  await evaluate(`for (let i = 0; i < 60 && !window.__jotter; i++) await new Promise(r => setTimeout(r, 100));`);
  const hasBridge = await evaluate(`return !!window.__jotter;`);
  check('dev bridge is exposed', hasBridge);
  if (!hasBridge) return;

  // 1 — create and autosave
  const noteId = await evaluate(`
    const { store, api } = window.__jotter;
    const id = await api.createNote('E2E probe', '<p>alpha bravo charlie</p>', 'alpha bravo charlie', null);
    await store.refreshNotes();
    return id;
  `);
  check('note created', typeof noteId === 'number', `id ${noteId}`);

  // getNote returns body_html; body_text is the FTS mirror and surfaces as the
  // sidebar excerpt, so both stored columns are checked from their own reader.
  const persisted = await evaluate(`
    const { api, store } = window.__jotter;
    const n = await api.getNote(${noteId});
    await store.refreshNotes();
    const row = store.notes.find(x => x.id === ${noteId});
    return { html: n.body_html, excerpt: row?.excerpt ?? null, title: n.title };
  `);
  check(
    'note body persisted to SQLite',
    persisted.html === '<p>alpha bravo charlie</p>',
    persisted.html
  );
  check(
    'plaintext mirror persisted alongside it',
    persisted.excerpt === 'alpha bravo charlie',
    persisted.excerpt ?? 'null'
  );

  // 2 — the Ctrl+Shift+A path, exercised through the same wrap helper the
  //     keyboard route calls
  const actionResult = await evaluate(`
    const { api, store, wrapSelectionAsAction } = window.__jotter;
    const host = document.createElement('div');
    host.innerHTML = '<p>call the plumber about the leak</p>';
    document.body.appendChild(host);
    const target = host.querySelector('p').firstChild;
    const range = document.createRange();
    range.setStart(target, 0);
    range.setEnd(target, target.length);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const wrapped = wrapSelectionAsAction(host);
    let created = null;
    if (wrapped) created = await api.createAction(wrapped.text, ${noteId}, wrapped.anchorId, null);
    const marked = host.querySelector('.jt-action')?.getAttribute('data-action-id') ?? null;
    host.remove();
    await store.refreshActions();
    return { text: wrapped?.text ?? null, anchorInDom: marked, id: created?.id ?? null, anchorInDb: created?.anchor_id ?? null };
  `);
  check('selection wrapped as an action', actionResult.text === 'call the plumber about the leak', actionResult.text ?? 'null');
  check(
    'action anchor matches the span in the note',
    !!actionResult.anchorInDom && actionResult.anchorInDom === actionResult.anchorInDb,
    actionResult.anchorInDb ?? 'null'
  );

  // 2b — the anchor has to survive the allowlist and a save/load round trip,
  //      or the Actions page loses its way back into the note
  const roundTrip = await evaluate(`
    const { api, sanitizeHtml } = window.__jotter;
    const markup = '<p>before <span class="jt-action" data-action-id="' + ${JSON.stringify(actionResult.anchorInDb)} +
                   '">the actioned sentence</span> after</p>';
    const cleaned = sanitizeHtml(markup);
    await api.saveNote(${noteId}, 'E2E probe', cleaned, 'before the actioned sentence after');
    const back = await api.getNote(${noteId});
    const d = document.createElement('div');
    d.innerHTML = back.body_html;
    const span = d.querySelector('.jt-action');
    return { anchor: span?.getAttribute('data-action-id') ?? null, text: span?.textContent ?? null };
  `);
  check(
    'the action anchor survives sanitize + save + load',
    roundTrip.anchor === actionResult.anchorInDb && roundTrip.text === 'the actioned sentence',
    roundTrip.anchor ?? 'lost'
  );

  // 3 — completing strikes it in the note without rewriting the note's HTML
  const done = await evaluate(`
    const { api, store } = window.__jotter;
    await api.setActionDone(${actionResult.id}, true);
    await store.refreshActions();
    const anchors = await api.doneAnchors(${noteId});
    const row = store.actions.find(a => a.id === ${actionResult.id});
    return { anchors, done: row?.done, archived: row?.archived };
  `);
  check('completing an action reports its anchor as done', done.anchors.includes(actionResult.anchorInDb));
  check('completing also stows it', done.done === true && done.archived === true);

  // 4 — image paste through the content-addressed store, twice
  const img = await evaluate(`
    const { api } = window.__jotter;
    // A 1x1 PNG, byte for byte — the store must sniff this, not trust a name.
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bytes = [...atob(b64)].map(c => c.charCodeAt(0));
    const a = await api.saveImage(bytes);
    const b = await api.saveImage(bytes);
    let rejected = false;
    try { await api.imagePath('../../../../windows/win.ini'); } catch { rejected = true; }
    return { a: a.file, b: b.file, rejected };
  `);
  check('pasted image lands in the store', /^[0-9a-f]{64}\.png$/.test(img.a), img.a);
  check('the same image twice stores once', img.a === img.b);
  check('a traversal in an image reference is refused', img.rejected);

  // 5 — the allowlist
  const clean = await evaluate(`
    const { sanitizeHtml } = window.__jotter;
    const dirty = '<p onclick="steal()">hi<script>fetch("http://evil")<\\/script>' +
                  '<img src="http://evil/x.png" data-jt-img="nope">' +
                  '<span style="position:fixed;color:#f00">red</span></p>';
    const out = sanitizeHtml(dirty);
    return {
      out,
      noScript: !/script/i.test(out),
      noHandler: !/onclick/i.test(out),
      noRemoteImg: !/evil/i.test(out),
      noPosition: !/position/i.test(out),
      keptColor: /color/i.test(out)
    };
  `);
  check('script tags are stripped', clean.noScript);
  check('event handlers are stripped', clean.noHandler);
  check('a remote image src never survives', clean.noRemoteImg);
  check('layout CSS is stripped, presentation CSS kept', clean.noPosition && clean.keptColor, clean.out);

  // 6 — search and archive
  // The round-trip above replaced this note's text, so 'bravo' is gone and
  // 'actioned' is present. Asserting both proves the FTS triggers delete the
  // stale row on UPDATE rather than only inserting the new one.
  const search = await evaluate(`
    const { api } = window.__jotter;
    const current = await api.searchNotes('actioned');
    const stale = await api.searchNotes('bravo');
    const prefix = await api.searchNotes('action');
    const injection = await api.searchNotes('actioned" OR 1=1 --');
    return {
      found: current.some(h => h.id === ${noteId}),
      staleGone: !stale.some(h => h.id === ${noteId}),
      prefixWorks: prefix.some(h => h.id === ${noteId}),
      snippet: current.find(h => h.id === ${noteId})?.snippet ?? '',
      injectionCount: injection.length
    };
  `);
  check('full-text search finds the note', search.found);
  check('the index drops the previous text on update', search.staleGone);
  check('prefix search works', search.prefixWorks);
  check('the snippet marks the hit', /<mark>/.test(search.snippet), search.snippet);
  check('a quote in the query cannot break the MATCH expression', search.injectionCount === 0);

  const archive = await evaluate(`
    const { api, store } = window.__jotter;
    await api.setNoteArchived(${noteId}, true);
    await store.refreshNotes();
    const n = store.notes.find(x => x.id === ${noteId});
    await api.setNoteArchived(${noteId}, false);
    await store.refreshNotes();
    const back = store.notes.find(x => x.id === ${noteId});
    return { archived: n?.archived, restored: back?.archived === false, stillThere: !!back };
  `);
  check('completing a note archives it', archive.archived === true);
  check('nothing is destroyed — restoring brings it back', archive.restored && archive.stillThere);

  // 7 — delete is the one deliberate exception to all of the above. It is
  // permanent, it takes the note's actions with it, and it clears the stage.
  const deleted = await evaluate(`
    const { api, store } = window.__jotter;
    const before = (await api.listActions()).filter(a => a.note_id === ${noteId}).length;
    store.openNote(${noteId});
    await store.deleteNote(${noteId});
    const notes = await api.listNotes();
    const actions = await api.listActions();
    const hits = await api.searchNotes('actioned');
    return {
      hadActions: before > 0,
      noteGone: !notes.some(n => n.id === ${noteId}),
      actionsGone: !actions.some(a => a.note_id === ${noteId}),
      indexGone: !hits.some(h => h.id === ${noteId}),
      stageLeft: store.activeKey !== 'note:${noteId}'
    };
  `);
  check('the deleted note had actions to take with it', deleted.hadActions);
  check('delete removes the note permanently', deleted.noteGone);
  check('delete takes the note actions with it', deleted.actionsGone);
  check('the search index drops a deleted note', deleted.indexGone);
  check('the stage leaves a note that was deleted under it', deleted.stageLeft);

  // 8 — the board's model: a column says where the work is, the checkbox says
  // whether it is finished, and neither one is allowed to answer the other's
  // question. There is no Done column; completion folds a card away in place.
  const board = await evaluate(`
    const { api, store } = window.__jotter;
    await store.refreshBoard();
    await store.setBoardSort('manual');

    const first = store.visibleStages[0];
    const second = store.visibleStages[1] ?? first;
    const created = await api.createAction('board probe', null, null, null);
    await store.refreshActions();
    const landed = store.actions.find(a => a.id === created.id);

    // a move is a move
    await store.moveAction(created.id, second.id, [created.id]);
    const moved = store.actions.find(a => a.id === created.id);

    // completing leaves it exactly where it was
    await store.toggleAction(created.id, true);
    const ticked = store.actions.find(a => a.id === created.id);
    const foldedAway = !store.cardsIn(second.id).some(a => a.id === created.id);
    const underDisclosure = store.completedIn(second.id).some(a => a.id === created.id);

    await store.toggleAction(created.id, false);
    const unticked = store.actions.find(a => a.id === created.id);
    const backOnTheBoard = store.cardsIn(second.id).some(a => a.id === created.id);

    // projects are their own vocabulary
    const proj = await api.createProject('E2E project', '#4b86a3');
    await store.setActionProject(created.id, proj.id);
    const tagged = store.actions.find(a => a.id === created.id);

    // a column that gets hidden hands its cards to the first visible one
    const parked = await api.createStage('E2E parked');
    await store.refreshBoard();
    await store.moveAction(created.id, parked.id, [created.id]);
    const movedCount = await api.updateStage(parked.id, 'E2E parked', true);
    await store.refreshBoard();
    await store.refreshActions();
    const rehomed = store.actions.find(a => a.id === created.id);

    return {
      seeded: store.stages.length >= 1,
      noFinishColumn: store.stages.every(s => !s.is_done),
      newCardIsFirst: landed.stage_id === first.id && landed.done === false,
      moveIsJustAMove: moved.stage_id === second.id && moved.done === false,
      completesInPlace: ticked.done === true && ticked.stage_id === second.id,
      foldedAway, underDisclosure,
      reopensInPlace: unticked.done === false && unticked.stage_id === second.id,
      backOnTheBoard,
      projectSet: tagged.project_id === proj.id,
      noteLabelUntouched: tagged.label_id === null,
      hideMoved: movedCount === 1,
      rehomedToVisible: rehomed.stage_id === first.id
    };
  `);
  check('the board seeds at least one column and no finish column', board.seeded && board.noFinishColumn);
  check('a new action starts in the first column', board.newCardIsFirst);
  check('moving a card says nothing about whether it is done', board.moveIsJustAMove);
  check('completing a card leaves it in its own column', board.completesInPlace);
  check('it drops out of the open cards', board.foldedAway);
  check('and turns up under that column completed disclosure', board.underDisclosure);
  check('unticking puts it back in the same column', board.reopensInPlace && board.backOnTheBoard);
  check('an action carries its own project', board.projectSet);
  check('a project does not touch the source note label', board.noteLabelUntouched);
  check('hiding a column reports how many cards it moved', board.hideMoved);
  check('those cards land in the first visible column', board.rehomedToVisible);

  // 9 — the Planner-shaped board: a card you can open, a tick on its face,
  // columns the user creates, moves and deletes from the board itself, and a
  // sort that orders the cards inside every column at once.
  const planner = await evaluate(`
    const { api, store } = window.__jotter;
    await store.setActionsView('board');
    store.openActions();
    await store.refreshBoard();
    await store.refreshActions();
    await new Promise(r => setTimeout(r, 220));

    const first = store.visibleStages[0];
    const card = await api.createAction('planner probe', null, null, null);
    await store.refreshActions();

    // notes survive the round trip
    await store.setActionNotes(card.id, 'context that the one line cannot hold');
    const noted = store.actions.find(a => a.id === card.id);

    // the detail panel renders, and it is a track beside the board, not over it
    store.openCard = card.id;
    await new Promise(r => setTimeout(r, 320));
    const panel = document.querySelector('.panel');
    const cols = [...document.querySelectorAll('.col')].map(c => c.getBoundingClientRect().right);
    const panelLeft = panel ? panel.getBoundingClientRect().left : 0;
    const panelOpens = !!panel;
    const panelClears = panel ? cols.every(r => r <= panelLeft + 1) : false;

    // clicking off a card puts the panel away
    document.querySelector('.board').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 220));
    const panelCloses = !document.querySelector('.panel');
    store.openCard = null;

    // every column offers its own add, in its header
    const plusInHeader = document.querySelectorAll('.col-head .plus').length === store.visibleStages.length;
    const noBottomAdd = document.querySelectorAll('.add input').length === 0;

    // columns: create, rename, move, delete
    await store.addStage('E2E staging');
    const made = store.stages.find(s => s.name === 'E2E staging');
    await store.renameStage(made.id, 'E2E holding');
    const renamed = store.stages.some(s => s.id === made.id && s.name === 'E2E holding');

    const orderBefore = store.stages.map(s => s.id).join(',');
    await store.moveStage(made.id, -1);
    const orderAfter = store.stages.map(s => s.id).join(',');

    // deleting a column relocates its cards rather than stranding them
    await store.moveAction(card.id, made.id, [card.id]);
    const parked = store.actions.find(a => a.id === card.id).stage_id === made.id;
    await store.deleteStage(made.id);
    const gone = !store.stages.some(s => s.id === made.id);
    const rehomed = store.actions.find(a => a.id === card.id).stage_id === first.id;

    // sorting orders the cards inside every column
    await store.setActionDue(card.id, '2000-01-01');
    await store.setBoardSort('due');
    const dues = store.cardsIn(first.id).map(a => a.due_date);
    const dated = dues.filter(d => d !== null);
    const dueSorted = dated.every((d, i) => i === 0 || dated[i - 1] <= d);
    const nullsLast = dues.slice(dated.length).every(d => d === null);
    await store.setBoardSort('manual');
    await store.setActionDue(card.id, null);

    // the one escape hatch for a card typed by mistake
    await store.deleteAction(card.id);
    const cardGone = !store.actions.some(a => a.id === card.id);

    await store.setActionsView('list');
    return {
      noted: noted.notes === 'context that the one line cannot hold',
      panelOpens, panelClears, panelCloses,
      plusInHeader, noBottomAdd,
      renamed,
      moved: orderBefore !== orderAfter,
      parked, gone, rehomed,
      dueSorted, nullsLast, cardGone
    };
  `);
  check('an action carries notes of its own', planner.noted);
  check('clicking a card opens its detail panel', planner.panelOpens);
  check('the panel narrows the board instead of covering a column', planner.panelClears);
  check('clicking off a card puts the panel away', planner.panelCloses);
  check('every column adds from its own header', planner.plusInHeader && planner.noBottomAdd);
  check('a column can be renamed from the board', planner.renamed);
  check('a column can be moved along the board', planner.moved);
  check('a card can be parked in a new column', planner.parked);
  check('deleting a column removes it', planner.gone);
  check('its cards move to the first column', planner.rehomed);
  check('sorting by due date orders the cards in a column', planner.dueSorted);
  check('a card with no due date sorts last, not first', planner.nullsLast);
  check('an action can be deleted outright', planner.cardGone);

  // 10 — a span and its material: a start date beside the due date, and files
  // kept with the action. Attachments are content-addressed, so the same bytes
  // attached twice are stored once; detaching drops the link, never the file.
  const kept = await evaluate(`
    const { api, store } = window.__jotter;
    const card = await api.createAction('attachment probe', null, null, null);
    await store.refreshActions();

    // the two ends of a span are independent writes
    await store.setActionStart(card.id, '2026-09-01');
    await store.setActionDue(card.id, '2026-09-10');
    const spanned = store.actions.find(a => a.id === card.id);
    await store.setActionStart(card.id, null);
    const cleared = store.actions.find(a => a.id === card.id);
    await store.setActionStart(card.id, '2026-09-01');

    // a paste: bytes and a name, both from the clipboard
    const png = [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137];
    const shot = await api.saveAttachment(card.id, 'screenshot.png', png);
    const deck = await api.saveAttachment(card.id, 'plan.pptx', [80,75,3,4,20,0,6,0,8,0]);

    // the same bytes under a different name are one file on disk, two rows
    const again = await api.saveAttachment(card.id, 'copy.png', png);
    const sameFile = again.file === shot.file;

    // a name that is really a path never becomes one
    const nasty = await api.saveAttachment(card.id, '..\\\\..\\\\startup\\\\evil.pptx', [1,2,3,4]);
    const nameKept = nasty.name === 'evil.pptx';
    const pathIsHash = /^[0-9a-f]{64}\\.pptx$/.test(nasty.file);

    let list = await api.listAttachments(card.id);

    await store.refreshActions();
    const counted = store.actions.find(a => a.id === card.id).attach_count === list.length;

    // Jotter stores an executable but will not launch one
    const exe = await api.saveAttachment(card.id, 'installer.exe', [77,90,144,0]);
    let refused = false;
    try { await api.openAttachment(exe.id); } catch (e) { refused = String(e).includes('will not launch'); }

    // detaching removes the row. The count below was taken without the
    // executable, so dropping it and one more leaves one fewer than that.
    const before = list.length;
    await api.deleteAttachment(exe.id);
    await api.deleteAttachment(again.id);
    list = await api.listAttachments(card.id);
    const detached = list.length === before - 1 && !list.some(t => t.id === exe.id);

    // the panel renders what is attached
    await store.setActionsView('board');
    store.openActions();
    await store.refreshBoard();
    store.openCard = card.id;
    await new Promise(r => setTimeout(r, 340));
    const thumbs = document.querySelectorAll('.att.img img').length;
    const chips = document.querySelectorAll('.att:not(.img) .body').length;
    const startInput = document.querySelector('input[aria-label="Start date"]');
    const startShown = startInput ? startInput.value === '2026-09-01' : false;
    store.openCard = null;

    // deleting the action takes its attachment rows with it
    await store.deleteAction(card.id);
    const orphans = (await api.listAttachments(card.id)).length;

    await store.setActionsView('list');
    return {
      spanned: spanned.start_date === '2026-09-01' && spanned.due_date === '2026-09-10',
      startClears: cleared.start_date === null && cleared.due_date === '2026-09-10',
      shotIsImage: shot.kind === 'image' && /^[0-9a-f]{64}\\.png$/.test(shot.file),
      deckIsFile: deck.kind === 'file' && deck.name === 'plan.pptx',
      sameFile, nameKept, pathIsHash, counted, refused, detached,
      thumbs, chips, startShown, orphans
    };
  `);
  check('an action carries a start date as well as a due date', kept.spanned);
  check('clearing the start leaves the due date alone', kept.startClears);
  check('a pasted image is stored under the hash of its bytes', kept.shotIsImage);
  check('any other file is kept as a file, under its own name', kept.deckIsFile);
  check('the same bytes attached twice are stored once', kept.sameFile);
  check('a file name that is a path is shown, never used as one', kept.nameKept && kept.pathIsHash);
  check('the card counts its attachments without a call per card', kept.counted);
  check('Jotter stores an executable but refuses to launch it', kept.refused);
  check('detaching removes the link', kept.detached);
  check('images render as thumbnails and other files as chips', kept.thumbs === 1 && kept.chips === 2);
  check('the panel shows the start date it was given', kept.startShown);
  check('deleting an action takes its attachment rows with it', kept.orphans === 0);

  // 11 — a link is not a copy. A file that came from a place keeps its place;
  // only the clipboard's own pixels are ever stored. Written from Node so the
  // linked file can be deleted underneath the app, which is the failure this
  // mode has to survive out loud.
  const linkDir = join(tmpdir(), 'jotter-e2e-links');
  mkdirSync(linkDir, { recursive: true });
  const livePath = join(linkDir, 'rollout notes.md').replace(/\\/g, '/');
  const doomedPath = join(linkDir, 'moved later.txt').replace(/\\/g, '/');
  const absentPath = join(linkDir, 'not-here.md').replace(/\\/g, '/');
  writeFileSync(livePath, '# rollout\n');
  writeFileSync(doomedPath, 'this file is about to move\n');

  const linked = await evaluate(`
    const { api, store } = window.__jotter;
    const card = await api.createAction('link probe', null, null, null);

    const [live] = await api.linkPaths(card.id, ['${livePath}']);
    const [doomed] = await api.linkPaths(card.id, ['${doomedPath}']);

    // the bytes were never taken: a linked row has no file of ours
    const noCopy = live.file === '' && live.mode === 'linked';
    const pointsAtIt = live.src.toLowerCase().endsWith('rollout notes.md');
    const sized = live.bytes > 0;

    // a screenshot has no place to point at, so it is kept
    const png = [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82];
    const shot = await api.saveAttachment(card.id, 'pasted.png', png);
    const keptIsKept = shot.mode === 'kept' && shot.file.endsWith('.png');

    // linking something that is not there refuses rather than recording a lie
    let refusedMissing = false;
    try { await api.linkPaths(card.id, ['${absentPath}']); }
    catch (e) { refusedMissing = String(e).includes('cannot read'); }

    const before = await api.listAttachments(card.id);
    const liveOk = before.find(t => t.id === live.id)?.missing === false;

    return {
      cardId: card.id, doomedId: doomed.id, liveId: live.id,
      noCopy, pointsAtIt, sized, keptIsKept, refusedMissing, liveOk,
      count: before.length
    };
  `);
  check('a linked file is pointed at, not copied', linked.noCopy && linked.pointsAtIt);
  check('the link remembers how big the file was', linked.sized);
  check('pasted pixels are still kept, because they came from nowhere', linked.keptIsKept);
  check('linking a file that is not there is refused', linked.refusedMissing);
  check('a live link does not report itself missing', linked.liveOk);

  // move the file out from under the app
  rmSync(doomedPath, { force: true });

  const broken = await evaluate(`
    const { api, store } = window.__jotter;
    const rows = await api.listAttachments(${linked.cardId});
    const gone = rows.find(t => t.id === ${linked.doomedId});
    let saidSo = false;
    try { await api.openAttachment(${linked.doomedId}); }
    catch (e) { saidSo = String(e).includes('not where it was linked'); }

    // the note side of the same idea: a chip carries a path and never an href.
    // Untrusted markup (the default) can never mint one at all — only a
    // caller that says keepFileChips, meaning "this is the app's own content",
    // gets a chip preserved.
    const forgedChip = '<a class="jt-file" data-jt-file="C:/x/plan.pptx" href="javascript:alert(1)">plan.pptx</a>';
    const forgedChipDropped = (() => {
      const out = window.__jotter.sanitizeHtml(forgedChip);
      return !out.includes('jt-file') && !out.includes('data-jt-file') && out.includes('plan.pptx');
    })();
    const clean = window.__jotter.sanitizeHtml(forgedChip, { keepFileChips: true });
    const chipKeepsPath = clean.includes('data-jt-file="C:/x/plan.pptx"') && !clean.includes('href');
    const emptyChipUnwrapped = !window.__jotter
      .sanitizeHtml('<a class="jt-file" data-jt-file="">nothing</a>', { keepFileChips: true })
      .includes('jt-file');

    // the clipboard answers with a list, whatever it happens to be holding
    const clip = await api.clipboardFilePaths();

    // an executable is not launched from a note either
    let noLaunch = false;
    try { await api.openLinkedPath('C:/Windows/System32/cmd.exe'); }
    catch (e) { noLaunch = String(e).includes('will not launch'); }

    await store.deleteAction(${linked.cardId});
    return {
      missing: gone?.missing === true,
      stillListed: !!gone,
      saidSo, forgedChipDropped, chipKeepsPath, emptyChipUnwrapped, noLaunch,
      clipIsList: Array.isArray(clip)
    };
  `);
  check('a link whose file moved says so', broken.missing && broken.stillListed);
  check('and opening it explains rather than failing silently', broken.saidSo);
  check('untrusted markup cannot forge a file chip', broken.forgedChipDropped);
  check('the app\'s own content keeps a chip\'s path and never gets an href', broken.chipKeepsPath);
  check('a chip with no path is unwrapped back into text', broken.emptyChipUnwrapped);
  check('a note will not launch an executable either', broken.noLaunch);
  check('the clipboard answers with a list of paths', broken.clipIsList);

  rmSync(linkDir, { recursive: true, force: true });

  console.log('');
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
};

run()
  .catch((e) => {
    console.error(`e2e aborted: ${e.message}`);
    process.exitCode = 1;
  })
  // The open CDP socket keeps the event loop alive, so the process has to let
  // go of it explicitly or the run looks hung after it has finished reporting.
  .finally(() => {
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
    process.exit(process.exitCode ?? 0);
  });
