use crate::error::Result;
use crate::models::{Note, NoteSummary, SearchHit};
use crate::AppState;
use rusqlite::params;
use tauri::State;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Every sidebar row in one query, archived included. The frontend owns the
/// show/hide-archived toggle, so shipping both avoids a refetch on every flip.
/// Bodies are excluded on purpose; `excerpt` is a 160-char slice of the
/// plaintext mirror.
#[tauri::command]
pub fn list_notes(state: State<AppState>) -> Result<Vec<NoteSummary>> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT n.id, n.title, n.label_id, n.pinned, n.archived,
                n.created_at, n.updated_at,
                substr(n.body_text, 1, 160),
                (SELECT COUNT(*) FROM actions a
                  WHERE a.note_id = n.id AND a.done = 0 AND a.archived = 0)
         FROM notes n
         ORDER BY n.pinned DESC, n.updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(NoteSummary {
            id: r.get(0)?,
            title: r.get(1)?,
            label_id: r.get(2)?,
            pinned: r.get::<_, i64>(3)? != 0,
            archived: r.get::<_, i64>(4)? != 0,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
            excerpt: r.get(7)?,
            open_actions: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn get_note(state: State<AppState>, id: i64) -> Result<Note> {
    let conn = state.conn.lock().unwrap();
    let note = conn.query_row(
        "SELECT id, title, body_html, label_id, pinned, archived, created_at, updated_at
         FROM notes WHERE id = ?1",
        params![id],
        |r| {
            Ok(Note {
                id: r.get(0)?,
                title: r.get(1)?,
                body_html: r.get(2)?,
                label_id: r.get(3)?,
                pinned: r.get::<_, i64>(4)? != 0,
                archived: r.get::<_, i64>(5)? != 0,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
            })
        },
    )?;
    Ok(note)
}

#[tauri::command]
pub fn create_note(
    state: State<AppState>,
    title: String,
    body_html: String,
    body_text: String,
    label_id: Option<i64>,
) -> Result<i64> {
    let conn = state.conn.lock().unwrap();
    let ts = now();
    conn.execute(
        "INSERT INTO notes (title, body_html, body_text, label_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![title, body_html, body_text, label_id, ts],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The autosave target. Called on a 400 ms debounce and on every flush point,
/// so it must stay a single cheap UPDATE.
#[tauri::command]
pub fn save_note(
    state: State<AppState>,
    id: i64,
    title: String,
    body_html: String,
    body_text: String,
) -> Result<String> {
    let conn = state.conn.lock().unwrap();
    let ts = now();
    conn.execute(
        "UPDATE notes SET title = ?2, body_html = ?3, body_text = ?4, updated_at = ?5
         WHERE id = ?1",
        params![id, title, body_html, body_text, ts],
    )?;
    Ok(ts)
}

#[tauri::command]
pub fn set_note_label(state: State<AppState>, id: i64, label_id: Option<i64>) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE notes SET label_id = ?2 WHERE id = ?1",
        params![id, label_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn set_note_pinned(state: State<AppState>, id: i64, pinned: bool) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE notes SET pinned = ?2 WHERE id = ?1",
        params![id, pinned as i64],
    )?;
    Ok(())
}

/// Completing a note. This is the only way a note leaves the sidebar, and it is
/// reversible: `archived = false` restores it untouched. Archiving a note also
/// stows its still-open actions, so the Actions page never keeps rows pointing
/// at something the user considers finished.
#[tauri::command]
pub fn set_note_archived(state: State<AppState>, id: i64, archived: bool) -> Result<()> {
    let mut conn = state.conn.lock().unwrap();
    let tx = conn.transaction()?;
    let ts = now();
    tx.execute(
        "UPDATE notes SET archived = ?2, archived_at = ?3 WHERE id = ?1",
        params![id, archived as i64, if archived { Some(&ts) } else { None }],
    )?;
    tx.execute(
        "UPDATE actions SET archived = ?2 WHERE note_id = ?1",
        params![id, archived as i64],
    )?;
    tx.commit()?;
    Ok(())
}

/// The one true delete. Everything else in Jotter stows; this removes the row,
/// its FTS entry (via the `notes_ad` trigger) and every action extracted from
/// it. There is no undo and no tombstone — that is the whole point of it, and
/// the UI makes the user say so twice before it is called.
///
/// Pasted images are content-addressed and can be shared by other notes, so
/// they are deliberately left in place rather than swept here.
#[tauri::command]
pub fn delete_note(state: State<AppState>, id: i64) -> Result<()> {
    let mut conn = state.conn.lock().unwrap();
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM actions WHERE note_id = ?1", params![id])?;
    tx.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

/// snippet() hands back plain text lifted straight out of a note, marked up
/// with the two sentinel bytes passed as its start/end args below — it has no
/// idea the frontend renders its result as HTML. The text is escaped here
/// first, so nothing a note contains can inject markup, and only then are the
/// sentinels (which escaping cannot produce and a note cannot type) swapped
/// for the `<mark>` tags they stand in for.
fn snippet_to_html(raw: &str) -> String {
    let escaped = raw
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;");
    escaped.replace('\u{1}', "<mark>").replace('\u{2}', "</mark>")
}

/// FTS5 over title + body_text. User input never reaches the MATCH expression
/// raw: each token is double-quoted (escaping any inner quote) and given a
/// prefix `*`, so a query like `foo" OR bar` can only ever be a literal phrase.
#[tauri::command]
pub fn search_notes(state: State<AppState>, query: String) -> Result<Vec<SearchHit>> {
    let terms: Vec<String> = query
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let match_expr = terms.join(" ");

    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT n.id, n.title,
                snippet(notes_fts, 1, '\u{1}', '\u{2}', '…', 12),
                n.label_id, n.archived, n.updated_at
         FROM notes_fts f
         JOIN notes n ON n.id = f.rowid
         WHERE notes_fts MATCH ?1
         ORDER BY rank
         LIMIT 60",
    )?;
    let rows = stmt.query_map(params![match_expr], |r| {
        Ok(SearchHit {
            id: r.get(0)?,
            title: r.get(1)?,
            snippet: snippet_to_html(&r.get::<_, String>(2)?),
            label_id: r.get(3)?,
            archived: r.get::<_, i64>(4)? != 0,
            updated_at: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}
