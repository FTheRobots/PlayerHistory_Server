import type Database from 'better-sqlite3';
import type { WatchlistScope } from './WatchlistStore.js';

export type AlertEventType = 'join' | 'leave' | 'death' | 'kill' | 'ban';

export interface AlertRecord {
  id: number;
  createdAt: string;
  watchlistEntryId: number | null;
  steamId: string;
  playerName: string | null;
  eventType: AlertEventType;
  message: string;
  scope: WatchlistScope;
  userId: number | null;
  read: boolean;
}

export interface AlertInput {
  watchlistEntryId?: number | null;
  steamId: string;
  playerName?: string | null;
  eventType: AlertEventType;
  message: string;
  scope: WatchlistScope;
  userId?: number | null;
}

export class AlertStore {
  constructor(private readonly db: Database.Database) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        watchlist_entry_id INTEGER,
        steam_id TEXT NOT NULL,
        player_name TEXT,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        scope TEXT NOT NULL,
        user_id INTEGER,
        read_flag INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, read_flag);
    `);
  }

  create(input: AlertInput): AlertRecord {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO alerts (created_at, watchlist_entry_id, steam_id, player_name, event_type, message, scope, user_id, read_flag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        createdAt,
        input.watchlistEntryId ?? null,
        input.steamId,
        input.playerName ?? null,
        input.eventType,
        input.message,
        input.scope,
        input.userId ?? null
      );

    return {
      id: Number(result.lastInsertRowid),
      createdAt,
      watchlistEntryId: input.watchlistEntryId ?? null,
      steamId: input.steamId,
      playerName: input.playerName ?? null,
      eventType: input.eventType,
      message: input.message,
      scope: input.scope,
      userId: input.userId ?? null,
      read: false,
    };
  }

  listForUser(userId: number, limit = 50, offset = 0, unreadOnly = false): { data: AlertRecord[]; total: number } {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const safeOffset = Math.max(offset, 0);
    const readClause = unreadOnly ? 'AND read_flag = 0' : '';

    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c FROM alerts
           WHERE (scope = 'global' OR (scope = 'personal' AND user_id = ?)) ${readClause}`
        )
        .get(userId) as { c: number }
    ).c;

    const rows = this.db
      .prepare(
        `SELECT * FROM alerts
         WHERE (scope = 'global' OR (scope = 'personal' AND user_id = ?)) ${readClause}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(userId, safeLimit, safeOffset) as Array<{
      id: number;
      created_at: string;
      watchlist_entry_id: number | null;
      steam_id: string;
      player_name: string | null;
      event_type: AlertEventType;
      message: string;
      scope: WatchlistScope;
      user_id: number | null;
      read_flag: number;
    }>;

    return {
      total,
      data: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        watchlistEntryId: row.watchlist_entry_id,
        steamId: row.steam_id,
        playerName: row.player_name,
        eventType: row.event_type,
        message: row.message,
        scope: row.scope,
        userId: row.user_id,
        read: row.read_flag === 1,
      })),
    };
  }

  unreadCount(userId: number): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) as c FROM alerts
           WHERE read_flag = 0 AND (scope = 'global' OR (scope = 'personal' AND user_id = ?))`
        )
        .get(userId) as { c: number }
    ).c;
  }

  markRead(id: number, userId: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE alerts SET read_flag = 1
         WHERE id = ? AND (scope = 'global' OR (scope = 'personal' AND user_id = ?))`
      )
      .run(id, userId);
    return result.changes > 0;
  }

  markAllRead(userId: number): number {
    const result = this.db
      .prepare(
        `UPDATE alerts SET read_flag = 1
         WHERE read_flag = 0 AND (scope = 'global' OR (scope = 'personal' AND user_id = ?))`
      )
      .run(userId);
    return result.changes;
  }
}
