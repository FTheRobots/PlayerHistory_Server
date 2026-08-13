/**
 * Promote a user to owner (e.g. after accidental role change).
 * Usage: node scripts/promote-owner.mjs [username]
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const username = process.argv[2];
if (!username?.trim()) {
  console.error('Usage: node scripts/promote-owner.mjs <username>');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config.json');

let dbPath = path.join(root, 'data', 'player-history.db');
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.dbPath) dbPath = path.resolve(root, config.dbPath);
  } catch {
    // use default
  }
}

const db = new Database(dbPath);
const user = db.prepare('SELECT id, username, role FROM users WHERE username = ? COLLATE NOCASE').get(username);

if (!user) {
  console.error(`User not found: ${username}`);
  process.exit(1);
}

db.prepare(`UPDATE users SET role = 'owner', permission_grants = '[]', permission_denies = '[]', updated_at = datetime('now') WHERE id = ?`).run(user.id);
db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(user.id);

const updated = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(user.id);
console.log(`Promoted to owner: ${updated.username} (id=${updated.id}, role=${updated.role})`);
console.log('Sign out and sign in again in the web client to refresh permissions.');
