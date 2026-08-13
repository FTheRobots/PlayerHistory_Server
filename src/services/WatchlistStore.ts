import type Database from 'better-sqlite3';

export type WatchlistScope = 'global' | 'personal';

export interface WatchlistEntry {
  id: number;
  steamId: string;
  scope: WatchlistScope;
  userId: number | null;
  note: string;
  alertOnJoin: boolean;
  alertOnLeave: boolean;
  alertOnDeath: boolean;
  alertOnKill: boolean;
  alertOnBan: boolean;
  createdAt: string;
  createdByUserId: number | null;
  createdByUsername: string | null;
}

export interface WatchlistInput {
  steamId: string;
  scope: WatchlistScope;
  userId?: number | null;
  note?: string;
  alertOnJoin?: boolean;
  alertOnLeave?: boolean;
  alertOnDeath?: boolean;
  alertOnKill?: boolean;
  alertOnBan?: boolean;
  createdByUserId?: number | null;
  createdByUsername?: string | null;
}

export interface WatchlistUpdate {
  note?: string;
  alertOnJoin?: boolean;
  alertOnLeave?: boolean;
  alertOnDeath?: boolean;
  alertOnKill?: boolean;
  alertOnBan?: boolean;
}

export class WatchlistStore {
  constructor(private readonly db: Database.Database) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watchlist_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        steam_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'personal')),
        user_id INTEGER,
        note TEXT NOT NULL DEFAULT '',
        alert_on_join INTEGER NOT NULL DEFAULT 1,
        alert_on_leave INTEGER NOT NULL DEFAULT 0,
        alert_on_death INTEGER NOT NULL DEFAULT 1,
        alert_on_kill INTEGER NOT NULL DEFAULT 0,
        alert_on_ban INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by_user_id INTEGER,
        created_by_username TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_watchlist_steam ON watchlist_entries(steam_id);
      CREATE INDEX IF NOT EXISTS idx_watchlist_scope ON watchlist_entries(scope, user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_global_steam ON watchlist_entries(steam_id) WHERE scope = 'global';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_personal_steam ON watchlist_entries(steam_id, user_id) WHERE scope = 'personal';
    `);
  }

  private mapRow(row: {
    id: number;
    steam_id: string;
    scope: WatchlistScope;
    user_id: number | null;
    note: string;
    alert_on_join: number;
    alert_on_leave: number;
    alert_on_death: number;
    alert_on_kill: number;
    alert_on_ban: number;
    created_at: string;
    created_by_user_id: number | null;
    created_by_username: string | null;
  }): WatchlistEntry {
    return {
      id: row.id,
      steamId: row.steam_id,
      scope: row.scope,
      userId: row.user_id,
      note: row.note,
      alertOnJoin: row.alert_on_join === 1,
      alertOnLeave: row.alert_on_leave === 1,
      alertOnDeath: row.alert_on_death === 1,
      alertOnKill: row.alert_on_kill === 1,
      alertOnBan: row.alert_on_ban === 1,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
      createdByUsername: row.created_by_username,
    };
  }

  listForUser(viewerUserId: number): WatchlistEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM watchlist_entries
         WHERE scope = 'global' OR (scope = 'personal' AND user_id = ?)
         ORDER BY scope ASC, created_at DESC`
      )
      .all(viewerUserId) as Array<Parameters<WatchlistStore['mapRow']>[0]>;
    return rows.map((row) => this.mapRow(row));
  }

  listAllActive(): WatchlistEntry[] {
    const rows = this.db.prepare('SELECT * FROM watchlist_entries ORDER BY created_at DESC').all() as Array<
      Parameters<WatchlistStore['mapRow']>[0]
    >;
    return rows.map((row) => this.mapRow(row));
  }

  findById(id: number): WatchlistEntry | null {
    const row = this.db.prepare('SELECT * FROM watchlist_entries WHERE id = ?').get(id) as
      | Parameters<WatchlistStore['mapRow']>[0]
      | undefined;
    return row ? this.mapRow(row) : null;
  }

  findMatching(steamId: string): WatchlistEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM watchlist_entries WHERE steam_id = ?')
      .all(steamId) as Array<Parameters<WatchlistStore['mapRow']>[0]>;
    return rows.map((row) => this.mapRow(row));
  }

  create(input: WatchlistInput): WatchlistEntry {
    const createdAt = new Date().toISOString();
    const userId = input.scope === 'personal' ? (input.userId ?? null) : null;

    const result = this.db
      .prepare(
        `INSERT INTO watchlist_entries (
          steam_id, scope, user_id, note,
          alert_on_join, alert_on_leave, alert_on_death, alert_on_kill, alert_on_ban,
          created_at, created_by_user_id, created_by_username
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.steamId.trim(),
        input.scope,
        userId,
        input.note?.trim() ?? '',
        input.alertOnJoin !== false ? 1 : 0,
        input.alertOnLeave ? 1 : 0,
        input.alertOnDeath !== false ? 1 : 0,
        input.alertOnKill ? 1 : 0,
        input.alertOnBan !== false ? 1 : 0,
        createdAt,
        input.createdByUserId ?? null,
        input.createdByUsername ?? null
      );

    return this.findById(Number(result.lastInsertRowid))!;
  }

  update(id: number, update: WatchlistUpdate): WatchlistEntry | null {
    const existing = this.findById(id);
    if (!existing) return null;

    const next = {
      note: update.note ?? existing.note,
      alertOnJoin: update.alertOnJoin ?? existing.alertOnJoin,
      alertOnLeave: update.alertOnLeave ?? existing.alertOnLeave,
      alertOnDeath: update.alertOnDeath ?? existing.alertOnDeath,
      alertOnKill: update.alertOnKill ?? existing.alertOnKill,
      alertOnBan: update.alertOnBan ?? existing.alertOnBan,
    };

    this.db
      .prepare(
        `UPDATE watchlist_entries SET
          note = ?, alert_on_join = ?, alert_on_leave = ?, alert_on_death = ?, alert_on_kill = ?, alert_on_ban = ?
         WHERE id = ?`
      )
      .run(
        next.note,
        next.alertOnJoin ? 1 : 0,
        next.alertOnLeave ? 1 : 0,
        next.alertOnDeath ? 1 : 0,
        next.alertOnKill ? 1 : 0,
        next.alertOnBan ? 1 : 0,
        id
      );

    return this.findById(id);
  }

  delete(id: number): boolean {
    const result = this.db.prepare('DELETE FROM watchlist_entries WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
