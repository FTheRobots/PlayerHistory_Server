import type Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface DayZInstance {
  id: string;
  name: string;
  playerHistoryPath: string;
  createdAt: string;
}

export const DEFAULT_INSTANCE_ID = 'default';

export class InstanceStore {
  constructor(private readonly db: Database.Database) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dayz_instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        player_history_path TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  list(): DayZInstance[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, player_history_path, created_at
         FROM dayz_instances ORDER BY created_at ASC`
      )
      .all() as Array<{
      id: string;
      name: string;
      player_history_path: string;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      playerHistoryPath: r.player_history_path,
      createdAt: r.created_at,
    }));
  }

  getById(id: string): DayZInstance | null {
    const row = this.db
      .prepare(
        `SELECT id, name, player_history_path, created_at FROM dayz_instances WHERE id = ?`
      )
      .get(id) as
      | {
          id: string;
          name: string;
          player_history_path: string;
          created_at: string;
        }
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      playerHistoryPath: row.player_history_path,
      createdAt: row.created_at,
    };
  }

  getDefaultId(): string {
    const first = this.list()[0];
    return first?.id ?? DEFAULT_INSTANCE_ID;
  }

  ensureDefault(playerHistoryPath: string, name = 'Primary server'): DayZInstance {
    const normalized = path.normalize(playerHistoryPath);
    const existing = this.db
      .prepare(`SELECT id FROM dayz_instances WHERE player_history_path = ?`)
      .get(normalized) as { id: string } | undefined;

    if (existing) {
      return this.getById(existing.id)!;
    }

    const byDefault = this.getById(DEFAULT_INSTANCE_ID);
    if (byDefault) {
      this.db
        .prepare(`UPDATE dayz_instances SET player_history_path = ?, name = ? WHERE id = ?`)
        .run(normalized, name, DEFAULT_INSTANCE_ID);
      return this.getById(DEFAULT_INSTANCE_ID)!;
    }

    this.db
      .prepare(
        `INSERT INTO dayz_instances (id, name, player_history_path) VALUES (?, ?, ?)`
      )
      .run(DEFAULT_INSTANCE_ID, name, normalized);

    return this.getById(DEFAULT_INSTANCE_ID)!;
  }

  create(input: { name: string; playerHistoryPath: string }): DayZInstance {
    const normalized = path.normalize(input.playerHistoryPath.trim());
    if (!normalized) throw new Error('playerHistoryPath is required');

    const duplicate = this.db
      .prepare(`SELECT id FROM dayz_instances WHERE player_history_path = ?`)
      .get(normalized);
    if (duplicate) throw new Error('An instance with this path already exists');

    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO dayz_instances (id, name, player_history_path) VALUES (?, ?, ?)`
      )
      .run(id, input.name.trim() || 'DayZ server', normalized);

    return this.getById(id)!;
  }

  update(id: string, patch: { name?: string; playerHistoryPath?: string }): DayZInstance {
    const current = this.getById(id);
    if (!current) throw new Error('Instance not found');

    const name = patch.name?.trim() || current.name;
    const playerHistoryPath = patch.playerHistoryPath
      ? path.normalize(patch.playerHistoryPath.trim())
      : current.playerHistoryPath;

    if (!playerHistoryPath) throw new Error('playerHistoryPath is required');

    const duplicate = this.db
      .prepare(`SELECT id FROM dayz_instances WHERE player_history_path = ? AND id != ?`)
      .get(playerHistoryPath, id);
    if (duplicate) throw new Error('An instance with this path already exists');

    this.db
      .prepare(`UPDATE dayz_instances SET name = ?, player_history_path = ? WHERE id = ?`)
      .run(name, playerHistoryPath, id);

    return this.getById(id)!;
  }

  delete(id: string): void {
    const count = this.db.prepare(`SELECT COUNT(*) as c FROM dayz_instances`).get() as { c: number };
    if (count.c <= 1) {
      throw new Error('Cannot delete the last instance');
    }

    const result = this.db.prepare(`DELETE FROM dayz_instances WHERE id = ?`).run(id);
    if (result.changes === 0) throw new Error('Instance not found');
  }

  pathExists(playerHistoryPath: string): boolean {
    return fs.existsSync(playerHistoryPath);
  }
}
