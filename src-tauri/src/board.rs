//! Projects and board stages.
//!
//! A project says what work an action belongs to; a stage says which column of
//! the board it is sitting in. Both are user vocabulary — named, coloured and
//! ordered by the user. `is_done` on a stage is dead weight kept only so the V2
//! table shape stays valid; completion is a state on the action, never a place.

use crate::error::Result;
use crate::models::{Project, Stage};
use crate::AppState;
use rusqlite::params;
use tauri::State;

// --- projects ---------------------------------------------------------------

#[tauri::command]
pub fn list_projects(state: State<AppState>) -> Result<Vec<Project>> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, color, sort_order, hidden FROM projects ORDER BY sort_order, id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Project {
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
pub fn create_project(state: State<AppState>, name: String, color: String) -> Result<Project> {
    let conn = state.conn.lock().unwrap();
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO projects (name, color, sort_order) VALUES (?1, ?2, ?3)",
        params![name, color, next],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Project {
        id,
        name,
        color,
        sort_order: next,
        hidden: false,
    })
}

#[tauri::command]
pub fn update_project(
    state: State<AppState>,
    id: i64,
    name: String,
    color: String,
    hidden: bool,
) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE projects SET name = ?2, color = ?3, hidden = ?4 WHERE id = ?1",
        params![id, name, color, hidden as i64],
    )?;
    Ok(())
}

#[tauri::command]
pub fn reorder_projects(state: State<AppState>, ids: Vec<i64>) -> Result<()> {
    let mut conn = state.conn.lock().unwrap();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE projects SET sort_order = ?2 WHERE id = ?1")?;
        for (i, id) in ids.iter().enumerate() {
            stmt.execute(params![id, i as i64])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn set_action_project(
    state: State<AppState>,
    id: i64,
    project_id: Option<i64>,
) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE actions SET project_id = ?2 WHERE id = ?1",
        params![id, project_id],
    )?;
    Ok(())
}

// --- stages -----------------------------------------------------------------

#[tauri::command]
pub fn list_stages(state: State<AppState>) -> Result<Vec<Stage>> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, sort_order, is_done, hidden FROM stages ORDER BY sort_order, id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Stage {
            id: r.get(0)?,
            name: r.get(1)?,
            sort_order: r.get(2)?,
            is_done: r.get::<_, i64>(3)? != 0,
            hidden: r.get::<_, i64>(4)? != 0,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// New columns land before the done column, because a column added to the right
/// of "Done" would sit past the end of the workflow it belongs to.
#[tauri::command]
pub fn create_stage(state: State<AppState>, name: String) -> Result<Stage> {
    let conn = state.conn.lock().unwrap();
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM stages",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO stages (name, sort_order) VALUES (?1, ?2)",
        params![name, next],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Stage {
        id,
        name,
        sort_order: next,
        is_done: false,
        hidden: false,
    })
}

/// Renaming and hiding in one write. Hiding a stage empties it into the first
/// visible column rather than leaving its cards addressed to a column nobody can
/// see, and returns how many moved so the toast can say what actually happened.
#[tauri::command]
pub fn update_stage(state: State<AppState>, id: i64, name: String, hidden: bool) -> Result<i64> {
    let mut conn = state.conn.lock().unwrap();
    let tx = conn.transaction()?;

    tx.execute(
        "UPDATE stages SET name = ?2, hidden = ?3 WHERE id = ?1",
        params![id, name, hidden as i64],
    )?;

    let mut moved = 0i64;
    if hidden {
        let target: Option<i64> = tx
            .query_row(
                "SELECT id FROM stages WHERE hidden = 0 AND id <> ?1 ORDER BY sort_order LIMIT 1",
                params![id],
                |r| r.get(0),
            )
            .ok();
        if let Some(target) = target {
            moved = tx.execute(
                "UPDATE actions SET stage_id = ?2 WHERE stage_id = ?1",
                params![id, target],
            )? as i64;
        }
    }

    tx.commit()?;
    Ok(moved)
}

/// Delete a column outright, the way a board app is expected to. Its cards are
/// relocated first and the count comes back, so the confirmation can say what
/// happened rather than implying nothing did.
///
/// One guard: the last column cannot go, because a new action has to be created
/// somewhere and a board with no columns has nowhere to put anything.
#[tauri::command]
pub fn delete_stage(state: State<AppState>, id: i64) -> Result<i64> {
    let mut conn = state.conn.lock().unwrap();
    let tx = conn.transaction()?;

    let left: i64 = tx.query_row(
        "SELECT COUNT(*) FROM stages WHERE id <> ?1",
        params![id],
        |r| r.get(0),
    )?;
    if left == 0 {
        return Err(crate::error::Error::Msg(
            "This is the last column. Add another before deleting this one.".into(),
        ));
    }

    let target: i64 = tx.query_row(
        "SELECT id FROM stages WHERE id <> ?1 ORDER BY hidden, sort_order LIMIT 1",
        params![id],
        |r| r.get(0),
    )?;
    let moved = tx.execute(
        "UPDATE actions SET stage_id = ?2 WHERE stage_id = ?1",
        params![id, target],
    )? as i64;

    tx.execute("DELETE FROM stages WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(moved)
}

#[tauri::command]
pub fn reorder_stages(state: State<AppState>, ids: Vec<i64>) -> Result<()> {
    let mut conn = state.conn.lock().unwrap();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE stages SET sort_order = ?2 WHERE id = ?1")?;
        for (i, id) in ids.iter().enumerate() {
            stmt.execute(params![id, i as i64])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Dropping a card. `ids` is the destination column's full order after the
/// move, sent whole rather than as a pair of indices so a dropped event can
/// never leave two cards claiming one slot.
///
/// Landing in the done column completes the action and stows it; leaving it
/// reopens it. That is the same write `set_action_done` performs from the
/// checkbox, in the other direction.
#[tauri::command]
pub fn move_action(
    state: State<AppState>,
    id: i64,
    stage_id: i64,
    ids: Vec<i64>,
) -> Result<()> {
    let mut conn = state.conn.lock().unwrap();
    let tx = conn.transaction()?;

    // A move says where the work is happening. It says nothing about whether it
    // is finished — that is the checkbox's job, and only the checkbox's.
    tx.execute(
        "UPDATE actions SET stage_id = ?2 WHERE id = ?1",
        params![id, stage_id],
    )?;

    {
        let mut stmt = tx.prepare("UPDATE actions SET board_order = ?2 WHERE id = ?1")?;
        for (i, aid) in ids.iter().enumerate() {
            stmt.execute(params![aid, i as f64])?;
        }
    }

    tx.commit()?;
    Ok(())
}
