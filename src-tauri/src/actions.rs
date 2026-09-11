use crate::error::Result;
use crate::models::Action;
use crate::AppState;
use rusqlite::params;
use tauri::State;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

const SELECT_ACTION: &str = "SELECT a.id, a.text, a.note_id, n.title, n.label_id, a.anchor_id,
                                    a.done, a.done_at, a.archived, a.due_date,
                                    a.created_at, a.sort_order,
                                    a.project_id, a.stage_id, a.board_order, a.notes,
                                    a.start_date, a.timeline_order,
                                    (SELECT COUNT(*) FROM attachments t WHERE t.action_id = a.id)
                             FROM actions a LEFT JOIN notes n ON n.id = a.note_id";

fn map_action(r: &rusqlite::Row) -> rusqlite::Result<Action> {
    Ok(Action {
        id: r.get(0)?,
        text: r.get(1)?,
        note_id: r.get(2)?,
        note_title: r.get(3)?,
        label_id: r.get(4)?,
        anchor_id: r.get(5)?,
        done: r.get::<_, i64>(6)? != 0,
        done_at: r.get(7)?,
        archived: r.get::<_, i64>(8)? != 0,
        due_date: r.get(9)?,
        created_at: r.get(10)?,
        sort_order: r.get(11)?,
        project_id: r.get(12)?,
        stage_id: r.get(13)?,
        board_order: r.get(14)?,
        notes: r.get(15)?,
        start_date: r.get(16)?,
        timeline_order: r.get(17)?,
        attach_count: r.get(18)?,
    })
}

#[tauri::command]
pub fn list_actions(state: State<AppState>) -> Result<Vec<Action>> {
    let conn = state.conn.lock().unwrap();
    let sql = format!("{SELECT_ACTION} ORDER BY a.done ASC, a.sort_order ASC, a.id ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_action)?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Ctrl+Shift+A lands here. `anchor_id` is the id the editor stamped onto the
/// `<span class="jt-action">` it wrapped around the selection; it is what lets
/// the Actions page jump back to the exact sentence in the source note.
///
/// Completion state is never written back into the note's HTML — the editor
/// looks up done anchors at render time — so this row stays the single source
/// of truth and the two views cannot drift.
#[tauri::command]
pub fn create_action(
    state: State<AppState>,
    text: String,
    note_id: Option<i64>,
    anchor_id: Option<String>,
    due_date: Option<String>,
) -> Result<Action> {
    let conn = state.conn.lock().unwrap();
    let ts = now();
    let next: f64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM actions",
        [],
        |r| r.get(0),
    )?;
    // A new action lands in the first column, so a checklist item and a board
    // card are the same thing from the moment it exists.
    conn.execute(
        "INSERT INTO actions (text, note_id, anchor_id, due_date, created_at, sort_order,
                              stage_id, board_order, timeline_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                 (SELECT id FROM stages WHERE hidden = 0 ORDER BY sort_order LIMIT 1),
                 ?6, ?6)",
        params![text, note_id, anchor_id, due_date, ts, next],
    )?;
    let id = conn.last_insert_rowid();
    let sql = format!("{SELECT_ACTION} WHERE a.id = ?1");
    Ok(conn.query_row(&sql, params![id], map_action)?)
}

/// Completing an action: struck through in both the Actions page and the source
/// note, then stowed into archive. Reversible — unchecking restores it in place.
///
/// Completion does not move the card. It stays in the column it was worked in
/// and collapses under that column's "Show completed" disclosure, so the board
/// keeps saying *where* the work happened while the checkbox says whether it is
/// finished. Two different questions, two different places to read the answer.
#[tauri::command]
pub fn set_action_done(state: State<AppState>, id: i64, done: bool) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    let ts = now();
    conn.execute(
        "UPDATE actions SET done = ?2, done_at = ?3, archived = ?2 WHERE id = ?1",
        params![id, done as i64, if done { Some(&ts) } else { None }],
    )?;
    Ok(())
}

#[tauri::command]
pub fn set_action_due(state: State<AppState>, id: i64, due_date: Option<String>) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE actions SET due_date = ?2 WHERE id = ?1",
        params![id, due_date],
    )?;
    Ok(())
}

#[tauri::command]
pub fn set_action_text(state: State<AppState>, id: i64, text: String) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE actions SET text = ?2 WHERE id = ?1",
        params![id, text],
    )?;
    Ok(())
}

/// The other half of a span. Kept separate from `set_action_due` because the
/// two dates are set at different moments and neither implies the other.
#[tauri::command]
pub fn set_action_start(state: State<AppState>, id: i64, start: Option<String>) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE actions SET start_date = ?2 WHERE id = ?1",
        params![id, start],
    )?;
    Ok(())
}

/// Both ends of a span in one write.
///
/// Dragging a bar on the timeline moves the start and the due together, and
/// sending that as two commands leaves a frame where the row says it is due
/// before it begins. Nothing reads a row mid-drag today, which is exactly why
/// this is worth fixing while nothing does: the invalid state never exists at
/// all rather than being harmless for now.
///
/// Either date may be null. Clearing the start is how a bar collapses back into
/// a milestone, which is the gesture that undoes growing one into a bar.
#[tauri::command]
pub fn set_action_span(
    state: State<AppState>,
    id: i64,
    start: Option<String>,
    due: Option<String>,
) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE actions SET start_date = ?2, due_date = ?3 WHERE id = ?1",
        params![id, start, due],
    )?;
    Ok(())
}

/// Dropping a bar into another project group on the timeline.
///
/// The exact shape of `board::move_action`, one axis over: that one says which
/// column work is in, this one says what work it is part of. `ids` is the
/// destination group's full order after the drop, sent whole rather than as a
/// pair of indices so a dropped event can never leave two rows claiming one
/// slot.
///
/// `project_id` is `None` for the "No project" group, which is a real
/// destination and not an absence — work can genuinely stop belonging to a
/// project.
#[tauri::command]
pub fn move_action_project(
    state: State<AppState>,
    id: i64,
    project_id: Option<i64>,
    ids: Vec<i64>,
) -> Result<()> {
    let mut conn = state.conn.lock().unwrap();
    let tx = conn.transaction()?;

    tx.execute(
        "UPDATE actions SET project_id = ?2 WHERE id = ?1",
        params![id, project_id],
    )?;

    {
        let mut stmt = tx.prepare("UPDATE actions SET timeline_order = ?2 WHERE id = ?1")?;
        for (i, aid) in ids.iter().enumerate() {
            stmt.execute(params![aid, i as f64])?;
        }
    }

    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn set_action_notes(state: State<AppState>, id: i64, notes: String) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE actions SET notes = ?2 WHERE id = ?1",
        params![id, notes],
    )?;
    Ok(())
}

/// The second and last permanent delete in this app, and it exists for the same
/// reason the first one does: the board can now create a card directly, so a
/// card typed by mistake needs a way out that is not "pretend you finished it".
/// Completing is still the everyday path; this is the escape hatch.
#[tauri::command]
pub fn delete_action(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute("DELETE FROM actions WHERE id = ?1", params![id])?;
    Ok(())
}

#[tauri::command]
pub fn set_action_archived(state: State<AppState>, id: i64, archived: bool) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE actions SET archived = ?2 WHERE id = ?1",
        params![id, archived as i64],
    )?;
    Ok(())
}

/// Drag-reorder on the Actions page. Sent as the full ordered id list rather
/// than a pair of indices, so a dropped event can never leave a gap.
#[tauri::command]
pub fn reorder_actions(state: State<AppState>, ids: Vec<i64>) -> Result<()> {
    let mut conn = state.conn.lock().unwrap();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE actions SET sort_order = ?2 WHERE id = ?1")?;
        for (i, id) in ids.iter().enumerate() {
            stmt.execute(params![id, i as f64])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// The set of anchor ids the editor should render struck through for one note.
#[tauri::command]
pub fn done_anchors(state: State<AppState>, note_id: i64) -> Result<Vec<String>> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT anchor_id FROM actions
         WHERE note_id = ?1 AND done = 1 AND anchor_id IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![note_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}
