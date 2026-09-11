# Jotter — design record

The visual world, the rules that hold it together, and the decisions that are
already settled. Read this before changing anything you can see.

## The world

**Cockpit quick-reference handbook.** Neutral machined grey; flat planes
separated by hairlines; legends in condensed caps; colour used only to report
state. A printed checklist read inside a lit panel.

This is a deliberate refusal of two defaults. Not the notes-app look — cream or
near-black ground, Inter, rounded cards, pastel label dots, a floating pill
toolbar. Not terminal brutalism either — no green-on-black, no ASCII framing, no
monospace body text.

Direction chosen from a grounded candidate roll, position 5 of 7, seed key
`bff48d50`. The roll ran degraded (egress blocked, no challenger set), so the
direction is committed rather than compared.

## Night and day are lighting, not a preference

An instrument panel has day lighting and night lighting. Both grounds are
neutral grey — R, G and B equal at every step — so the chrome carries no hue in
either lighting and nothing drifts warm or cool as it changes. A grey that is
off-neutral is a defect. `--panel-0` is the deepest plane, `--panel-3` the
highest; a note page sits on `--panel-2` so it reads as an inset plane, not a
floating card.

The greys were neutral from the second revision. The first shipped with a faint
green cast, which read as a tint rather than as lighting.

Every colour in the app is a token in [`src/lib/design/tokens.css`](src/lib/design/tokens.css).
There are no hard-coded colours in components, and adding one is a defect.
The two swatch lists that name literal hex — the highlight palette in
`FormatRail.svelte` and the label default in `SettingsPage.svelte` — are content
the user picks from, not chrome.

The resolved lighting lives in `store.lighting`, not in the DOM. Reading
`document.documentElement.dataset.theme` back out is not a reactive dependency;
the status strip did exactly that and reported the lighting it was born with
forever.

## Colour is annunciator state only

| Tone | Means |
|---|---|
| `--anc-green` | complete, filed, stowed |
| `--anc-amber` | pending, due today, unsaved |
| `--anc-white` | advisory |
| `--anc-red` | overdue, and today's line on the chart |

If a colour appears anywhere it is not reporting a state, that is a bug. Label
colours are the one exception, and they are the user's own vocabulary rather
than the app's. Project colours are the same exception on the timeline, and
they ride the group header's thumb tab — never a bar, because a bar's colour is
only ever its state.

Red does double duty on the chart and it is the same statement twice: the
vertical line is today, and anything left of it that is not ticked is late. An
overdue card on the board and an overdue bar on the chart are one derived fact
(`isOverdue`), computed on every render and never written down, so fixing a
date un-reddens both with no second write to forget.

## Form rules

- **Radius never above 3px.** `--r: 2px` for controls, `--r-lg: 3px` for panels.
- **1px hairlines separate planes.** Not shadows. The only depth cue in the app
  is a single 1px inset top highlight (`--bezel`) on raised surfaces.
- **No webfonts, ever.** Bahnschrift is Microsoft's DIN and ships with Windows;
  it carries every legend. Body text is Segoe UI Variable Text, numerals and
  keyboard hints are Cascadia Mono. Nothing is downloaded, so nothing can be
  slow, and nothing leaves the machine.
- **Legends are condensed caps**, `--wdth-legend`. Sentence-case belongs to
  content, never to chrome.
- **One edge mechanism.** A row's colour edge is the 3px thumb-tab column, the
  same in the pinned Actions row as in every note row. A `border-left` accent on
  one side of a card is the single most recognisable tell of generated UI; the
  detector flags it, and it is not how this sidebar works.

## Motion

Three durations only: `--dur-blip` 90ms for annunciator acknowledgement,
`--dur-fast` 130ms for controls, `--dur-base` 200ms for panels. One easing.
Transform and opacity only — nothing in the app animates layout. Every duration
collapses to 0ms under `prefers-reduced-motion`.

The one piece of characterful motion is the blip on the Actions row when a new
action is filed: two beats of the caution wash, then it settles. An annunciator
acknowledging a new condition, not a notification bouncing.

## Layout invariants

- The editor column is `flex: 0 1 820px` inside a stretched flex row. It is not
  a grid: `min-height: 100%` on a grid item resolves against the item's own size
  and constrains nothing.
- Conditional children and fixed grid tracks do not mix. The editor wrap was
  `auto auto 1fr` with a find bar that is usually absent, so the sheet landed in
  the second `auto` track and stopped at the height of its text while the `1fr`
  track sat empty below it. It is a flex column now.
- A percentage `max-width` inside an `auto` grid track is circular and the
  browser resolves it by collapsing the track. The palette's shortcut column
  died this way, showing `C…` where `Ctrl+N` belongs.
- The timeline's four panes are wired by hand, not by `position: sticky`. Only
  the chart body has real scrollbars; the ruler mirrors its `scrollLeft` and the
  row labels mirror its `scrollTop`. Sticky freezes one of the two, never both
  at once against a single scroller.
- Weekend banding and week rules are painted, not built. Both repeat with a
  period of exactly seven days, so each is one `repeating-linear-gradient`
  rather than a thousand elements — which is what lets a two-year day view stay
  cheap. Month and quarter boundaries are not periodic, so those rules are real
  elements, and there are only ever a few dozen of them.

## Mode

**Operate.** The visitor is completing a task, so scanability, consistency and
Windows expectations outrank expression. Brand lives in the hairlines, the
legends and the annunciators — never in an illustration, a gradient or a hero.

Concretely: the density is a list, not a feed. Nothing is centred that could be
left-aligned. Every destination has a keyboard route, and every keyboard route
is printed next to its command in the palette.

## Copy

Legends are nouns and states, not sentences: `SAVED`, `ARCHIVED HIDDEN`,
`5 OPEN · 1 OVERDUE`. Verbs appear on things you press. The app never says
"deleted" for the everyday case, because completing a note does not delete it;
it says **stowed**. The word *delete* is reserved for the one control that
really does destroy something, and that control always says **permanently**.

## What is settled and should not be relitigated

| Decision | Why |
|---|---|
| Completing stows, it never deletes | `Ctrl+Enter` strikes a note through and archives it, reversibly, and stows its open actions with it. This is what happens to notes the user is finished with. |
| Delete exists, in exactly one place | A permanent delete on the sidebar row: the same bin, clicked twice, taking the note's actions with it. The row must not change height or move a control between the two clicks — a confirmation the user has to re-aim at is a worse confirmation. It disarms on `Esc`, on a click anywhere in the row, on arming another row, and by itself after five seconds. There is no delete on the Actions page, no delete for labels, no delete command in the palette and no keyboard shortcut for it. The user asked for an absolute escape hatch; an escape hatch is not a workflow. |
| One list, no tab strip | The sidebar is the list of open things. A tab bar above it repeated the same names in a second place, so `Ctrl+Tab` now walks the sidebar in its visible order and `Ctrl+W` goes back to whatever was underneath. |
| The board and the checklist are one list | The Actions page is read as a list or as a board; both render the same rows, and completion is one field on one row. |
| A column is a place, a checkbox is a state | Finishing a card does not move it. It stays in the column it was worked in and folds under that column's `Show completed`. The board answers "where is this work happening"; the checkbox answers "is it finished". A Done column makes the board answer both, and then the two answers can disagree. |
| Columns are the user's words | Stages are named, reordered, added, hidden and deleted by the user. Hiding or deleting one empties it into the first visible column and says how many cards moved. One guard: the last column cannot go, because a new action has to be created somewhere. |
| Sorting is a lens, not a rewrite | `Sort` orders the cards inside every column — by hand, by due date, by project — and only the hand-sorted order is ever written to the database. Under a computed sort a within-column drag has nothing to write, so it does not pretend to. A card with no due date sorts last: no date is not "due first". |
| A card opens, it does not just sit there | Clicking a card opens a detail panel beside the board — wording, column, project, due date and notes. The panel is a grid track, not a layer: opening a card narrows the board rather than covering the finish column, which is the one you most want to see while moving something towards it. |
| The most common act is on the face of the card | A tick sits on every card. Completing something is what happens to it most often, and the most common act should not require opening anything. It is the same write as the checklist box. |
| Columns are operated where they live | Rename by clicking the name, drag the header to move, `⋯` for move / hide / delete, `+ Add column` at the end of the board, and `+` in a header to add an action to the top of that column. Settings keeps the fuller editor; the board is not a read-only rendering of a list configured somewhere else. |
| The chart draws only facts | A row appears on the timeline when it carries a date, and nothing invents one. An action with both dates is a bar; with one, a milestone; with neither, it is not drawn — and the header prints how many are not drawn, because a timeline that silently omits work is a timeline you cannot trust. |
| A bar and a milestone are the same row in two states | A milestone's handle, pulled outwards, creates the date it does not have and it becomes a bar. A bar's start edge, pushed past its own deadline, clears the start and it collapses back to a milestone. One gesture and its exact reverse, so nothing needs a form to change shape. |
| A drag is one write, and it offers an undo | A dragged bar can move through time and into another project at once; both go in together and are reported once. Confirmation before a drag would make the common case pay for the rare one, so the reversal is offered afterwards instead — for the five seconds the toast is on screen, and never queued. |
| Three views, three orders | `sort_order` is the checklist's hand-sort, `board_order` a position in a kanban column, `timeline_order` a position in a project group. The three views group by different things, so one number cannot carry all three intentions, and making it try means tidying the chart silently reshuffles the board. |
| The chart groups by project, the board by stage | A column says where work is happening; a project says what work it is part of. The timeline bands by project because a schedule is read by what the work is for. Dropping a bar into another band re-files it; the rollup over each band is computed from its children and is never grabbable, because a summary is a reading of its rows and not a row of its own. |
| The wheel zooms, the hand pans | On the chart a wheel notch steps Day → Week → Month → Quarter, anchored so the day under the cursor stays under it — without that, a notch throws the viewport to an unrelated week and reads as the chart breaking. Panning is grab-and-drag on empty canvas, both axes. The row-label column keeps the ordinary meaning of a wheel, so scrolling the rows never needs the mouse to be somewhere specific. |
| The week starts on Monday | Weekends are drawn, not skipped: a gap where Saturday should be makes a five-day bar look like a week. Every rule falls before a Monday and the canvas always begins on one, which is what lets the banding be a repeating background with no phase to get wrong. |
| Today is a fact that changes | The red line and every overdue red are recomputed from `store.today`, which re-arms itself at each midnight. This app sits in the tray for weeks; a date decided at launch would quietly start lying and nothing on screen would move. |
| An action has a span, not just a deadline | `start_date` sits beside `due_date`, both nullable and set independently, because the two are decided at different moments and neither implies the other. Nothing invents a start: a chart drawn from these rows has to be readable as true, and a start filled in on the user's behalf would be a fabricated fact. A start later than its own due date is flagged in place and still accepted. |
| A file that came from a place keeps its place | Anything with a path — copied in Explorer, or chosen in the picker — is **linked**: the path is recorded and the bytes are never touched. Only the clipboard's own pixels are **kept**, because a screenshot has nowhere to point at. The cost of a link is that it can break, so a stale one is shown in red with the remembered path, never left to fail on click. |
| Attachments are content-addressed, and their names are never paths | A file kept with an action is stored under the SHA-256 of its bytes, so the same deck attached to four actions is written once. The row carries the name the user knows it by; only the hash is ever a path. Detaching drops the link, never the bytes — another action may address the same hash. Jotter stores an executable and refuses to launch one: a notes app is not a launcher, and one click is not enough deliberation for running something. |
| A preview is a reminder, not the content | A pasted image is capped — 108px on a card's attachment strip, 320px inside a note — because it is there to remind you what the work is about, not to become the page. Full size is always one click (or one double-click) away, and it opens the stored file rather than a copy. |
| A card is paper on the column | A small, low shadow, and one more pixel of lift on hover. Enough to read as a physical thing that can be picked up; never enough to become the thing you look at. Finished cards lie flat: no shadow, no lift, muted ink. |
| Delete has exactly two addresses | The sidebar bin for a note, and the detail panel for an action. Both are the same idiom: the same control clicked twice, in place, disarming on `Esc` or after five seconds. The action delete exists because the board can create a card directly, and a card typed by mistake needs a way out that is not pretending you finished it. |
| A project is not a label | A label says where a note lives; a project says what work an action is part of. Separate tables, separate lists in Settings, and an action captured in a Scratch note can still belong to real work. Merging them would make one list answer two questions badly. |
| `Ctrl+Shift+A` makes an action | `Ctrl+A` is select-all in every context, forever. |
| WYSIWYG, not markdown | The user asked for WordPad, not a markdown editor. |
| Data in Documents, not %APPDATA% | The user's call: notes are documents and should be where documents are. |
| Zero webfonts | Offline, instant, and more on-world than anything downloadable. |
| Escape keeps the draft | It hides the capture window without filing. The draft is written on every keystroke, so the reflexive key costs nothing and does not litter the sidebar. |

## Verification

`scripts/e2e.mjs` drives the real app over CDP against real SQLite — assertions
covering sanitisation, path traversal, FTS injection, image dedupe, the archive
round-trip, and that delete really does take the note, its actions and its
search-index row with it. `scripts/shots.mjs` drives the same app into every
reviewable state and screenshots it.

`scripts/timeline-test.mjs` unit-tests the chart's arithmetic with no app at
all — Node strips the types itself, so there is no test runner and no new
dependency. It runs the conversions under five timezones on purpose:
`new Date('2026-03-01')` parses as UTC midnight and reports its *local* parts,
which in America/Chicago answers "February 28" and puts every bar one day to
the left. Under one timezone that bug is invisible.

`scripts/timeline-e2e.mjs` drives the chart's gestures as **real input**
(`Input.dispatchMouseEvent`) rather than as synthetic events on an element. The
board's card drag is HTML5 drag-and-drop, which CDP cannot deliver end to end —
proving a drop there needs the physical cursor and `scripts/real-drag.ps1`. The
chart is built on pointer capture, so a drag, a resize, a pan and a wheel-zoom
are all drivable headless. That testability was a reason to choose pointer
events, not a side effect of having done so.

A test build has to run beside the installed one, and doing that needs its own
`WEBVIEW2_USER_DATA_FOLDER` as well as its own `JOTTER_DATA_DIR`. Both builds
carry the identifier `com.fortuvia.jotter` and therefore share one WebView2
profile, and the second process to start attaches to the browser process the
first already created — silently dropping its own arguments, including the
debugging port. The failure has no error in it: the app opens, the database is
correct, and the CDP port is simply not there. See the README for the three
variables.

Screenshots go through CDP, never PrintWindow. WebView2 serves unchanged regions
of the Windows compositor surface from cached tiles, which returned a light
editor beside a dark sidebar after a theme flip and, later, whole frames two
states behind. The DOM was correct every time; the capture was not. Any visual
defect found in a screenshot gets measured against computed style before it gets
"fixed".
