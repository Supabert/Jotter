# Jotter — design spec

Date: 2026-08-26
Status: approved to build

## 1. What it is

A Windows desktop replacement for Notepad, for one user, on one machine. Rich-text
notes with images, a tabbed editor, a left sidebar of all notes, and a pinned Actions
page fed by highlighting a sentence and pressing `Ctrl+Shift+A`. Fully local, no
network, nothing ever deleted.

## 2. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Stack | Tauri v2 (Rust + WebView2) | ~40-70 MB idle vs Electron's 200-300 MB; app is open all day |
| Action key | `Ctrl+Shift+A` | `Ctrl+A` stays select-all, no muscle-memory landmine |
| Chrome | Tab strip + sidebar | Ctrl+W/Ctrl+Tab need something to close; note stays in sidebar |
| Deletion | None, anywhere | Complete → strikethrough + archive. No delete button exists |
| Data location | `%USERPROFILE%\Documents\Jotter\` | Visible, user-backupable |
| Format | WYSIWYG rich text, WordPad-grade | Explicitly not markdown |
| File associations | None | Notepad keeps `.txt`, VS Code keeps `.md`. Jotter is a closed world |
| Extras taken | Speed layer, Action layer | Safety layer superseded by never-delete |
| Name | Jotter | |

## 3. Visual direction — "Panel & QRH"

Chosen by the impeccable direction roll (seed key `bff48d50`, index 5 of 7 grounded
candidates). The roll ran **degraded** — no challengers, no quality-bar boards —
because impeccable's roll API is deliberately egress-blocked on this machine.

World: a cockpit quick-reference handbook. A printed checklist book read inside a lit
instrument panel.

Why it carries the product, not just decorates it:

- **Never delete** is checklist protocol. Items are struck and stowed, never removed
  from the book.
- **Every note and action is a state.** Instrument design is the most state-legible
  visual language that exists; annunciator colour is functional, never decorative.
- **Light/dark is literal.** Panels have day lighting and night lighting. The theme
  toggle is the physical fact, not a bolted-on preference.
- **Colour labels are thumb-tab dividers**, which is what a QRH actually uses to
  separate sections.

The rut this refuses: the Notion/Bear/Obsidian clone — cream or near-black ground,
Inter, rounded cards, pastel dots, floating pill toolbar. And its predictable
opposite, green-on-black terminal brutalism.

Honest risk: instrument aesthetics tip into sci-fi cosplay when materials glow.
Guard rails, binding on every screen: matte surfaces only, no glow, no neon, no
scanlines, no HUD reticles, no gradients as chrome, corner radius never above 3 px.
It is furniture.

### Tokens

Ground is a machined greige with a faint green cast — the colour of a real instrument
bezel. This is what keeps it off both cream and pure neutral grey.

```
NIGHT (dark)                      DAY (light)
--panel-0  #16181a  window        #d9dcd8
--panel-1  #1d2022  sidebar       #e3e6e2
--panel-2  #24282a  page plane    #f2f3f0
--panel-3  #2b2f31  raised chrome #eaece8
--hairline #34393b                #c2c7c1
--legend   #8d9699  labels        #5c6360
--ink      #e6eaeb  body text     #1a1d1c

ANNUNCIATORS (functional only)
--anc-green  complete
--anc-amber  action pending
--anc-white  advisory
--anc-red    overdue (the only red; nothing destructive exists)
```

### Type

| Role | Face | Note |
|---|---|---|
| Panel legends, UI, tabs | Barlow Semi Condensed 500/600, uppercase, +0.06em | bundled woff2, no network |
| Note body | Segoe UI Variable Text → Segoe UI | system, zero bytes, best Windows text rendering |
| Counts, timestamps, ids | JetBrains Mono | bundled woff2 |

Two registers is the point: condensed caps are panel legends, the body is the printed
page inside the panel.

### Material rules

1 px hairlines. A single 1 px inset top highlight on raised chrome — that is the bezel
read, and it is the only depth cue. No box-shadows. No border-radius above 3 px. Colour
appears only where it encodes state.

### First viewport

```
┌────────────┬──────────────────────────────────────────┐
│ SIDEBAR    │ TAB STRIP  (panel legend tabs)           │
│            ├──────────────────────────────────────────┤
│ ▌00 ACTIONS│ FORMAT RAIL (bold ital size colour list) │
│    ⬤ 3     ├──────────────────────────────────────────┤
│ ────────── │                                          │
│ ▌ pinned   │            THE PAGE                      │
│ ▌ notes    │   (panel-2 plane, hairline margin rule)  │
│   grouped  │                                          │
│   by label │                                          │
│   or date  │                                          │
│            ├──────────────────────────────────────────┤
│            │ STATUS STRIP  SAVED · 412 w · ARCHIVED ○ │
└────────────┴──────────────────────────────────────────┘
```

The pinned Actions row is tab `00` with a live amber count annunciator. The status
strip always reads `SAVED` in green, because there is no unsaved state to report.

### Signature interaction

`Ctrl+Shift+A` on a selection: the sentence lifts out of the page, the ACTIONS
annunciator blips amber once and increments. Completing it turns the annunciator
green, strikes the line through in both the Actions page and the source note, and
stows it into archive.

## 4. Architecture

```
Jotter/
  src/                 Svelte 5 + TypeScript + Vite  (compiles away; ~5 KB runtime)
    lib/
      db.ts            typed wrappers over Tauri commands
      editor/          contenteditable, toolbar, paste, sanitize
      sidebar/         list, grouping, sorting, labels
      actions/         Actions page, extraction, completion
      overlays/        command palette, search, settings
      design/          tokens.css, panel.css, motion.ts
  src-tauri/           Rust host
    src/
      main.rs          window, tray, global shortcut, single instance
      db.rs            rusqlite (bundled), migrations, WAL
      notes.rs         note commands
      actions.rs       action commands
      images.rs        content-addressed image store + jotter-img:// protocol
      settings.rs      settings + labels + backup
```

Svelte 5 over vanilla because the sidebar, tab strip, and Actions list are exactly the
list-rendering the framework pays for; runes compile to direct DOM ops with no virtual
DOM, so the resource budget survives. `rusqlite` is bundled so there is no system
SQLite dependency.

### Schema

```sql
notes    (id, title, body_html, body_text, label_id, pinned,
          archived, archived_at, created_at, updated_at)
labels   (id, name, color, sort_order)
actions  (id, text, note_id, anchor_id, done, done_at,
          archived, due_date, created_at, sort_order)
images   (hash PRIMARY KEY, ext, bytes, created_at)
settings (key PRIMARY KEY, value)
notes_fts -- FTS5 external-content over (title, body_text), trigger-synced
```

`body_text` is a plaintext mirror of `body_html`, written on every save, so full-text
search never has to parse HTML.

### Storage on disk

```
%USERPROFILE%\Documents\Jotter\
  jotter.db          SQLite, WAL, synchronous=NORMAL
  images\<sha256>.png    content-addressed → pasting the same image twice stores once
  backups\jotter-YYYY-MM-DD-HHMM.zip
```

Images are served to the WebView through a custom `jotter-img://<hash>` protocol
rather than filesystem paths, so note HTML stays portable and no absolute path leaks
into stored content.

### Autosave

Debounced 400 ms after the last keystroke, plus a forced flush on tab switch, window
blur, window hide, and quit. There is no Save command, no dirty indicator, and no
"unsaved changes" dialog anywhere in the app.

### Paste security

Pasting HTML from a browser injects arbitrary markup into a WebView. All pasted and
all loaded HTML goes through DOMPurify (bundled locally, no CDN) against a tag and
attribute allowlist. Pasted images are read as bytes from the clipboard and re-encoded
by the Rust side; the incoming markup's `src` is never trusted.

### Action anchoring

`Ctrl+Shift+A` wraps the selection in `<span class="jt-action" data-action-id="…">`
and inserts an `actions` row carrying `note_id` + `anchor_id`. Completion state is
**not** written back into the note HTML — the renderer looks up which anchor ids are
done and applies the strikethrough class at render time. One source of truth, no HTML
rewriting, no drift.

## 5. Keyboard map

| Key | Action |
|---|---|
| `Ctrl+N` | New note, opens a tab |
| `Ctrl+W` | Close tab (note stays in sidebar) |
| `Ctrl+Shift+T` | Reopen last closed tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+1`–`Ctrl+8`, `Ctrl+9` | Nth tab, last tab |
| `Ctrl+A` | Select all — unchanged, forever |
| `Ctrl+Shift+A` | Selection becomes an action |
| `Ctrl+F` | Find in this note |
| `Ctrl+Shift+F` | Search every note |
| `Ctrl+K` | Command palette |
| `Ctrl+P` | Quick-switch note |
| `Ctrl+B` / `I` / `U` | Bold / italic / underline |
| `Ctrl+Shift+X` | Strikethrough |
| `Ctrl+Shift+8` / `Ctrl+Shift+7` | Bullet list / numbered list |
| `Ctrl+[` / `Ctrl+]` | Font size down / up |
| `Ctrl+Shift+E` | Toggle show-archived |
| `Ctrl+,` | Settings |
| `F11` | Focus mode |
| `Esc` | Close overlay |
| `Ctrl+Alt+N` | **Global** quick capture, from anywhere in Windows |

## 6. Screens

**Editor** — tab strip, format rail, page, status strip. The page is a `panel-2` plane
inset into the window with a hairline margin rule.

**Actions** — pinned sidebar row `00`. Views: All / Today / Overdue / Done. Group by
source note, label, or due date. Each row: checkbox, text, source-note legend, optional
due date. Clicking a row opens the source note and flashes the anchor.

**Settings** — labels (add, rename, recolour, reorder), theme (system/light/dark),
global hotkey rebind, start with Windows, default font and size, data folder with
"Open data folder", and "Back up now".

**Quick capture** — frameless always-on-top 520×220 window on `Ctrl+Alt+N`. Type,
press `Ctrl+Enter`, it files as a new note and hides; `Esc` hides it without filing
and keeps the draft for the next summon. The draft is persisted
per keystroke, so even a crash cannot lose it.

## 7. Sidebar behaviour

Group by: none, label, or date bucket (Today / Yesterday / This week / This month /
Older). Sort by: updated, created, title, or label. Actions is pinned above everything;
user-pinned notes sit below it. Archived notes are hidden until `Ctrl+Shift+E`, then
shown struck through and dimmed. The list virtualizes past 200 notes.

## 8. Resource budget

Measured on the release build, 2026-08-26, against the demo data set.

| Metric | Target | Measured |
|---|---|---|
| Idle RAM (private working set) | < 100 MB | **85 MB** — 4 MB host + 81 MB WebView2 |
| Cold start to first window | < 1.5 s | **61 ms** median of three |
| Show from tray | perceptually instant | window is hidden, not closed |
| Installer | < 15 MB | **1.82 MB** NSIS, 4.67 MB binary |
| Network calls | zero, ever | zero — no webfonts, no CDN, no telemetry |

**Read private working set, not working set.** Task Manager's figure for the
WebView2 group came to 346 MB, because each of its six processes counts the same
shared Chromium pages again. Private working set is what this app actually costs
the machine. Measure it by delta — start with WebView2 running for the other
apps that use it, then subtract:

```powershell
Get-Counter '\Process(msedgewebview2*)\Working Set - Private'
```

Note bodies are lazy — the sidebar query selects id, title, label, and dates only.
No polling anywhere; the Rust side pushes events over a Tauri channel.

## 9. Explicitly out of scope

Sync, sharing, export to cloud, collaboration, accounts, AI features, plugins, mobile,
markdown source editing, file associations, opening arbitrary files from disk, and any
form of deletion.

## 10. Build order

| # | Chapter | Visible outcome |
|---|---|---|
| 1 | Scaffold + Rust core + schema | Window opens, DB created at the Documents path |
| 2 | Design system + shell | Panel & QRH tokens, sidebar, tab strip, status strip |
| 3 | Editor + autosave | Type a note, close the app, it is still there |
| 4 | Format rail + image paste | Bullets, sizes, colours, pasted screenshots |
| 5 | Actions | `Ctrl+Shift+A`, Actions page, complete → strike + stow |
| 6 | Labels, archive, sort/group, settings | Colour labels defined and applied |
| 7 | Tray, global hotkey, quick capture, autostart | `Ctrl+Alt+N` works from anywhere |
| 8 | Search + command palette | `Ctrl+K`, `Ctrl+Shift+F` |
| 9 | Motion, finish review, installer, private repo | Shipped |

The design system lands in chapter 2, not at the end — every component after it is
built inside the committed world rather than having a look applied over it.

---

## Amendment — 2026-08-27

Three changes after the first day of real use. The body of this spec is left as
written; where it disagrees with this section, this section is what shipped.

**Delete exists, in one place.** The sidebar row carries a permanent delete,
armed and confirmed in the row itself, which removes the note, its actions and
its search-index row. Completing a note still stows it and is still the
everyday path — the delete is an escape hatch, not a workflow, and there is no
delete on the Actions page, for labels, in the palette, or on any key. The
never-delete rule in the table above now reads as *completing never deletes*.

**No tab strip.** The sidebar already listed every note, so a tab bar above the
page showed the same names a second time. `Ctrl+Tab` / `Ctrl+Shift+Tab` now walk
the sidebar in its visible order — the same grouping and sort the user is
looking at — `Ctrl+1`–`Ctrl+9` pick the Nth row, and `Ctrl+W` goes back to
whatever was on the stage before. `Ctrl+Shift+T` is gone with the tabs. Focus
mode moved from the tab strip to the status strip.

**Neutral greys.** Both lightings dropped the faint green cast; R, G and B are
now equal at every step of both ramps. The cast read as a tint rather than as
lighting.

## Amendment — 2026-08-27, board

Actions gained a board view and a project of their own. The list view is
untouched; everything below is additive.

**Projects are their own table**, managed in Settings beside labels. A label
answers "where did I write this" and a project answers "what work is this part
of" — an action captured in a Scratch note can still belong to a real project,
which is exactly the case a single shared vocabulary handles badly. An action's
project is set from either view, on the row or on the card.

**Columns are the user's own.** `stages` are named, reordered, added and hidden
from Settings. Exactly one stage carries `is_done`; setting it on one clears it
on the others, so "finished" always has a single address. Hiding a column moves
its cards into the first open column and reports how many moved, rather than
leaving them addressed to a column nobody can see. New columns are inserted
before the finish column, because a column to the right of "Done" sits past the
end of the workflow it belongs to.

**The checkbox and the finish column are one fact.** `set_action_done` moves the
action's stage; `move_action` sets done, archived and done_at. Both directions
are asserted end-to-end. This is the whole reason stages live in the database
next to `done` rather than as a second, parallel notion of progress.

**Ordering is per view.** `sort_order` is the checklist's hand-sorted order and
`board_order` is the column's; a drag in one view does not renumber the other.
A drop writes the destination column's entire order back, so a dropped event
cannot leave two cards claiming one slot — and it writes the unfiltered order,
because writing back a filtered subset would renumber those cards on top of the
ones the project filter is hiding.

**Every drag has a keyboard route.** Each card carries a grip: Alt+←/→ walks it
across columns, Alt+↑/↓ moves it within one. A board that only a mouse can
operate is a board that half of this app cannot reach.

`Ctrl+Shift+B` switches the Actions page between list and board, and the choice
is remembered.

## Amendment — 2026-08-27, the board as an instrument you can work

Two things came back from a day of use: the Settings page could not be scrolled,
and the board was a rendering rather than a place to work. Both are fixed here.

**The Settings clipping was a grid track, not a scroll container.** `.app` had
`grid-template-columns` and no `grid-template-rows`, so its single implicit row
was `auto`, and an `auto` row cannot shrink below a grid item's automatic
minimum size. `.main` had visible overflow, so its minimum was its content
height: the row grew to 1496px inside a 760px window and `body` clipped it, with
nothing left to scroll. The row is now written out as `minmax(0, 1fr)` and
`.main` carries `min-height: 0`. Measured before and after, not looked at.

**The board took Microsoft Planner's shape**, at the user's request. What that
meant concretely:

- A card opens. Clicking one shows its wording, column, project, due date and
  notes in a panel beside the board. The panel is a grid track rather than an
  overlay, so opening a card narrows the board instead of covering the finish
  column — the column you most want in view while moving something towards it.
- Actions gained `notes` (schema V3), because "look into the action" needs
  something to look at that the one line could not already hold.
- A tick lives on the face of every card. Completing is the most common thing
  anyone does to a card and should not require opening it. It is the same write
  as the checklist box, and the existing invariant carries it.
- Columns are operated where they live: rename in the header, drag the header to
  reorder, a `⋯` menu for move / hide / set-as-finish / delete, and an add rail
  at the end of the board. Settings keeps the fuller editor.
- A column can now be deleted, not only hidden. Its cards are relocated first and
  the count is reported. Two guards: the finish column cannot go, because
  `is_done` is where "finished" is written; the last open column cannot go,
  because a new action has to be created somewhere.
- An action can be deleted. The board can create a card directly now, so a card
  typed by mistake needed a way out that is not pretending you finished it. Same
  two-click idiom as the sidebar bin, in the detail panel only.

**The e2e harness had been attaching to the wrong window.** It took the first
CDP page target, which is the quick-capture window whenever that is open. The
capture window shares the dev bridge, so every store-level assertion passed
against it while every DOM assertion would have failed for the wrong reason —
and the first DOM assertions in the suite are the ones added here. It now probes
each target for the main window's own root element, the way `probe.mjs` always
did.

## Amendment — 2026-08-27, the board after using it

Seven things came back from using the Planner-shaped board, and two of them were
defects with the same shape: the gesture never reached the page.

**Drag and drop did nothing, and none of it was the drag code.** Three separate
causes stacked:

1. Tauri's `dragDropEnabled` defaults to on, and on Windows that hands drag over
   to the webview's OS-level drop target — HTML5 drag inside the page never
   begins. Nothing here uses Tauri's file-drop event, so it is now off.
2. The column title was a `<button>`. Chromium will not start an element drag
   from a form control, so the one grip a user reaches for first was the one
   place a drag could not start. It is a `<span role="button">` now, and the
   header carries `user-select: none` so a press-and-move does not start a text
   selection instead.
3. `effectAllowed = 'move'` at the source with no `dropEffect` named on the
   targets. `preventDefault` says a drop *may* happen; `dropEffect` says which
   one. Without it Chromium resolves the operation to none and delivers
   `dragend` to the page instead of `drop`: the card lifts, the target lights
   up, and releasing does nothing.

A fourth, found while testing: the card handlers called `stopPropagation` before
checking what was being dragged, so a column dropped onto another column's cards
was swallowed. Inner handlers now bail out on a non-card drag and let it bubble.

**Verified with real OS-level mouse input**, not synthetic events. `scripts/
dragprobe.mjs` drives CDP's drag interception, which proves a gesture *starts* a
drag; `scripts/real-drag.ps1` moves the physical cursor over the real window,
which is the only thing that proves a drop lands. A drag left pending under CDP
interception wedges the renderer and every later drag silently fails to start —
that looks exactly like the bug being tested for, and is not.

**The Done column is gone.** Completing a card no longer moves it: it stays in
the column it was worked in and folds under that column's `Show completed`,
which expands, and unticking a card there returns it in place. A board with a
Done column answers "what is finished" twice, once with a checkbox and once with
a position, and the user only ever wanted the first. `set_action_done` writes
`done`, `done_at` and `archived` and nothing else; `move_action` writes
`stage_id` and nothing else. V4 rehomes every card out of the old finish column
and deletes it.

**Sorting is a lens.** `Sort` orders the cards inside every column at once — by
hand, by due date, by project — and only the hand-sorted order is ever written.
Under a computed sort a within-column drag has nothing to write, so it does not
pretend to; a drop still changes the column. A card with no due date sorts last,
because no date is not "due first".

**Smaller ones.** The detail panel closes on a click anywhere that is not a card
or the panel — a `pointerdown` check, so clicking straight from one card to the
next swaps rather than closes. Cards took a small, low shadow and a one-pixel
hover lift, and finished cards lie flat. The per-column add moved out of the
bottom of the column and into a `+` in its header, which opens a compose field
at the top, where new work should land.

## Amendment — 2026-08-27, dates and material (V5)

Two asks, one of them pointed at a feature that does not exist yet: a start
date on actions, because a Gantt chart was planned as the next upgrade; and the
ability to paste images and attach files to a card.

**A span, not a deadline.** `actions.start_date` sits beside `due_date`. Both
are nullable, both are written by their own command, and neither implies the
other — an action with only a deadline stays the normal case. Nothing invents a
start date. A chart drawn from these rows is only worth reading if every bar on
it is a fact the user actually stated, and a start filled in on their behalf
would not be. A start later than its own due date is flagged where it is typed
("Starts after it is due") and still accepted: it is almost always a typo, and
it is also the user's business.

**Attachments are content-addressed, and a file name is never a path.** The
`attachments` table points an action at a file in `Documents\Jotter\files\`
whose name on disk is the SHA-256 of its bytes — the same rule the pasted-image
store has used since V1, so the same deck attached to four actions is written
once and no reference counting is needed. The row carries the name the user
knows the file by; that string is shown and never resolved, which is what makes
`..\..\startup\x.lnk` harmless. The extension is reduced to at most twelve
ASCII alphanumerics before it can reach the filesystem.

This is the first table in the schema that cascades. An attachment is a property
of its action rather than a thing in its own right, so a deleted action must not
leave rows pointing at nothing. The bytes stay: another action may address the
same hash, and this store has never deleted a file it was given.

**Jotter stores an executable and refuses to launch one.** `open_attachment`
hands the file to the shell except for a blocklist (`exe`, `ps1`, `lnk`, `js`,
`reg`, …), which returns an error naming *Show in folder* instead. A notes app
is not a launcher, and one click inside a card is not enough deliberation for
running something. The file itself is still stored, still attached, and still
one Explorer window away.

**A preview is a reminder, not the content.** Attached images render capped at
108px on the card's strip; images pasted into a note gained a 320px cap, because
a screenshot at full column width pushed the prose off the screen. Both open
full size on click (double-click in the note), and both open the stored file
rather than a copy.

**Paste goes where the user is looking.** `Ctrl+V` with a card open attaches the
clipboard's files; text still pastes as text, and a paste inside the note editor
still belongs to the editor. `attach_path` exists so the file picker can hand
back a path and have the backend do the reading — that keeps the filesystem
plugin off the frontend entirely.

The board shows a clip and a count on any card that has attachments. The count
comes down with the action row itself, counted in the same query, so the board
never issues a request per card to find out.

## Amendment — 2026-08-27, links instead of copies (V6)

The ask: drag files into the capture pop-up or onto a note and have Jotter attach
a link to the file — no copy; the file stays wherever it came from.

**The gesture is not available on Windows, and that was measured rather than
assumed.** An Explorer→app file drop needs an OS-level drop target, which is what
Tauri's `dragDropEnabled: true` installs — and that target also swallows drags
that begin *inside* the page, which is how cards move between columns. Same
drag, same coordinates, same idle machine, twice:

| Build | Card dragged To do → Doing |
|---|---|
| `dragDropEnabled: false` | moved |
| `dragDropEnabled: true` | did not move |

So they are mutually exclusive here, and dragging cards is used constantly while
dropping a file is occasional. Cards win. (A first attempt at this test ran
while the machine was in use and *both* arms failed — a physical-input test is
noise unless nothing else is touching the mouse, and a failing control is the
only thing that reveals it.)

**Copying gives the same thing.** When a file is copied in Explorer, Windows
puts its **path** on the clipboard as `CF_HDROP` — not its bytes. So `Ctrl+V`
with a card open links the file, and the file stays where it is. Pasting into a
note inserts a chip in the prose that opens the same file. The rule the two
modes follow:

> If it came from a **place**, remember the place. If it came from the clipboard
> as pixels, there is no place to point at, so keep the bytes.

**A link can break, and that has to be visible.** Every listing stats the linked
paths — one `stat` per row — and a stale link is drawn in red with `moved` where
its size would be, keeping the remembered path in its tooltip. Opening it says
where it used to be rather than failing quietly. The row is never deleted on the
user's behalf: what broke is the link, and the name is the only remaining clue
about what it pointed at.

**Previews of linked images without opening the disk.** `convertFileSrc` is
gated by the asset protocol scope, and widening that scope to the filesystem to
show a thumbnail would be trading the whole boundary for a convenience. Instead
each linked file is granted individually with `asset_protocol_scope().allow_file`,
and the grants are replayed at startup from the rows themselves — so the app's
reach is exactly the set of files the user linked, and nothing else, ever.

**A path in a note is not a URL.** The chip carries `data-jt-file` and never an
`href`; on click the path goes to the Rust side, which checks the file is still
there and applies the same never-launch blocklist. A chip that arrives from
outside with no path is unwrapped back into plain text.

⚠️ **DOMPurify drops an attribute whose value looks like a URI with an unknown
scheme — and `C:/notes/plan.pptx` is exactly that.** The attribute vanished
before the sanitizer's own hook could read it, which read as "the sanitizer
strips my chip" and was really "the drive letter looks like a protocol". Naming
it in `ADD_URI_SAFE_ATTR` skips that check, which is sound because the value
never becomes a URL.
