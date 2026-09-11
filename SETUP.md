# Setting Jotter up on a new machine

Written to be followed top to bottom by a person or by a coding agent (Claude Code,
Copilot, Cursor) inside VS Code. Every step has a command that proves it worked;
do not move on until the check passes.

Jotter is **Windows-only**. It is a Tauri v2 app: a Rust host plus a Svelte frontend
rendered in the WebView2 runtime Windows already ships. There is no macOS or Linux
build, and the paste-a-file path uses a Windows clipboard API directly.

---

## 0. What you need first

| Requirement | Why | Check |
|---|---|---|
| Windows 10 (1803+) or 11 | WebView2 ships with the OS | `winver` |
| Node.js ≥ 22 | Vite 8 requires it | `node -v` |
| npm ≥ 10 | ships with Node | `npm -v` |
| Rust stable ≥ 1.82 (MSVC toolchain) | the host is Rust | `rustc --version` |
| Visual Studio C++ Build Tools | Rust on Windows links with MSVC | see step 3 |

### 1. Node

```powershell
winget install -e --id OpenJS.NodeJS.LTS
```

Close and reopen the terminal, then check:

```powershell
node -v
```

Must print `v22.x` or higher.

### 2. Rust

```powershell
winget install -e --id Rustlang.Rustup
```

Close and reopen the terminal, then check:

```powershell
rustc --version; rustup default
```

`rustup default` must name a `-msvc` toolchain (e.g. `stable-x86_64-pc-windows-msvc`).
If it says `-gnu`, fix it:

```powershell
rustup default stable-x86_64-pc-windows-msvc
```

### 3. MSVC build tools

This is the step that is skipped and then breaks the build with `link.exe not found`.

```powershell
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

**This raises a UAC prompt** — it is a machine-wide install and cannot be done silently
without one. It takes several minutes and downloads a few GB.

If Visual Studio 2022 (not just the Build Tools) is already installed, open the Visual
Studio Installer instead and add the **Desktop development with C++** workload.

Check — from a *new* terminal:

```powershell
Get-ChildItem "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022" -Recurse -Filter link.exe -ErrorAction SilentlyContinue | Select-Object -First 1
```

One path printed = good. Nothing printed = the workload is missing.

### 4. WebView2

Present by default on Windows 11 and on updated Windows 10. Check:

```powershell
Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue | Select-Object pv
```

A version number = installed. Nothing = install it:

```powershell
winget install -e --id Microsoft.EdgeWebView2Runtime
```

---

## 5. Get the code

```powershell
git clone https://github.com/Supabert/Jotter.git
cd Jotter
npm install
```

`npm install` pulls only the frontend. The Rust crates come down on the first build.

---

## 6. Run it

**From source, with hot reload:**

```powershell
npm run start
```

The first run compiles SQLite from source and takes **5–15 minutes** with no output for
long stretches. That is normal, not a hang. Later runs are seconds. The window opens by
itself when the Rust side finishes.

**As an installed app:**

```powershell
npm run release
```

The installer lands in `src-tauri\target\release\bundle\nsis\Jotter_0.1.0_x64-setup.exe`.
It installs per-user, so running it raises no UAC prompt.

---

## 7. Confirm it actually works

1. The window opens with a sidebar and an empty note.
2. Type something. Press `Ctrl+N` — a second note appears in the sidebar.
3. Select a sentence and press `Ctrl+Shift+A` — it turns into a row on the Actions page
   (`Ctrl+0`).
4. Check the data landed:

```powershell
Get-ChildItem "$env:USERPROFILE\Documents\Jotter"
```

`jotter.db` must exist. That directory is created on first launch under *your* user
profile — nothing in the repo hardcodes anyone's path.

---

## Where your data lives

```
%USERPROFILE%\Documents\Jotter\
  jotter.db            SQLite, WAL
  images\<sha256>.png  pasted images, content-addressed
  backups\             written by Settings → Back up now
```

Deleting that folder resets the app to empty. Nothing else on the machine is touched:
the app makes **no network calls of any kind**, has no accounts, and no telemetry.

---

## When it fails

| Symptom | Cause | Fix |
|---|---|---|
| `error: linker 'link.exe' not found` | step 3 skipped | install the C++ workload, open a new terminal |
| `error: Microsoft Visual C++ 14.0 or greater is required` | same | same |
| Vite refuses to start / wrong Node | Node < 22 | upgrade Node |
| `Port 1425 is already in use` | another Jotter dev server is running | close it, or `Get-NetTCPConnection -LocalPort 1425` and stop that process |
| Window never appears, no error | Rust still compiling | wait; watch `src-tauri\target\debug` grow |
| App opens but pasted images do not show | data dir moved outside `Documents\Jotter` | the asset scope is `$DOCUMENT/Jotter/**`; keep it there |
| A second instance does nothing | by design — single instance focuses the first window | — |

---

## Notes for an agent doing this unattended

- `winget` steps 1–3 each need a **fresh terminal** afterwards; PATH changes do not reach
  an already-running shell. Re-running `node -v` in the same session will keep failing.
- Step 3 raises UAC and cannot be suppressed. Tell the human before triggering it.
- Do not run `npm run start` with a timeout under 20 minutes on a cold clone.
- Do not set `JOTTER_DATA_DIR` for a normal install. It exists for the end-to-end test
  scripts, and pointing a test run at the real database risks the one permanent delete
  the app has. See the README for the full test-run recipe.
- Nothing here needs credentials, a `.env`, or any service. If a step asks for one,
  something is wrong.
