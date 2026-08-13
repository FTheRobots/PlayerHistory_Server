import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { RoleStore } from './RoleStore.js';

export interface UserRecord {
  id: number;
  username: string;
  passwordHash: string;
  role: string;
  permissionGrants: string[];
  permissionDenies: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UserPublic {
  id: number;
  username: string;
  role: string;
  permissionGrants: string[];
  permissionDenies: string[];
  createdAt: string;
  updatedAt: string;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rowToRecord(row: Record<string, unknown>): UserRecord {
  return {
    id: row.id as number,
    username: row.username as string,
    passwordHash: row.password_hash as string,
    role: row.role as string,
    permissionGrants: parseJsonArray(row.permission_grants as string),
    permissionDenies: parseJsonArray(row.permission_denies as string),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class UserStore {
  constructor(
    private readonly db: Database.Database,
    private readonly roleStore?: RoleStore
  ) {
    UserStore.ensureSchema(this.db);
  }

  static ensureSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'owner',
        permission_grants TEXT NOT NULL DEFAULT '[]',
        permission_denies TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
    `);
  }

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    return row.c;
  }

  listUsers(): UserPublic[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY username').all() as Record<string, unknown>[];
    return rows.map((r) => {
      const rec = rowToRecord(r);
      return this.toPublic(rec);
    });
  }

  findById(id: number): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  findByUsername(username: string): UserRecord | null {
    const row = this.db
      .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(username) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  createUser(username: string, passwordHash: string, role: string): UserRecord {
    if (this.roleStore && !this.roleStore.roleExists(role)) throw new Error('Invalid role');
    const result = this.db
      .prepare(
        `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`
      )
      .run(username.trim(), passwordHash, role);
    const user = this.findById(Number(result.lastInsertRowid));
    if (!user) throw new Error('Failed to create user');
    return user;
  }

  updateUser(
    id: number,
    updates: {
      passwordHash?: string;
      role?: string;
      permissionGrants?: string[];
      permissionDenies?: string[];
    }
  ): UserRecord | null {
    const existing = this.findById(id);
    if (!existing) return null;

    const role = updates.role ?? existing.role;
    if (this.roleStore && !this.roleStore.roleExists(role)) throw new Error('Invalid role');

    this.db
      .prepare(
        `UPDATE users SET
          password_hash = COALESCE(?, password_hash),
          role = ?,
          permission_grants = ?,
          permission_denies = ?,
          updated_at = datetime('now')
        WHERE id = ?`
      )
      .run(
        updates.passwordHash ?? null,
        role,
        JSON.stringify(updates.permissionGrants ?? existing.permissionGrants),
        JSON.stringify(updates.permissionDenies ?? existing.permissionDenies),
        id
      );
    return this.findById(id);
  }

  deleteUser(id: number): boolean {
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return result.changes > 0;
  }

  storeRefreshToken(userId: number, token: string, days: number): void {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    this.db
      .prepare('INSERT OR REPLACE INTO refresh_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, userId, expiresAt);
  }

  findRefreshToken(tokenHash: string): { userId: number; expiresAt: string } | null {
    const row = this.db
      .prepare('SELECT user_id, expires_at FROM refresh_tokens WHERE token_hash = ?')
      .get(tokenHash) as { user_id: number; expires_at: string } | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.revokeRefreshToken(tokenHash);
      return null;
    }
    return { userId: row.user_id, expiresAt: row.expires_at };
  }

  revokeRefreshToken(tokenHash: string): void {
    this.db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(tokenHash);
  }

  revokeAllForUser(userId: number): void {
    this.db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
  }

  toPublic(user: UserRecord): UserPublic {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      permissionGrants: user.permissionGrants,
      permissionDenies: user.permissionDenies,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
