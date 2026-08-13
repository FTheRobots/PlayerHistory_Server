import type Database from 'better-sqlite3';

export interface AuditLogEntry {
  id: number;
  createdAt: string;
  userId: number | null;
  username: string | null;
  action: string;
  targetSteamId: string | null;
  targetLabel: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
}

export interface AuditLogQuery {
  limit?: number;
  offset?: number;
  action?: string;
  userId?: number;
  targetSteamId?: string;
  from?: string;
  to?: string;
}

export interface AuditLogInput {
  userId?: number | null;
  username?: string | null;
  action: string;
  targetSteamId?: string | null;
  targetLabel?: string | null;
  details?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export class AuditStore {
  constructor(private readonly db: Database.Database) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        target_steam_id TEXT,
        target_label TEXT,
        details_json TEXT,
        ip_address TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_steam_id);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
    `);
  }

  log(input: AuditLogInput): AuditLogEntry {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO audit_log (created_at, user_id, username, action, target_steam_id, target_label, details_json, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        createdAt,
        input.userId ?? null,
        input.username ?? null,
        input.action,
        input.targetSteamId ?? null,
        input.targetLabel ?? null,
        input.details ? JSON.stringify(input.details) : null,
        input.ipAddress ?? null
      );

    return {
      id: Number(result.lastInsertRowid),
      createdAt,
      userId: input.userId ?? null,
      username: input.username ?? null,
      action: input.action,
      targetSteamId: input.targetSteamId ?? null,
      targetLabel: input.targetLabel ?? null,
      details: input.details ?? null,
      ipAddress: input.ipAddress ?? null,
    };
  }

  list(query: AuditLogQuery = {}): { data: AuditLogEntry[]; total: number } {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.action?.trim()) {
      conditions.push('action = ?');
      params.push(query.action.trim());
    }
    if (query.userId != null) {
      conditions.push('user_id = ?');
      params.push(query.userId);
    }
    if (query.targetSteamId?.trim()) {
      conditions.push('target_steam_id = ?');
      params.push(query.targetSteamId.trim());
    }
    if (query.from) {
      conditions.push('created_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('created_at <= ?');
      params.push(query.to);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) as c FROM audit_log ${where}`).get(...params) as { c: number }
    ).c;

    const rows = this.db
      .prepare(
        `SELECT id, created_at, user_id, username, action, target_steam_id, target_label, details_json, ip_address
         FROM audit_log ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<{
      id: number;
      created_at: string;
      user_id: number | null;
      username: string | null;
      action: string;
      target_steam_id: string | null;
      target_label: string | null;
      details_json: string | null;
      ip_address: string | null;
    }>;

    return {
      total,
      data: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        userId: row.user_id,
        username: row.username,
        action: row.action,
        targetSteamId: row.target_steam_id,
        targetLabel: row.target_label,
        details: row.details_json ? (JSON.parse(row.details_json) as Record<string, unknown>) : null,
        ipAddress: row.ip_address,
      })),
    };
  }

  listActions(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT action FROM audit_log ORDER BY action')
      .all() as Array<{ action: string }>;
    return rows.map((r) => r.action);
  }
}
