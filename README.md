# Jotter

A Windows desktop replacement for Notepad. Rich text, images, colour-labelled
notes, and a pinned Actions page you feed by highlighting a sentence.

Local only. No accounts, no sync, no telemetry, **no network calls of any kind**.
Completing something stows it rather than deleting it.

## Install

1. Download `Jotter_<version>_x64-setup.exe` from the
   [latest release](https://github.com/Supabert/Jotter/releases/latest).
2. Run it. The installer is not code-signed, so Windows SmartScreen says
   **"Windows protected your PC"** — click **More info**, then **Run anyway**.
3. It installs for your Windows user only, so there is no admin prompt. Launch Jotter
   from the Start menu; after that, `Ctrl+Alt+N` anywhere in Windows opens quick capture.

Needs 64-bit Windows 10 (1803 or later) or Windows 11. Jotter renders in WebView2,
which Windows 11 ships with; if a Windows 10 machine lacks it, the installer fetches
it, which needs an internet connection that one time.

There is no auto-update: a new version is a new installer from the releases page, run
over the old one. Uninstall from **Settings → Apps → Installed apps**. Your notes live
in `Documents\Jotter\`, and uninstalling leaves them where they are.

## Build from source

On a machine that has never built this before, follow [`SETUP.md`](SETUP.md) first —
it covers Node, the Rust MSVC toolchain and WebView2, with a check after every step.

Development — hot reload on the frontend, Rust rebuild on backend changes:

```bash
npm run start
```

Production installer (`src-tauri/target/release/bundle/nsis/`):

```bash
npm run release
```

First `cargo` build takes a few minutes because SQLite is compiled in; later builds
are seconds. The release script maps your user-profile path out of the binary — Rust
embeds source paths in panic messages — so an installer carries no trace of the
machine it was built on.

### Running a test build beside the one you use

```bash
$env:JOTTER_DATA_DIR="$([Environment]::GetFolderPath('MyDocuments'))\Jotter\e2e-timeline"
$env:WEBVIEW2_USER_DATA_FOLDER="C:\Temp\jotter-dev-webview"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333"
npm run start
```

All three matter, and two of them are not obvious:

- **`JOTTER_DATA_DIR`** points the run at its own database. Without it a test run
  writes into your real notes, and the one delete that exists is permanent. Keep it
  under `Documents\Jotter\` — the asset-protocol scope is `$DOCUMENT/Jotter/**`, so
  a data dir anywhere else silently fails to show any image. Setting it also lifts
  the single-instance guard, since a run on its own database is not a rival for the
  one you are using.
- **`WEBVIEW2_USER_DATA_FOLDER`** gives the run its own browser profile. Both builds
  share the identifier `com.fortuvia.jotter`, so they share one WebView2 user data
  folder — and the second one to start **attaches to the browser process the first
  one already made and silently drops its own arguments**. The debugging port then
  never opens, with no error anywhere: the app runs, the database is right, and
  `/json/list` simply refuses the connection.
- **`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`** opens the CDP port the test scripts
  drive. It only takes effect on the process that actually creates the browser,
  which is what the line above is for.

## Where your notes live

```
%USERPROFILE%\Documents\Jotter\
  jotter.db            SQLite, WAL
  images\<sha256>.png  every pasted image, content-addressed
  backups\             written by Settings → Back up now
```

Images are keyed by the hash of their bytes, so pasting the same screenshot into ten
notes stores one file. Note HTML records only the file name — never an absolute path —
so a note stays portable and the store can move.

`jotter.db` normally runs in WAL mode; if `Documents\Jotter` is itself a network path or
lives inside a OneDrive-synced folder, Jotter switches to a single-file journal instead,
because the `-wal`/`-shm` files WAL keeps alongside it are exactly what a sync client can
upload out of order — the usual way a synced SQLite database corrupts.

## Keyboard

| Key | Action |
|---|---|
| `Ctrl+N` | New note |
| `Ctrl+W` | Back to whatever was open before |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous note, in sidebar order |
| `Ctrl+1`–`Ctrl+8`, `Ctrl+9` | Nth note in the sidebar, last note |
| `Ctrl+A` | Select all — unchanged, forever |
| **`Ctrl+Shift+A`** | **Turn the selection into an action** |
| `Ctrl+Enter` | Complete this note and stow it |
| `Ctrl+K` | Command palette |
| `Ctrl+P` | Quick-switch note |
| `Ctrl+F` | Find in this note |
| `Ctrl+Shift+F` | Search every note |
| `Ctrl+0` | Open Actions |
| `Ctrl+Shift+B` | Actions as a list or as a board |
| `Ctrl+Shift+G` | Actions as a timeline |
| `Ctrl+B` / `I` / `U` | Bold / italic / underline |
| `Ctrl+Shift+X` | Strikethrough |
| `Ctrl+Shift+8` / `Ctrl+Shift+7` | Bullet list / numbered list |
| `Ctrl+[` / `Ctrl+]` | Smaller / bigger text |
| `Ctrl+Space` | Clear formatting |
| `Ctrl+Shift+E` | Show or hide archived |
| `F11` | Focus mode |
| `Ctrl+,` | Settings |
| **`Ctrl+Alt+N`** | **Quick capture — works anywhere in Windows** |

## What it does that Notepad cannot

**Actions.** Highlight a sentence inside any note and press `Ctrl+Shift+A`. It becomes
a checkable row on the pinned Actions page, and the sentence keeps its place in the
note with a caution rule under it. Clicking the row jumps back to that exact line.
Completing it strikes it through in both places and stows it.

**A board, when a list is not enough.** `Ctrl+Shift+B` reads the same actions as a
kanban board. The columns are yours: `+ Add column` at the end of the board, rename
one by clicking its name, drag its header to move it, and use its `⋯` menu to move,
hide or delete it. `+` in a column's header adds an action straight to the top of it.

**There is no Done column.** Ticking a card finishes it where it is: it folds into
that column's `Show completed` at the bottom, and unticking it there puts it straight
back. The column keeps saying where the work happened; the checkbox says whether it
is finished.

Drag cards between columns and up and down inside one, or hold Alt and use the arrow
keys. `Sort` orders the cards inside every column at once — by hand, by due date or
by project.

Every card carries a tick on its face for the thing you do most, and clicking the
card opens it beside the board: its wording, its column, its project, a start date
and a due date, notes for whatever the one line cannot hold, and the files that go
with it. Deleting an action lives there too — permanent, two clicks, and the only
other delete in the app.

**Files live on the card, and mostly stay where they are.** Copy a file in
Explorer, open a card, and `Ctrl+V` — Jotter records *where it is* and never takes a
copy. `Link file` does the same through a picker. A screenshot pasted from the
clipboard is the one thing Jotter keeps, because pixels off the clipboard have no
place to point at. Notes work the same way: paste a copied file into a note and you
get a chip in the prose that opens it.

Images show as a capped thumbnail, everything else as a chip with its type and size;
clicking either opens it in whatever the system uses, and the card's face carries a
clip so you can see from the board that there is something to look at. A link that
has gone stale says so in red rather than failing quietly. Detaching removes the
link and never the file.

Two deliberate limits. Jotter will not launch executables — use *Show in folder* and
open them yourself. And a file's name is only ever shown, never used as a path, so a
name like `..\..\startup\x.lnk` is just a name.

There is no drag-and-drop from Explorer, and there cannot be: on Windows the
OS-level drop target and in-page HTML5 dragging are mutually exclusive, and dragging
cards around the board is worth more. Copying a file puts its path on the clipboard,
which is why paste does the same job.

Actions also carry a **project**, which is their own list, not the note labels. A
label says where a note lives; a project says what work an action is part of, so
something scribbled in a Scratch note can still belong to real work. Set it from the
list row or the card, filter the board by it, or group the list by it.

**Quick capture.** `Ctrl+Alt+N` from anywhere pops a small always-on-top box. Type,
press `Ctrl+Enter`, it files as a new note and disappears. `Esc` puts the box away
without filing — the draft is written to disk on every keystroke and comes back the
next time you summon it, so nothing typed into it can be lost either way.

**Completing stows; it does not delete.** Completing a note or an action strikes it
through and archives it; `Ctrl+Shift+E` shows the archive. Labels can be hidden,
never removed.

**One thing really does delete.** Hover a note in the sidebar and its row grows a
bin. Click it once to arm: the bin fills red and the line under the title says what
will go. Click the same bin again and the note, its actions and its search-index row
are gone for good. Nothing moves between the two clicks — same button, same pixel.
Anything else disarms it: `Esc`, clicking the row, arming a different row, or five
seconds of nothing.

There is no undo, and it is the only control in the app that destroys anything: no
delete on the Actions page, none for labels, none in the palette, and no key bound
to it.

**A timeline, when the question is *when*.** `Ctrl+Shift+G` reads the same actions
as a Gantt chart, banded by project. An action with a start and a due date is a bar;
one with a single date is a diamond; one with no dates is not drawn at all, and the
header says how many are not drawn — the chart only ever shows dates you set.

Drag a bar's body to move both dates together, or either edge to move that end
alone. Drag it up or down to reorder it, or into another project's band to re-file
it. Pull the handle beside a diamond and it becomes a bar; push a bar's start past
its own deadline and it collapses back to a diamond. Every drag offers an `Undo` for
five seconds afterwards, because a slipped pointer should not cost you two dates.
Arrow keys move a focused bar a day; `Shift` with them moves its deadline.

Grab any empty part of the chart and drag to pan it in both directions. The wheel
zooms — Day, Week, Month, Quarter — around whatever day is under the cursor. `Range`
sets how far back and how far forward the chart reaches, or `Fit` spans the work
instead. Weekends are drawn rather than skipped, weeks start on Monday, and a red
line marks today and moves with it.

**Overdue is red everywhere.** An action past its due date and not ticked turns its
card red on the board and its bar red on the chart. It is worked out from the date
every time it is drawn and never stored, so fixing the date clears it at once.

## Architecture

```
src/                  Svelte 5 + TypeScript, compiled by Vite
  lib/design/         tokens.css + panel.css — the whole visual system
  lib/editor/         contenteditable commands and the paste allowlist
  lib/timeline/       scale.ts — the chart's date arithmetic, pure and tested
  lib/components/     sidebar, editor, actions, settings, overlays
src-tauri/            Rust host
  src/db.rs           schema + migrations, WAL, FTS5
  src/notes.rs        note commands, full-text search
  src/actions.rs      the checklist, spans, and the timeline's row order
  src/images.rs       content-addressed image store
  src/settings.rs     labels, settings, backup
  src/lib.rs          window, tray, global hotkey, single instance
```

Tauri v2 over Electron because this app sits open all day: it renders in the WebView2
runtime Windows already ships, so there is no second Chromium in memory.

### Why `execCommand`

The editor formats with `document.execCommand`, which is formally deprecated. It is
also the only formatting API every Chromium ships with working undo integration, and a
real editor engine would cost 200 KB+ and a document model this app has no use for.
The trade was made deliberately. WebView2 is Chromium; the surface used here is the
part nothing has ever removed.

### Paste safety

Pasting from a browser drops arbitrary markup into a WebView. Everything entering or
leaving the editor passes through a DOMPurify allowlist — tags, attributes, class
names, and individual CSS properties. Pasted `<img src>` is always discarded; the
image bytes are re-imported through the Rust side instead.

## Design

The interface is built in one committed visual world, "Panel & QRH" — a cockpit
quick-reference handbook. Matte instrument greige, 1px hairlines, one inset bezel
highlight as the only depth cue, and colour used exclusively as annunciator state:
green complete, amber pending, white advisory, red overdue.

It is not decoration. Never-delete is checklist protocol, colour labels are the
handbook's thumb-tab dividers, and light/dark is a panel's day and night lighting
rather than a preference bolted on.

Type is entirely system-supplied — Bahnschrift (Microsoft's DIN, the industrial legend
face) for panel labels, Segoe UI Variable for note bodies, Cascadia Mono for counts.
No webfonts, so nothing loads and nothing can fail to load.

Full decisions: [`docs/superpowers/specs/2026-08-26-jotter-design.md`](docs/superpowers/specs/2026-08-26-jotter-design.md).

## License

[MIT](LICENSE).
