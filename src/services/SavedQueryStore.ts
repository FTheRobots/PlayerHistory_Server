import type Database from 'better-sqlite3';
import type { EventQueryRequest, QueryWatchAlert, SavedQueryRecord } from '../types/query.js';
import type { QueryService } from './QueryService.js';

export class SavedQueryStore {
  constructor(private readonly db: Database.Database) {}

  list(userId: number, instanceId: string): SavedQueryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, instance_id, name, description, query_json, is_watch,
                last_match_count, last_watch_at, created_at, updated_at
         FROM saved_queries WHERE user_id = ? AND instance_id = ? ORDER BY updated_at DESC`
      )
      .all(userId, instanceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  get(userId: number, id: number): SavedQueryRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id, instance_id, name, description, query_json, is_watch,
                last_match_count, last_watch_at, created_at, updated_at
         FROM saved_queries WHERE id = ? AND user_id = ?`
      )
      .get(id, userId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  create(
    userId: number,
    instanceId: string,
    name: string,
    query: EventQueryRequest,
    description?: string,
    isWatch = false
  ): SavedQueryRecord {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO saved_queries (user_id, instance_id, name, description, query_json, is_watch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(userId, instanceId, name, description ?? null, JSON.stringify(query), isWatch ? 1 : 0, now, now);
    return this.get(userId, Number(result.lastInsertRowid))!;
  }

  update(
    userId: number,
    id: number,
    patch: { name?: string; description?: string; query?: EventQueryRequest; isWatch?: boolean }
  ): SavedQueryRecord | null {
    const existing = this.get(userId, id);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE saved_queries SET name = ?, description = ?, query_json = ?, is_watch = ?, updated_at = ? WHERE id = ? AND user_id = ?`
      )
      .run(
        patch.name ?? existing.name,
        patch.description !== undefined ? patch.description : existing.description ?? null,
        JSON.stringify(patch.query ?? existing.query),
        (patch.isWatch ?? existing.isWatch) ? 1 : 0,
        now,
        id,
        userId
      );
    return this.get(userId, id);
  }

  delete(userId: number, id: number): boolean {
    return this.db.prepare('DELETE FROM saved_queries WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  checkWatches(instanceId: string, queryService: QueryService): void {
    const rows = this.db
      .prepare(`SELECT * FROM saved_queries WHERE instance_id = ? AND is_watch = 1`)
      .all(instanceId) as Array<Record<string, unknown>>;

    const now = new Date().toISOString();
    for (const row of rows) {
      const query = JSON.parse(String(row.query_json)) as EventQueryRequest;
      const countResult = queryService.execute(instanceId, { ...query, mode: 'count' });
      const count = countResult.count ?? 0;
      const prev = row.last_match_count != null ? Number(row.last_match_count) : null;
      const userId = Number(row.user_id);
      const savedId = Number(row.id);
      const name = String(row.name);

      if (prev != null && count > prev) {
        this.db
          .prepare(
            `INSERT INTO query_watch_alerts (user_id, saved_query_id, instance_id, message, match_count, previous_count, created_at, read_flag)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
          )
          .run(
            userId,
            savedId,
            instanceId,
            `Watch "${name}": ${count} matches (+${count - prev} new)`,
            count,
            prev,
            now
          );
      }

      this.db
        .prepare(`UPDATE saved_queries SET last_match_count = ?, last_watch_at = ? WHERE id = ?`)
        .run(count, now, savedId);
    }
  }

  listWatchAlerts(userId: number, unreadOnly = false): QueryWatchAlert[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, saved_query_id, instance_id, message, match_count, previous_count, created_at, read_flag
         FROM query_watch_alerts WHERE user_id = ? ${unreadOnly ? 'AND read_flag = 0' : ''}
         ORDER BY created_at DESC LIMIT 50`
      )
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      userId: Number(r.user_id),
      savedQueryId: Number(r.saved_query_id),
      instanceId: String(r.instance_id),
      message: String(r.message),
      matchCount: Number(r.match_count),
      previousCount: Number(r.previous_count),
      createdAt: String(r.created_at),
      read: Number(r.read_flag) === 1,
    }));
  }

  markAlertRead(userId: number, alertId: number): void {
    this.db.prepare('UPDATE query_watch_alerts SET read_flag = 1 WHERE id = ? AND user_id = ?').run(alertId, userId);
  }

  markAllAlertsRead(userId: number): void {
    this.db.prepare('UPDATE query_watch_alerts SET read_flag = 1 WHERE user_id = ?').run(userId);
  }

  private mapRow(r: Record<string, unknown>): SavedQueryRecord {
    return {
      id: Number(r.id),
      userId: Number(r.user_id),
      instanceId: String(r.instance_id),
      name: String(r.name),
      description: r.description ? String(r.description) : undefined,
      query: JSON.parse(String(r.query_json)) as EventQueryRequest,
      isWatch: Number(r.is_watch) === 1,
      lastMatchCount: r.last_match_count != null ? Number(r.last_match_count) : undefined,
      lastWatchAt: r.last_watch_at ? String(r.last_watch_at) : undefined,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
}
