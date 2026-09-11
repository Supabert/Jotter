/**
 * Every shortcut in one table so the app can never drift from the map in the
 * spec, and so the command palette can show real bindings instead of a
 * hand-maintained list.
 *
 * Ctrl+A is absent on purpose. It is select-all and nothing else, forever.
 */
export interface Binding {
  id: string;
  keys: string;
  label: string;
  group: 'File' | 'Navigate' | 'Format' | 'Actions' | 'View';
  /** Hidden from the palette when it only makes sense inside the editor. */
  editorOnly?: boolean;
}

export const BINDINGS: Binding[] = [
  { id: 'note.new', keys: 'Ctrl+N', label: 'New note', group: 'File' },
  { id: 'nav.back', keys: 'Ctrl+W', label: 'Back to previous', group: 'File' },
  { id: 'note.complete', keys: 'Ctrl+Enter', label: 'Complete note and stow', group: 'File' },
  { id: 'capture', keys: 'Ctrl+Alt+N', label: 'Quick capture (global)', group: 'File' },

  { id: 'nav.next', keys: 'Ctrl+Tab', label: 'Next note in the sidebar', group: 'Navigate' },
  { id: 'nav.prev', keys: 'Ctrl+Shift+Tab', label: 'Previous note in the sidebar', group: 'Navigate' },
  { id: 'palette', keys: 'Ctrl+K', label: 'Command palette', group: 'Navigate' },
  { id: 'switcher', keys: 'Ctrl+P', label: 'Quick-switch note', group: 'Navigate' },
  { id: 'find', keys: 'Ctrl+F', label: 'Find in this note', group: 'Navigate', editorOnly: true },
  { id: 'search', keys: 'Ctrl+Shift+F', label: 'Search every note', group: 'Navigate' },
  { id: 'actions.open', keys: 'Ctrl+0', label: 'Open Actions', group: 'Navigate' },
  { id: 'actions.board', keys: 'Ctrl+Shift+B', label: 'Actions as list or board', group: 'Navigate' },
  { id: 'actions.timeline', keys: 'Ctrl+Shift+G', label: 'Actions as a timeline', group: 'Navigate' },

  { id: 'fmt.bold', keys: 'Ctrl+B', label: 'Bold', group: 'Format', editorOnly: true },
  { id: 'fmt.italic', keys: 'Ctrl+I', label: 'Italic', group: 'Format', editorOnly: true },
  { id: 'fmt.underline', keys: 'Ctrl+U', label: 'Underline', group: 'Format', editorOnly: true },
  { id: 'fmt.strike', keys: 'Ctrl+Shift+X', label: 'Strikethrough', group: 'Format', editorOnly: true },
  { id: 'fmt.ul', keys: 'Ctrl+Shift+8', label: 'Bullet list', group: 'Format', editorOnly: true },
  { id: 'fmt.ol', keys: 'Ctrl+Shift+7', label: 'Numbered list', group: 'Format', editorOnly: true },
  { id: 'fmt.bigger', keys: 'Ctrl+]', label: 'Bigger text', group: 'Format', editorOnly: true },
  { id: 'fmt.smaller', keys: 'Ctrl+[', label: 'Smaller text', group: 'Format', editorOnly: true },
  { id: 'fmt.clear', keys: 'Ctrl+Space', label: 'Clear formatting', group: 'Format', editorOnly: true },

  { id: 'action.make', keys: 'Ctrl+Shift+A', label: 'Make selection an action', group: 'Actions', editorOnly: true },

  { id: 'view.archived', keys: 'Ctrl+Shift+E', label: 'Show or hide archived', group: 'View' },
  { id: 'view.focus', keys: 'F11', label: 'Focus mode', group: 'View' },
  { id: 'view.theme', keys: '', label: 'Switch day / night', group: 'View' },
  { id: 'settings', keys: 'Ctrl+,', label: 'Settings', group: 'View' }
];

/** Normalized identity for one keydown, e.g. `ctrl+shift+a`. */
export function chord(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  parts.push(key);
  return parts.join('+');
}
