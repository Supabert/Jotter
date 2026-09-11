//! Files kept with an action: a pasted screenshot, a deck, a markdown file.
//!
//! Storage follows the pasted-image store's rule — the name on disk is the
//! SHA-256 of the bytes, so the same file attached to four actions is written
//! once and no reference counting is needed. The row carries the name the user
//! knows the file by; that name never reaches the filesystem, which is what
//! makes a crafted `..\..\startup\x.lnk` harmless.

use crate::error::{Error, Result};
use crate::models::Attachment;
use crate::AppState;
use tauri::Manager;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::State;

/// 128 MB. Large enough for a deck or a video clip, small enough that a
/// misdirected paste cannot quietly fill the disk.
const MAX_BYTES: usize = 128 * 1024 * 1024;

/// Extensions Jotter will not hand to the shell. The file can still be stored,
/// attached and revealed in Explorer — it just will not be launched from a
/// single click inside a notes app. Opening one is a decision that belongs in
/// Explorer, where the user can see what they are running.
const NEVER_LAUNCH: &[&str] = &[
    "exe", "bat", "cmd", "com", "scr", "pif", "ps1", "psm1", "msi", "msp", "vbs", "vbe", "js",
    "jse", "wsf", "wsh", "hta", "cpl", "reg", "lnk", "url", "jar", "dll", "sys", "inf", "scf",
    "py", "pyw", "pyc", "pyz", "ahk", "msc", "rdp", "settingcontent-ms", "application",
    "appref-ms", "chm", "diagcab", "iso", "img", "vhd", "vhdx", "theme", "themepack",
    "library-ms", "search-ms", "searchconnector-ms", "website", "msix", "msixbundle", "appx",
    "appxbundle", "appinstaller", "xll", "wsc", "sct", "vb", "ws", "psc1", "ps1xml", "ps2",
    "ps2xml", "mst", "gadget", "shs", "hlp", "cab", "msh", "msh1", "msh2", "mshxml", "msh1xml",
    "msh2xml", "jnlp", "xbap",
];

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "avif"];

/// The extension is taken from the user's file name, then reduced to something
/// that cannot be a path: ASCII alphanumerics only, at most 12 of them. A name
/// with nothing usable after the dot is stored without an extension at all.
fn safe_ext(name: &str) -> Option<String> {
    let raw = name.rsplit_once('.')?.1.to_ascii_lowercase();
    let ok = !raw.is_empty()
        && raw.len() <= 12
        && raw.bytes().all(|b| b.is_ascii_alphanumeric());
    ok.then_some(raw)
}

fn display_name(name: &str) -> String {
    // Only the last component, and never empty: this string is shown, and a
    // name carrying directory separators would read as a path the app does not
    // actually have.
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name)
        .trim()
        .to_string();
    if base.is_empty() {
        "attachment".into()
    } else {
        base
    }
}

/// The launch decision, made from the file Windows will actually open — never
/// from a name that is only ever displayed. Win32 silently strips trailing
/// dots and spaces off a path before it opens it, so `calc.exe.` and
/// `calc.exe ` are `calc.exe` by the time the shell sees them even though a
/// naive split on the last `.` finds no extension at all. So this looks at
/// the real path's own final component, not at whatever a database row or a
/// forged chip claims the file is called — and it never touches the
/// filesystem, so it can run before an `exists()`/metadata call that would
/// otherwise be the first thing to ask a remote or device path a question.
fn blocked_launch(path: &Path) -> Option<String> {
    let raw = path.to_string_lossy();
    if raw.starts_with(r"\\.\") || raw.starts_with(r"\\?\GLOBALROOT") {
        return Some("a device path".into());
    }
    let name = path.file_name()?.to_string_lossy().into_owned();
    let trimmed = name.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return None;
    }
    // A colon here is an alternate-data-stream marker (`x.txt:evil.exe`), not
    // an extension — refuse rather than try to parse one out of it.
    if trimmed.contains(':') {
        return Some("an alternate data stream".into());
    }
    let ext = Path::new(trimmed).extension()?.to_str()?.to_ascii_lowercase();
    NEVER_LAUNCH
        .contains(&ext.as_str())
        .then(|| format!(".{ext} files"))
}

fn files_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("files")
}

/// The one place a stored file's path is built. Nothing outside this function
/// turns a database row into a filesystem location, and the stem is re-checked
/// here rather than trusted from the row.
fn path_of(state: &AppState, file: &str) -> Result<PathBuf> {
    let (stem, ext) = match file.split_once('.') {
        Some((s, e)) => (s, Some(e)),
        None => (file, None),
    };
    let valid = stem.len() == 64
        && stem.bytes().all(|b| b.is_ascii_hexdigit())
        && ext.is_none_or(|e| e.len() <= 12 && e.bytes().all(|b| b.is_ascii_alphanumeric()));
    if !valid {
        return Err(Error::Msg("bad attachment reference".into()));
    }
    Ok(files_dir(state).join(file))
}

/// A linked file is checked every time it is listed. The check is one `stat`
/// per row and it is the whole point of the mode: a link that has gone stale
/// has to say so, because the alternative is a row that silently opens nothing.
fn row_to_attachment(state: &AppState, r: &rusqlite::Row) -> rusqlite::Result<Attachment> {
    let file: String = r.get(3)?;
    let mode: String = r.get(7)?;
    let path: Option<String> = r.get(8)?;

    let (src, missing) = if mode == "linked" {
        let p = path.unwrap_or_default();
        let gone = !std::path::Path::new(&p).exists();
        (p, gone)
    } else {
        (
            files_dir(state).join(&file).to_string_lossy().into_owned(),
            false,
        )
    };

    Ok(Attachment {
        id: r.get(0)?,
        action_id: r.get(1)?,
        name: r.get(2)?,
        file,
        kind: r.get(4)?,
        mode,
        bytes: r.get(5)?,
        created_at: r.get(6)?,
        missing,
        src,
    })
}

const SELECT: &str = "SELECT id, action_id, name, file, kind, bytes, created_at, mode, path
                      FROM attachments";

fn store(state: &AppState, action_id: i64, name: &str, bytes: &[u8]) -> Result<Attachment> {
    if bytes.is_empty() {
        return Err(Error::Msg("empty file".into()));
    }
    if bytes.len() > MAX_BYTES {
        return Err(Error::Msg(format!(
            "that file is {} MB; the limit is 128 MB",
            bytes.len() / 1_048_576
        )));
    }

    let name = display_name(name);
    let ext = safe_ext(&name);
    let kind = match ext.as_deref() {
        Some(e) if IMAGE_EXTS.contains(&e) => "image",
        _ => "file",
    };

    let hash = {
        let mut h = Sha256::new();
        h.update(bytes);
        format!("{:x}", h.finalize())
    };
    let file = match &ext {
        Some(e) => format!("{hash}.{e}"),
        None => hash.clone(),
    };

    let dir = files_dir(state);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(&file);

    if !path.exists() {
        // Same two-step as the image store: write a sibling, then rename, so a
        // crash mid-write can never leave a truncated file sitting under a hash
        // that claims to be complete.
        let tmp = dir.join(format!("{hash}.part"));
        {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &path)?;
    }

    let conn = state.conn.lock().unwrap();
    let created_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO attachments (action_id, hash, file, name, kind, bytes, created_at, mode)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'kept')",
        rusqlite::params![action_id, hash, file, name, kind, bytes.len() as i64, created_at],
    )?;
    let id = conn.last_insert_rowid();

    Ok(Attachment {
        id,
        action_id,
        name,
        file: file.clone(),
        kind: kind.into(),
        mode: "kept".into(),
        bytes: bytes.len() as i64,
        created_at,
        missing: false,
        src: dir.join(&file).to_string_lossy().into_owned(),
    })
}

/// Point at a file instead of taking a copy of it.
///
/// Nothing is read but the metadata. The path is what gets stored, and the file
/// goes on living wherever the user put it — which is the whole request: no
/// copy, and the file stays wherever it came from.
///
/// The asset protocol is told about this one file so a linked image can be
/// previewed. That grant is per-file and in memory only; `allow_linked` rebuilds
/// it at startup from the rows themselves, so the app never has standing access
/// to anything the user did not link.
fn link(app: &tauri::AppHandle, state: &AppState, action_id: i64, path: &str) -> Result<Attachment> {
    let p = std::path::Path::new(path);
    let meta = std::fs::metadata(p)
        .map_err(|_| Error::Msg(format!("cannot read {}", display_name(path))))?;
    if meta.is_dir() {
        return Err(Error::Msg(format!(
            "{} is a folder. Attach the files inside it.",
            display_name(path)
        )));
    }

    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| display_name(path));
    let kind = match safe_ext(&name).as_deref() {
        Some(e) if IMAGE_EXTS.contains(&e) => "image",
        _ => "file",
    };
    let absolute = std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().trim_start_matches(r"\?").to_string())
        .unwrap_or_else(|_| path.to_string());

    let created_at = chrono::Utc::now().to_rfc3339();
    let id = {
        let conn = state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO attachments (action_id, hash, file, name, kind, bytes, created_at, mode, path)
             VALUES (?1, '', '', ?2, ?3, ?4, ?5, 'linked', ?6)",
            rusqlite::params![action_id, name, kind, meta.len() as i64, created_at, absolute],
        )?;
        conn.last_insert_rowid()
    };

    let _ = app.asset_protocol_scope().allow_file(&absolute);

    Ok(Attachment {
        id,
        action_id,
        name,
        file: String::new(),
        kind: kind.into(),
        mode: "linked".into(),
        bytes: meta.len() as i64,
        created_at,
        missing: false,
        src: absolute,
    })
}

/// Rebuild the asset scope from the linked rows. Called once at startup: the
/// scope is in-memory, so without this a linked image previews in the session
/// it was linked and never again.
pub fn allow_linked(app: &tauri::AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let paths: Vec<String> = {
        let conn = state.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT path FROM attachments WHERE mode = 'linked' AND path IS NOT NULL")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let scope = app.asset_protocol_scope();
    for p in paths {
        let _ = scope.allow_file(&p);
    }
    Ok(())
}

/// Every path Windows is holding on the clipboard. Copying a file in Explorer
/// puts `CF_HDROP` there — the *paths*, not the bytes — which is what makes
/// "copy in Explorer, paste on a card" a link rather than a copy.
///
/// An empty list is the normal answer, not an error: the clipboard usually
/// holds text or an image instead.
#[tauri::command]
pub fn clipboard_file_paths() -> Vec<String> {
    clipboard_win::get_clipboard::<Vec<String>, _>(clipboard_win::formats::FileList)
        .unwrap_or_default()
}

#[tauri::command]
pub fn link_paths(
    app: tauri::AppHandle,
    state: State<AppState>,
    action_id: i64,
    paths: Vec<String>,
) -> Result<Vec<Attachment>> {
    paths.iter().map(|p| link(&app, &state, action_id, p)).collect()
}

/// Ctrl+V lands here: the clipboard hands over bytes and a name, and neither is
/// trusted for anything but display.
#[tauri::command]
pub fn save_attachment(
    state: State<AppState>,
    action_id: i64,
    name: String,
    bytes: Vec<u8>,
) -> Result<Attachment> {
    store(&state, action_id, &name, &bytes)
}

#[tauri::command]
pub fn list_attachments(state: State<AppState>, action_id: i64) -> Result<Vec<Attachment>> {
    let conn = state.conn.lock().unwrap();
    let sql = format!("{SELECT} WHERE action_id = ?1 ORDER BY id ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![action_id], |r| {
        row_to_attachment(&state, r)
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Detaching removes the link, not the bytes. Another action may be addressing
/// the same hash, and the store has never deleted a file it was given.
#[tauri::command]
pub fn delete_attachment(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute("DELETE FROM attachments WHERE id = ?1", rusqlite::params![id])?;
    Ok(())
}

/// Resolve a row to a real file: the store for a kept one, the remembered
/// place for a linked one. This alone never touches the filesystem — a
/// linked path is attacker-reachable (a forged chip, a note from somewhere
/// else) and even *asking* whether a UNC path exists is enough to leak
/// Windows credentials to whatever answers on the other end, so the launch
/// blocklist has to see the path before anything ever stats it.
fn resolve(state: &AppState, id: i64) -> Result<(PathBuf, String, bool)> {
    let (file, name, mode, path) = {
        let conn = state.conn.lock().unwrap();
        conn.query_row(
            "SELECT file, name, mode, path FROM attachments WHERE id = ?1",
            rusqlite::params![id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .map_err(|_| Error::Msg("no such attachment".into()))?
    };

    let linked = mode == "linked";
    let p = if linked {
        PathBuf::from(path.unwrap_or_default())
    } else {
        path_of(state, &file)?
    };
    Ok((p, name, linked))
}

/// The `resolve`d path, but confirmed to exist — the check `resolve` itself
/// deliberately skips. This is the only function that decides that, so
/// opening and revealing cannot disagree about where a file is.
fn locate(state: &AppState, id: i64) -> Result<(PathBuf, String)> {
    let (p, name, linked) = resolve(state, id)?;
    if linked && !p.exists() {
        return Err(Error::Msg(format!(
            "{name} is not where it was linked from any more."
        )));
    }
    Ok((p, name))
}

/// Hand the file to whatever the system opens it with — except the extensions
/// on `NEVER_LAUNCH`. A notes app is not a launcher, and one click is not
/// enough deliberation for running something.
#[tauri::command]
pub fn open_attachment(state: State<AppState>, id: i64) -> Result<()> {
    let (path, name, linked) = resolve(&state, id)?;
    if let Some(why) = blocked_launch(&path) {
        return Err(Error::Msg(format!(
            "Jotter will not launch {why}. Use Show in folder to open {name} yourself."
        )));
    }
    if linked && !path.exists() {
        return Err(Error::Msg(format!(
            "{name} is not where it was linked from any more."
        )));
    }
    tauri_plugin_opener::open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| Error::Msg(e.to_string()))?;
    Ok(())
}

/// Open a path a note is pointing at. Same blocklist as an attachment: a note
/// is not a launcher either, and the path in a note is only ever a place the
/// user linked.
#[tauri::command]
pub fn open_linked_path(path: String) -> Result<()> {
    let p = std::path::Path::new(&path);
    let name = display_name(&path);
    if let Some(why) = blocked_launch(p) {
        return Err(Error::Msg(format!(
            "Jotter will not launch {why}. Open {name} from Explorer yourself."
        )));
    }
    if !p.exists() {
        return Err(Error::Msg(format!(
            "{name} is not where it was linked from any more."
        )));
    }
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| Error::Msg(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn reveal_attachment(state: State<AppState>, id: i64) -> Result<()> {
    let (path, _) = locate(&state, id)?;
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| Error::Msg(e.to_string()))?;
    Ok(())
}
