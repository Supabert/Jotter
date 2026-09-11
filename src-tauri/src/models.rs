use serde::{Deserialize, Serialize};

/// Sidebar row. Deliberately without `body_html` — the list query must stay
/// cheap no matter how many notes exist, so bodies load only when opened.
#[derive(Debug, Serialize)]
pub struct NoteSummary {
    pub id: i64,
    pub title: String,
    pub label_id: Option<i64>,
    pub pinned: bool,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    pub excerpt: String,
    pub open_actions: i64,
}

#[derive(Debug, Serialize)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub body_html: String,
    pub label_id: Option<i64>,
    pub pinned: bool,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Label {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub sort_order: i64,
    /// Labels are never deleted either. Hiding one keeps every note that still
    /// carries it intact, and unhiding brings the tab straight back.
    pub hidden: bool,
}

#[derive(Debug, Serialize)]
pub struct Action {
    pub id: i64,
    pub text: String,
    pub note_id: Option<i64>,
    pub note_title: Option<String>,
    pub label_id: Option<i64>,
    pub anchor_id: Option<String>,
    pub done: bool,
    pub done_at: Option<String>,
    pub archived: bool,
    pub due_date: Option<String>,
    /// When the work starts. Nullable and usually null — an action with only a
    /// deadline is the normal case, and a start invented for it would be a
    /// fabricated fact on any chart drawn from these rows.
    pub start_date: Option<String>,
    pub created_at: String,
    pub sort_order: f64,
    /// What work this belongs to. Independent of the source note's label.
    pub project_id: Option<i64>,
    /// Which board column it sits in.
    pub stage_id: Option<i64>,
    /// Position within that column. Separate from `sort_order`, which is the
    /// list view's own hand-sorted order — the two views are ordered by
    /// different intentions and must not overwrite each other.
    pub board_order: f64,
    /// Position inside its project group on the timeline. The third ordering
    /// field, and separate from the other two for the same reason they are
    /// separate from each other: the three views group by different things, so
    /// a drag in one must not renumber the others.
    pub timeline_order: f64,
    /// Working notes behind the one line. Empty, never NULL.
    pub notes: String,
    /// How many files are attached. Counted in the same query as the row so the
    /// board can show the clip without a request per card.
    pub attach_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub sort_order: i64,
    /// Projects are never deleted. Hiding one keeps every action that carries
    /// it, and unhiding brings them straight back.
    pub hidden: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Stage {
    pub id: i64,
    pub name: String,
    pub sort_order: i64,
    /// The terminal column. Exactly one stage has this, and moving an action
    /// into it completes the action.
    pub is_done: bool,
    pub hidden: bool,
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub id: i64,
    pub title: String,
    pub snippet: String,
    pub label_id: Option<i64>,
    pub archived: bool,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct SavedImage {
    pub hash: String,
    pub file: String,
    pub src: String,
}

/// A file kept with an action. `file` is what it is called on disk — the
/// SHA-256 of its bytes plus a sanitized extension — and `name` is what the
/// user called it. Only `name` is ever shown; only `file` is ever a path.
#[derive(Debug, Serialize)]
pub struct Attachment {
    pub id: i64,
    pub action_id: i64,
    pub name: String,
    pub file: String,
    /// `image` renders as a thumbnail, anything else as a chip.
    pub kind: String,
    /// `kept` — bytes of ours in `files/`. `linked` — a path we point at and a
    /// file that stays where the user put it.
    pub mode: String,
    pub bytes: i64,
    pub created_at: String,
    /// A link can break. A kept file cannot, so this is always false for one.
    pub missing: bool,
    /// Absolute path, for `convertFileSrc`. Resolved here so the frontend never
    /// has to build one.
    pub src: String,
}
