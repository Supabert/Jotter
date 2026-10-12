use crate::error::Result;
use crate::models::Label;
use crate::AppState;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{Manager, State};

/// Backups `backup_now` and the daily backup write, newest kept. Each is a
/// full copy of the database, so without a cap a daily backup grows forever.
const KEEP_BACKUPS: usize = 30;

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Result<HashMap<String, String>> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut map = HashMap::new();
    for row in rows {
        let (k, v) = row?;
        map.insert(k, v);
    }
    Ok(map)
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[tauri::command]
pub fn list_labels(state: State<AppState>) -> Result<Vec<Label>> {
    let conn = state.conn.lock().unwrap();
    let mut stmt =
        conn.prepare("SELECT id, name, color, sort_order, hidden FROM labels ORDER BY sort_order")?;
    let rows = stmt.query_map([], |r| {
        Ok(Label {
            id: r.get(0)?,
            name: r.get(1)?,
            color: r.get(2)?,
            sort_order: r.get(3)?,
            hidden: r.get::<_, i64>(4)? != 0,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn create_label(state: State<AppState>, name: String, color: String) -> Result<Label> {
    let conn = state.conn.lock().unwrap();
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM labels",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO labels (name, color, sort_order) VALUES (?1, ?2, ?3)",
        params![name, color, next],
    )?;
    Ok(Label {
        id: conn.last_insert_rowid(),
        name,
        color,
        sort_order: next,
        hidden: false,
    })
}

#[tauri::command]
pub fn update_label(
    state: State<AppState>,
    id: i64,
    name: String,
    color: String,
    hidden: bool,
) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE labels SET name = ?2, color = ?3, hidden = ?4 WHERE id = ?1",
        params![id, name, color, hidden as i64],
    )?;
    Ok(())
}

#[tauri::command]
pub fn reorder_labels(state: State<AppState>, ids: Vec<i64>) -> Result<()> {
    let mut conn = state.conn.lock().unwrap();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE labels SET sort_order = ?2 WHERE id = ?1")?;
        for (i, id) in ids.iter().enumerate() {
            stmt.execute(params![id, i as i64])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn data_dir(state: State<AppState>) -> Result<String> {
    Ok(state.data_dir.to_string_lossy().into_owned())
}

/// A copy of the database only. Images are content-addressed and never deleted,
/// so they are already their own permanent store and copying them per backup
/// would multiply gigabytes for nothing.
#[tauri::command]
pub fn backup_now(state: State<AppState>) -> Result<String> {
    let conn = state.conn.lock().unwrap();
    let dest = write_backup(&conn, &state.data_dir)?;
    Ok(dest.to_string_lossy().into_owned())
}

/// The `jotter-<stamp>.db` files in `backups/`, oldest first. Only names this
/// code writes are listed, so a backup folder the user made by hand in there is
/// never counted or pruned.
fn own_backups(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("jotter-") && n.ends_with(".db"))
        })
        .collect();
    found.sort(); // the stamp is zero-padded, so name order is time order
    found
}

fn write_backup(conn: &Connection, data_dir: &Path) -> Result<PathBuf> {
    let dir = data_dir.join("backups");
    std::fs::create_dir_all(&dir)?;
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H%M%S-%3f");
    let dest = dir.join(format!("jotter-{stamp}.db"));

    // VACUUM INTO produces a single consistent file even with WAL mid-write,
    // which a plain file copy of jotter.db does not.
    conn.execute(
        "VACUUM INTO ?1",
        params![dest.to_string_lossy().to_string()],
    )?;

    let all = own_backups(&dir);
    for old in all.iter().take(all.len().saturating_sub(KEEP_BACKUPS)) {
        let _ = std::fs::remove_file(old);
    }
    Ok(dest)
}

/// One automatic backup a day. Jotter sits in the tray for weeks, so this is
/// checked hourly rather than only at launch; the first check waits a minute so
/// it never competes with startup.
pub fn start_daily_backup(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        loop {
            let state = app.state::<AppState>();
            let dir = state.data_dir.join("backups");
            let newest = own_backups(&dir)
                .last()
                .and_then(|p| p.metadata().ok())
                .and_then(|m| m.modified().ok());
            let due = newest
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .map_or(true, |age| age >= Duration::from_secs(24 * 3600));
            if due {
                let conn = state.conn.lock().unwrap();
                let _ = write_backup(&conn, &state.data_dir);
            }
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}
