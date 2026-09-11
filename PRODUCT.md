# Jotter

## What it is

A local Windows desktop app that replaces Notepad for a single user on a single machine.
Rich-text scratchpad + notebook. Zero cloud, zero telemetry, zero accounts.

## Who uses it

One person per install. Built for its author's own daily use and shared as-is: not a
commercial product, no onboarding funnel, no pricing, no multi-user anything. Design for
a power user who will use this every single day for years and who has extremely high UI
standards.

## The job it does

Two jobs that Notepad does badly or not at all:

1. **Throwaway capture.** A thought arrives while doing something else. It must be
   captured in under two seconds without breaking focus, and never lost.
2. **Durable notes.** Some of those scraps turn out to matter. They need formatting,
   images, organisation by color label, and search — without ever migrating to a
   different app.

Plus one job Notepad cannot do at all:

3. **Turn a sentence into a task.** Highlight a line inside any note, press
   `Ctrl+Shift+A`, and it becomes a checkable action on a pinned Actions page that
   remembers where it came from.

## Platform

web

The UI renders as web (HTML/CSS/JS inside WebView2), shipped as a Windows 11 desktop
app via Tauri v2 (Rust host). Single resizable window plus a tray icon and a global
capture hotkey. It is not a responsive website: one machine, desktop viewport only,
mouse + keyboard, no touch, no mobile breakpoints.

## Non-negotiables

- **Completion stows, it never deletes.** Completing a note or an action strikes it
  through and archives it; the archive hides rather than removes. This is the path
  for everything the user is finished with.
- **Delete exists in exactly one place.** A permanent delete on the sidebar row —
  the same bin clicked twice, no modal and no re-aiming — taking the note's actions
  with it. Nowhere else:
  not the Actions page, not labels, not the palette, not a key. It is an escape
  hatch for the rare absolute case, and it must never grow into a workflow.
- **The board is a view, not a second app.** Actions are one list of rows. The
  checklist, the board and the timeline read the same rows, and any state any of
  them can set — finished, project, dates, order — is written once, in one
  place. Each view keeps its own row order, because they group by different
  things; nothing else is duplicated.
- **The chart never invents a date.** A bar on the timeline is drawn only from
  dates the user set. Work with no dates is not placed on a guess — it is left
  off and counted, so the chart can be read as true.
- **Never lose a keystroke.** Autosave is continuous and invisible. There is no Save
  command, no dirty-state prompt, no "unsaved changes" dialog, ever.
- **Resource-cheap.** This app is open all day. Idle RAM budget under 100 MB, cold
  start under 1.5 s, warm show from tray effectively instant.
- **Local only.** No network calls of any kind. Data lives in
  `%USERPROFILE%\Documents\Jotter\`.
- **Muscle memory is sacred.** Ctrl+N, Ctrl+W, Ctrl+Tab, Ctrl+A, Ctrl+F, Ctrl+B/I/U
  behave exactly as they do in every other Windows app.

## Tone

Quiet, fast, precise. The app is furniture, not a personality. It should feel like a
well-made tool: nothing decorative that does not also do work, but every surface
finished to a level that makes opening it pleasant on the thousandth day.

## Explicitly out of scope

Sync, sharing, export-to-cloud, collaboration, accounts, AI features, plugins,
mobile, markdown-source editing, file associations, opening arbitrary files from disk.
