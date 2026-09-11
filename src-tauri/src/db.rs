use crate::error::{Error, Result};
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// Schema version currently expected by the code. Bump alongside a new arm in
/// `migrate`; never edit an existing arm, since a shipped database has already
/// run it.
const SCHEMA_VERSION: i64 = 7;

/// WAL leaves a `-wal` and `-shm` file beside the database, written to
/// independently of it between checkpoints — exactly what a sync client can
/// upload or download out of order, which is how a database inside a synced
/// or network folder corrupts itself. DELETE keeps everything in the one
/// file, at the cost of a lock during checkpoint that a single local user
/// never notices.
fn is_cloud_or_network(db_path: &Path) -> bool {
    let path = db_path.to_string_lossy();
    if path.starts_with(r"\\") {
        return true;
    }
    ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
        .iter()
        .filter_map(|var| std::env::var(var).ok())
        .any(|root| {
            !root.trim().is_empty()
                && path.to_ascii_lowercase().starts_with(&root.trim().to_ascii_lowercase())
        })
}

pub fn open(db_path: &Path) -> Result<Connection> {
    let mut conn = Connection::open(db_path)?;

    // Checked before anything else touches the file: a database left behind
    // by a newer build is not something this one should migrate away from —
    // running its known arms against a schema it does not recognize would
    // corrupt it — so this refuses before the journal mode below is even set.
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current > SCHEMA_VERSION {
        return Err(Error::Msg(format!(
            "this database is at schema version {current}, newer than the {SCHEMA_VERSION} this \
             build knows how to open. Update Jotter before opening it — nothing here has been \
             touched."
        )));
    }

    // WAL keeps the continuous autosave from blocking reads, and NORMAL is the
    // right durability trade for a single-user local app: a crash can cost the
    // last few hundred milliseconds, never the file.
    let journal_mode = if is_cloud_or_network(db_path) { "DELETE" } else { "WAL" };
    conn.execute_batch(&format!(
        "PRAGMA journal_mode = {journal_mode};
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA temp_store = MEMORY;"
    ))?;

    migrate(db_path, current, &mut conn)?;
    Ok(conn)
}

/// A backup ahead of a migration that is about to rewrite the schema —
/// the same VACUUM INTO as `settings::backup_now`, run here instead because
/// VACUUM INTO cannot run inside a transaction and the migrations below do.
fn backup_before_migration(db_path: &Path, conn: &Connection, from_version: i64) -> Result<()> {
    let dir = db_path
        .parent()
        .map(|p| p.join("backups"))
        .unwrap_or_else(|| PathBuf::from("backups"));
    std::fs::create_dir_all(&dir)?;
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H%M%S");
    let dest = dir.join(format!("pre-v{SCHEMA_VERSION}-{stamp}.db"));
    conn.execute("VACUUM INTO ?1", rusqlite::params![dest.to_string_lossy().to_string()])?;
    eprintln!(
        "jotter: backed up v{from_version} database to {} before migrating to v{SCHEMA_VERSION}",
        dest.display()
    );
    Ok(())
}

fn migrate(db_path: &Path, current: i64, conn: &mut Connection) -> Result<()> {
    if current == SCHEMA_VERSION {
        return Ok(());
    }

    if current > 0 {
        backup_before_migration(db_path, conn, current)?;
    }

    // One transaction for every pending arm, user_version included: a crash
    // or an error partway through must never leave the schema between two
    // versions, which `?` dropping this transaction uncommitted guarantees.
    let tx = conn.transaction()?;

    if current < 1 {
        tx.execute_batch(V1)?;
    }

    if current < 2 {
        tx.execute_batch(V2)?;
    }

    if current < 3 {
        tx.execute_batch(V3)?;
    }

    if current < 4 {
        migrate_v4(&tx)?;
    }

    if current < 5 {
        tx.execute_batch(V5)?;
    }

    if current < 6 {
        tx.execute_batch(V6)?;
    }

    if current < 7 {
        tx.execute_batch(V7)?;
    }

    tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    tx.commit()?;
    Ok(())
}

/// `body_text` is a plaintext mirror of `body_html`, written on every save, so
/// full-text search never parses HTML. `notes_fts` is external-content over it.
///
/// Note the absence of any delete path: `archived` is the only way a row leaves
/// the user's view, and nothing in this schema cascades.
const V1: &str = r#"
CREATE TABLE IF NOT EXISTS labels (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  color       TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY,
  title       TEXT    NOT NULL DEFAULT '',
  body_html   TEXT    NOT NULL DEFAULT '',
  body_text   TEXT    NOT NULL DEFAULT '',
  label_id    INTEGER REFERENCES labels(id) ON DELETE SET NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_updated  ON notes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_archived ON notes(archived);
CREATE INDEX IF NOT EXISTS idx_notes_label    ON notes(label_id);

CREATE TABLE IF NOT EXISTS actions (
  id          INTEGER PRIMARY KEY,
  text        TEXT    NOT NULL,
  note_id     INTEGER REFERENCES notes(id) ON DELETE SET NULL,
  anchor_id   TEXT,
  done        INTEGER NOT NULL DEFAULT 0,
  done_at     TEXT,
  archived    INTEGER NOT NULL DEFAULT 0,
  due_date    TEXT,
  created_at  TEXT    NOT NULL,
  sort_order  REAL    NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_actions_done   ON actions(done);
CREATE INDEX IF NOT EXISTS idx_actions_note   ON actions(note_id);
CREATE INDEX IF NOT EXISTS idx_actions_due    ON actions(due_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_anchor ON actions(anchor_id)
  WHERE anchor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS images (
  hash        TEXT PRIMARY KEY,
  ext         TEXT    NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, body_text, content='notes', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body_text)
  VALUES (new.id, new.title, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body_text)
  VALUES ('delete', old.id, old.title, old.body_text);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body_text)
  VALUES ('delete', old.id, old.title, old.body_text);
  INSERT INTO notes_fts(rowid, title, body_text)
  VALUES (new.id, new.title, new.body_text);
END;
"#;

/// V2 — projects and board stages.
///
/// A project answers "what work is this part of"; a note's label answers "where
/// did I write this". They are deliberately separate vocabularies, because an
/// action captured in a Scratch note can belong to a real project and forcing
/// one list to do both jobs makes both lists worse.
///
/// Stages are the board's columns and the user names them. Exactly one stage
/// carries `is_done`, and moving an action into it is the same event as ticking
/// its checkbox — see `board::move_action`. Two ways to say "finished" that can
/// disagree is the failure mode this design exists to avoid.
///
/// Still no delete path: `hidden` is how a project or a stage leaves the view.
const V2: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  color       TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stages (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_done     INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE actions ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE actions ADD COLUMN stage_id   INTEGER REFERENCES stages(id)   ON DELETE SET NULL;
ALTER TABLE actions ADD COLUMN board_order REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_actions_project ON actions(project_id);
CREATE INDEX IF NOT EXISTS idx_actions_stage   ON actions(stage_id);
"#;

/// An action gained the one field a card detail needs and a line of text cannot
/// hold: the working notes behind it. Empty string rather than NULL, because
/// "no notes" and "notes I cleared" are the same thing to a reader and there is
/// no reason to make every caller handle two spellings of it.
/// V5 gives an action a *span* rather than only a deadline, and somewhere to
/// keep the material it refers to.
///
/// `start_date` is nullable and stays nullable: most actions never earn one,
/// and a start invented on the user's behalf would be a fabricated fact on a
/// chart that is meant to be read as true.
///
/// Attachments are content-addressed on disk exactly like pasted images — the
/// file name is the SHA-256 of the bytes — so the same deck attached to four
/// actions is stored once. The row carries the name the user knows it by; the
/// path never does. This is the one place in the schema that cascades: an
/// attachment is a property of its action, not a thing in its own right, so a
/// deleted action must not leave rows pointing at nothing. The bytes on disk
/// stay, because another action may be addressing the same hash.
const V5: &str = r#"
ALTER TABLE actions ADD COLUMN start_date TEXT;

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY,
  action_id  INTEGER NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  hash       TEXT    NOT NULL,
  file       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_action ON attachments(action_id);
"#;

/// V6 lets an attachment be a *link* rather than a copy.
///
/// The ask was for no copy at all: the file should stay wherever it came
/// from. So an attachment now has a mode. `kept` is what
/// V5 stored — bytes of ours, under the hash of those bytes, ours to keep.
/// `linked` is a remembered path and nothing else: no bytes, no hash, and the
/// file goes on living wherever it already lived.
///
/// The rule that keeps the two apart: if it came from a *place*, remember the
/// place; if it came from the clipboard as pixels, there is no place to point
/// at, so keep the bytes.
///
/// Everything already stored predates the distinction and is `kept`, which is
/// what the default says.
const V6: &str = r#"
ALTER TABLE attachments ADD COLUMN mode TEXT NOT NULL DEFAULT 'kept';
ALTER TABLE attachments ADD COLUMN path TEXT;
"#;

/// V7 gives the timeline its own row order.
///
/// This is the third ordering column on `actions`, and the third is there for
/// the same reason the second was: **a drag in one view must never renumber
/// another.** `sort_order` is the checklist's hand-sort, `board_order` is the
/// position inside a kanban column, and `timeline_order` is the position inside
/// a project group on the chart. The three views group by different things —
/// nothing, stage, project — so one number cannot carry all three intentions,
/// and making it try means tidying the Gantt silently reshuffles the board.
///
/// Backfilled from `board_order` so an existing action opens the chart in a
/// familiar order rather than all-zero and sorted by id.
const V7: &str = r#"
ALTER TABLE actions ADD COLUMN timeline_order REAL NOT NULL DEFAULT 0;
UPDATE actions SET timeline_order = board_order;
"#;

const V3: &str = r#"
ALTER TABLE actions ADD COLUMN notes TEXT NOT NULL DEFAULT '';
"#;

/// V4 retires the finish column. Completing an action no longer moves it
/// anywhere: it stays in the column it was worked in and collapses under that
/// column's "Show completed" disclosure. A board with a Done column answers
/// "what is finished" twice — once with a checkbox and once with a position —
/// and the user only ever wanted the first.
///
/// Written in Rust rather than as a SQL batch because the actions have to be
/// rehomed *before* the columns holding them are deleted, and because a board
/// whose only column was the finish column has to be given one back.
fn migrate_v4(conn: &Connection) -> Result<()> {
    let open: Option<i64> = conn
        .query_row(
            "SELECT id FROM stages WHERE is_done = 0 ORDER BY hidden, sort_order LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();

    let target = match open {
        Some(id) => id,
        None => {
            conn.execute(
                "INSERT INTO stages (name, sort_order, is_done) VALUES ('To do', 0, 0)",
                [],
            )?;
            conn.last_insert_rowid()
        }
    };

    conn.execute(
        "UPDATE actions SET stage_id = ?1
          WHERE stage_id IN (SELECT id FROM stages WHERE is_done = 1)",
        rusqlite::params![target],
    )?;
    conn.execute("DELETE FROM stages WHERE is_done = 1", [])?;
    Ok(())
}

/// Seed labels, written once on a brand-new database. Colours are the QRH
/// thumb-tab set: they read as dividers in a book, not as decoration.
pub const SEED_LABELS: &[(&str, &str)] = &[
    ("Now", "#d69a2e"),
    ("Work", "#4b86a3"),
    ("Ideas", "#7d6bb0"),
    ("Reference", "#4ba36a"),
    ("Scratch", "#8d9699"),
];

pub fn seed_if_empty(conn: &Connection) -> Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM labels", [], |r| r.get(0))?;
    if count > 0 {
        return Ok(());
    }
    let mut stmt =
        conn.prepare("INSERT INTO labels (name, color, sort_order) VALUES (?1, ?2, ?3)")?;
    for (i, (name, color)) in SEED_LABELS.iter().enumerate() {
        stmt.execute(rusqlite::params![name, color, i as i64])?;
    }
    Ok(())
}

/// The board's opening columns. The user renames, reorders, adds and hides
/// them; these only decide what a brand-new database looks like.
pub const SEED_STAGES: &[(&str, bool)] = &[("To do", false), ("Doing", false)];

/// Written once, then never again — and it also backfills, because a database
/// that predates V2 has actions with no stage. An action with `stage_id` NULL
/// would otherwise be invisible on the board while still sitting in the list.
pub fn seed_board_if_empty(conn: &Connection) -> Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM stages", [], |r| r.get(0))?;
    if count == 0 {
        let mut stmt =
            conn.prepare("INSERT INTO stages (name, sort_order, is_done) VALUES (?1, ?2, ?3)")?;
        for (i, (name, is_done)) in SEED_STAGES.iter().enumerate() {
            stmt.execute(rusqlite::params![name, i as i64, *is_done as i64])?;
        }
    }

    // Backfill: an action with no stage at all would be invisible on the board
    // while still sitting in the list. Done or not, it belongs in the first
    // column — completion is a state now, not a place.
    conn.execute(
        "UPDATE actions
            SET stage_id = (SELECT id FROM stages WHERE hidden = 0 ORDER BY sort_order LIMIT 1)
          WHERE stage_id IS NULL",
        [],
    )?;
    conn.execute(
        "UPDATE actions SET board_order = sort_order WHERE board_order = 0",
        [],
    )?;
    Ok(())
}
