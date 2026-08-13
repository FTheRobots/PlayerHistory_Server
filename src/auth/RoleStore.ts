import type Database from 'better-sqlite3';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_TEMPLATES,
  PERMISSIONS,
  type Permission,
} from './permissions.js';

export interface RoleRecord {
  id: number;
  name: string;
  slug: string;
  permissions: string[];
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RolePublic {
  id: number;
  name: string;
  slug: string;
  permissions: string[];
  isSystem: boolean;
  userCount: number;
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

function rowToRecord(row: Record<string, unknown>): RoleRecord {
  return {
    id: row.id as number,
    name: row.name as string,
    slug: row.slug as string,
    permissions: parseJsonArray(row.permissions as string),
    isSystem: Boolean(row.is_system),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function slugifyRoleName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

export class RoleStore {
  constructor(private readonly db: Database.Database) {
    this.ensureSchema();
    this.seedDefaultRoles();
    this.removeLegacyDefaultRoles();
    this.syncOwnerPermissions();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
        permissions TEXT NOT NULL DEFAULT '[]',
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_roles_slug ON roles(slug);
    `);
  }

  private seedDefaultRoles(): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO roles (name, slug, permissions, is_system)
       VALUES (?, ?, ?, 1)`
    );

    for (const template of DEFAULT_ROLE_TEMPLATES) {
      insert.run(template.name, template.slug, JSON.stringify(template.permissions));
    }
  }

  /** Ensure owner role always has every permission (including newly added ones). */
  private syncOwnerPermissions(): void {
    const owner = this.findBySlug('owner');
    if (!owner) return;

    const merged = new Set([...owner.permissions, ...ALL_PERMISSIONS]);
    const perms = [...merged].filter((p) => ALL_PERMISSIONS.includes(p as Permission));
    if (perms.length === owner.permissions.length && owner.permissions.every((p) => merged.has(p))) {
      return;
    }

    this.db
      .prepare(`UPDATE roles SET permissions = ?, updated_at = datetime('now') WHERE slug = 'owner' COLLATE NOCASE`)
      .run(JSON.stringify(perms));
  }

  /** Remove pre-v2 built-in roles (admin, moderator, viewer) so owners define their own. */
  private removeLegacyDefaultRoles(): void {
    const legacy = ['admin', 'moderator', 'viewer'];
    for (const slug of legacy) {
      if (this.countUsersWithRole(slug) === 0) {
        this.db.prepare('DELETE FROM roles WHERE slug = ? COLLATE NOCASE').run(slug);
      } else {
        this.db.prepare('UPDATE roles SET is_system = 0 WHERE slug = ? COLLATE NOCASE').run(slug);
      }
    }
  }

  listRoles(): RolePublic[] {
    const rows = this.db.prepare('SELECT * FROM roles ORDER BY is_system DESC, name COLLATE NOCASE').all() as Record<
      string,
      unknown
    >[];
    return rows.map((row) => this.toPublic(rowToRecord(row)));
  }

  findById(id: number): RoleRecord | null {
    const row = this.db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  findBySlug(slug: string): RoleRecord | null {
    const row = this.db
      .prepare('SELECT * FROM roles WHERE slug = ? COLLATE NOCASE')
      .get(slug) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  roleExists(slug: string): boolean {
    return this.findBySlug(slug) !== null;
  }

  getPermissionsForSlug(slug: string): Permission[] {
    const role = this.findBySlug(slug);
    if (!role) return [];
    const valid = role.permissions.filter((p) => ALL_PERMISSIONS.includes(p as Permission));
    return valid as Permission[];
  }

  countUsersWithRole(slug: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM users WHERE role = ? COLLATE NOCASE')
      .get(slug) as { c: number };
    return row.c;
  }

  createRole(name: string, slug: string, permissions: string[]): RoleRecord {
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim().toLowerCase();
    if (!trimmedName || !trimmedSlug) throw new Error('Name and slug are required');
    if (!/^[a-z0-9_]+$/.test(trimmedSlug)) {
      throw new Error('Slug must be lowercase letters, numbers, and underscores only');
    }
    if (this.roleExists(trimmedSlug)) throw new Error('Role slug already exists');

    const validPerms = permissions.filter((p) => ALL_PERMISSIONS.includes(p as Permission));
    const result = this.db
      .prepare(`INSERT INTO roles (name, slug, permissions) VALUES (?, ?, ?)`)
      .run(trimmedName, trimmedSlug, JSON.stringify(validPerms));

    const role = this.findById(Number(result.lastInsertRowid));
    if (!role) throw new Error('Failed to create role');
    return role;
  }

  updateRole(
    id: number,
    updates: { name?: string; permissions?: string[] }
  ): RoleRecord | null {
    const existing = this.findById(id);
    if (!existing) return null;

    const name = updates.name?.trim() ?? existing.name;
    let permissions = updates.permissions ?? existing.permissions;

    if (existing.slug === 'owner' && updates.permissions) {
      if (!permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        throw new Error('Owner role must include users.manage');
      }
    }

    permissions = permissions.filter((p) => ALL_PERMISSIONS.includes(p as Permission));

    this.db
      .prepare(
        `UPDATE roles SET name = ?, permissions = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(name, JSON.stringify(permissions), id);

    return this.findById(id);
  }

  deleteRole(id: number): boolean {
    const existing = this.findById(id);
    if (!existing) return false;
    if (existing.isSystem) throw new Error('Cannot delete a built-in role');
    if (this.countUsersWithRole(existing.slug) > 0) {
      throw new Error('Cannot delete a role that is assigned to users');
    }
    const result = this.db.prepare('DELETE FROM roles WHERE id = ?').run(id);
    return result.changes > 0;
  }

  toPublic(role: RoleRecord): RolePublic {
    return {
      id: role.id,
      name: role.name,
      slug: role.slug,
      permissions: role.permissions,
      isSystem: role.isSystem,
      userCount: this.countUsersWithRole(role.slug),
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    };
  }
}
