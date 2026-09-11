// One-off repair: removes rows the end-to-end suite wrote into the live
// database before that suite learned to use JOTTER_DATA_DIR.
//
// This is deliberately a script and not a feature. Jotter itself has no delete,
// and it never will; the only thing that removes data is a human running
// something like this on purpose.
//
//   node scripts/clean-test-rows.mjs [--apply]

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';

const apply = process.argv.includes('--apply');
const dir = process.env.JOTTER_DATA_DIR ?? join(homedir(), 'Documents', 'Jotter');
const db = new DatabaseSync(join(dir, 'jotter.db'));

const TEST_TITLE = 'E2E probe';
const TEST_ACTION = 'call the plumber about the leak';
// The 1x1 PNG the image-store check pastes.
const TEST_IMAGE = 'c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77';

const notes = db.prepare('SELECT id, title FROM notes WHERE title = ?').all(TEST_TITLE);
const actions = db.prepare('SELECT id, text FROM actions WHERE text = ?').all(TEST_ACTION);
const images = db.prepare('SELECT hash, ext FROM images WHERE hash = ?').all(TEST_IMAGE);

console.log(`data dir: ${dir}`);
console.log(`test notes:   ${notes.map((n) => n.id).join(', ') || 'none'}`);
console.log(`test actions: ${actions.map((a) => a.id).join(', ') || 'none'}`);
console.log(`test images:  ${images.map((i) => i.hash.slice(0, 12)).join(', ') || 'none'}`);

if (!apply) {
  console.log('\ndry run — pass --apply to remove these');
  process.exit(0);
}

db.exec('BEGIN');
for (const a of actions) db.prepare('DELETE FROM actions WHERE id = ?').run(a.id);
for (const n of notes) {
  db.prepare('DELETE FROM actions WHERE note_id = ?').run(n.id);
  db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
}
for (const i of images) {
  db.prepare('DELETE FROM images WHERE hash = ?').run(i.hash);
  const file = join(dir, 'images', `${i.hash}.${i.ext}`);
  if (existsSync(file)) unlinkSync(file);
}
db.exec('COMMIT');

const left = db.prepare('SELECT COUNT(*) AS n FROM notes').get();
console.log(`\nremoved. notes remaining: ${left.n}`);
