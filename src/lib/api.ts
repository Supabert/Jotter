import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';

export interface NoteSummary {
  id: number;
  title: string;
  label_id: number | null;
  pinned: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  excerpt: string;
  open_actions: number;
}

export interface Note {
  id: number;
  title: string;
  body_html: string;
  label_id: number | null;
  pinned: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  hidden: boolean;
}

export interface Action {
  id: number;
  text: string;
  note_id: number | null;
  note_title: string | null;
  label_id: number | null;
  anchor_id: string | null;
  done: boolean;
  done_at: string | null;
  archived: boolean;
  due_date: string | null;
  created_at: string;
  sort_order: number;
  /** What work this belongs to — independent of the source note's label. */
  project_id: number | null;
  /** Which board column it sits in. */
  stage_id: number | null;
  /** Position inside that column. Separate from `sort_order`, which is the
      list view's own hand-sorted order. */
  board_order: number;
  /** Position inside its project group on the timeline. The third ordering
      field: the three views group by different things, so a drag in one must
      not renumber the others. */
  timeline_order: number;
  /** Working notes behind the one line. Empty string, never null. */
  notes: string;
  /** When the work starts. Usually null; a deadline alone is the normal case. */
  start_date: string | null;
  /** Counted with the row, so the board can show a clip without a call per card. */
  attach_count: number;
}

export interface Attachment {
  id: number;
  action_id: number;
  /** What the user calls it. The only string ever shown. */
  name: string;
  /** What it is called on disk: the SHA-256 of its bytes. Never shown. */
  file: string;
  kind: 'image' | 'file';
  /** `kept` — bytes of ours, stored under their own hash. `linked` — a path we
      point at, and a file that stays wherever the user put it. */
  mode: 'kept' | 'linked';
  bytes: number;
  created_at: string;
  /** A link can break; a kept file cannot, so this is always false for one. */
  missing: boolean;
  /** Absolute path, resolved by the backend, for `convertFileSrc`. */
  src: string;
}

export interface Project {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  hidden: boolean;
}

export interface Stage {
  id: number;
  name: string;
  sort_order: number;
  /** The terminal column. Exactly one stage has this. */
  is_done: boolean;
  hidden: boolean;
}

export interface SearchHit {
  id: number;
  title: string;
  snippet: string;
  label_id: number | null;
  archived: boolean;
  updated_at: string;
}

export interface SavedImage {
  hash: string;
  file: string;
  src: string;
}

export const api = {
  listNotes: () => invoke<NoteSummary[]>('list_notes'),
  getNote: (id: number) => invoke<Note>('get_note', { id }),
  createNote: (title: string, bodyHtml: string, bodyText: string, labelId: number | null) =>
    invoke<number>('create_note', { title, bodyHtml, bodyText, labelId }),
  saveNote: (id: number, title: string, bodyHtml: string, bodyText: string) =>
    invoke<string>('save_note', { id, title, bodyHtml, bodyText }),
  setNoteLabel: (id: number, labelId: number | null) =>
    invoke<void>('set_note_label', { id, labelId }),
  setNotePinned: (id: number, pinned: boolean) => invoke<void>('set_note_pinned', { id, pinned }),
  setNoteArchived: (id: number, archived: boolean) =>
    invoke<void>('set_note_archived', { id, archived }),
  /** Permanent. Removes the note and every action extracted from it. */
  deleteNote: (id: number) => invoke<void>('delete_note', { id }),
  searchNotes: (query: string) => invoke<SearchHit[]>('search_notes', { query }),

  listActions: () => invoke<Action[]>('list_actions'),
  createAction: (
    text: string,
    noteId: number | null,
    anchorId: string | null,
    dueDate: string | null
  ) => invoke<Action>('create_action', { text, noteId, anchorId, dueDate }),
  setActionDone: (id: number, done: boolean) => invoke<void>('set_action_done', { id, done }),
  setActionDue: (id: number, dueDate: string | null) =>
    invoke<void>('set_action_due', { id, dueDate }),
  setActionText: (id: number, text: string) => invoke<void>('set_action_text', { id, text }),
  setActionArchived: (id: number, archived: boolean) =>
    invoke<void>('set_action_archived', { id, archived }),
  setActionNotes: (id: number, notes: string) => invoke<void>('set_action_notes', { id, notes }),
  setActionStart: (id: number, start: string | null) =>
    invoke<void>('set_action_start', { id, start }),
  /** Both ends in one write. A bar drag moves start and due together, and two
      commands would leave a frame where a row is due before it begins. */
  setActionSpan: (id: number, start: string | null, due: string | null) =>
    invoke<void>('set_action_span', { id, start, due }),
  /** Dropping a bar into another project group. `ids` is the destination
      group's full order after the drop. `null` is the No-project group, which
      is a real destination rather than an absence. */
  moveActionProject: (id: number, projectId: number | null, ids: number[]) =>
    invoke<void>('move_action_project', { id, projectId, ids }),
  /** Permanent. The escape hatch for a card typed by mistake. */
  deleteAction: (id: number) => invoke<void>('delete_action', { id }),
  reorderActions: (ids: number[]) => invoke<void>('reorder_actions', { ids }),
  doneAnchors: (noteId: number) => invoke<string[]>('done_anchors', { noteId }),

  listProjects: () => invoke<Project[]>('list_projects'),
  createProject: (name: string, color: string) =>
    invoke<Project>('create_project', { name, color }),
  updateProject: (id: number, name: string, color: string, hidden: boolean) =>
    invoke<void>('update_project', { id, name, color, hidden }),
  reorderProjects: (ids: number[]) => invoke<void>('reorder_projects', { ids }),
  setActionProject: (id: number, projectId: number | null) =>
    invoke<void>('set_action_project', { id, projectId }),

  listStages: () => invoke<Stage[]>('list_stages'),
  createStage: (name: string) => invoke<Stage>('create_stage', { name }),
  /** Returns how many actions the hide moved out of the stage. */
  updateStage: (id: number, name: string, hidden: boolean) =>
    invoke<number>('update_stage', { id, name, hidden }),
  reorderStages: (ids: number[]) => invoke<void>('reorder_stages', { ids }),
  /** Permanent. Returns how many cards it relocated on the way out. */
  deleteStage: (id: number) => invoke<number>('delete_stage', { id }),
  /** `ids` is the destination column's full order after the move. A move says
      where the work is; it never decides whether it is finished. */
  moveAction: (id: number, stageId: number, ids: number[]) =>
    invoke<void>('move_action', { id, stageId, ids }),

  /** Clipboard paste of raw pixels: bytes and a name, neither trusted for
      anything but display. A screenshot has no source file, so it is kept. */
  saveAttachment: (actionId: number, name: string, bytes: number[]) =>
    invoke<Attachment>('save_attachment', { actionId, name, bytes }),
  /** Point at files instead of copying them. Nothing is read but the metadata. */
  linkPaths: (actionId: number, paths: string[]) =>
    invoke<Attachment[]>('link_paths', { actionId, paths }),
  /** What Explorer put on the clipboard when a file was copied: paths, not bytes. */
  clipboardFilePaths: () => invoke<string[]>('clipboard_file_paths'),
  /** Open a path a note points at, with the same never-launch guard. */
  openLinkedPath: (path: string) => invoke<void>('open_linked_path', { path }),
  listAttachments: (actionId: number) =>
    invoke<Attachment[]>('list_attachments', { actionId }),
  /** Removes the link, not the bytes. */
  deleteAttachment: (id: number) => invoke<void>('delete_attachment', { id }),
  openAttachment: (id: number) => invoke<void>('open_attachment', { id }),
  revealAttachment: (id: number) => invoke<void>('reveal_attachment', { id }),

  saveImage: (bytes: number[]) => invoke<SavedImage>('save_image', { bytes }),
  imagePath: (file: string) => invoke<string>('image_path', { file }),

  openImageViewer: (file: string) => invoke<void>('open_image_viewer', { file }),
  getSettings: () => invoke<Record<string, string>>('get_settings'),
  setSetting: (key: string, value: string) => invoke<void>('set_setting', { key, value }),
  listLabels: () => invoke<Label[]>('list_labels'),
  createLabel: (name: string, color: string) => invoke<Label>('create_label', { name, color }),
  updateLabel: (id: number, name: string, color: string, hidden: boolean) =>
    invoke<void>('update_label', { id, name, color, hidden }),
  reorderLabels: (ids: number[]) => invoke<void>('reorder_labels', { ids }),
  dataDir: () => invoke<string>('data_dir'),
  backupNow: () => invoke<string>('backup_now'),

  openCapture: () => invoke<void>('open_capture'),
  rebindHotkey: (accelerator: string) => invoke<void>('rebind_hotkey', { accelerator }),
  quit: () => invoke<void>('quit_app')
};

/**
 * Note HTML stores only an image's file name. The asset URL is resolved at
 * render time so nothing absolute is ever baked into saved content, and the
 * path never leaves the Rust side unvalidated.
 */
const srcCache = new Map<string, string>();

export async function resolveImageSrc(file: string): Promise<string> {
  const hit = srcCache.get(file);
  if (hit) return hit;
  const path = await api.imagePath(file);
  const url = convertFileSrc(path);
  srcCache.set(file, url);
  return url;
}
