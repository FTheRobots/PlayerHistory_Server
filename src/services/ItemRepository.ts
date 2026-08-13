import type { DatabaseService } from './DatabaseService.js';
import type { ContainerStorageEvent, PaginatedResult, PlayerEvent } from '../types/index.js';
import type { ItemSummary } from '../types/index.js';

export interface ContainerLocationQuery {
  x: number;
  z: number;
  radius?: number;
  containerPid?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

interface TrackedItemRow {
  item_pid: string;
  item_name: string | null;
  item_classname: string | null;
  event_count: number;
  first_seen: string | null;
  last_seen: string | null;
  last_player_steam_id: string | null;
  last_player_name: string | null;
}

export class ItemRepository {
  constructor(private readonly dbService: DatabaseService) {}

  getItemSummary(instanceId: string, pid: string): ItemSummary | null {
    const db = this.dbService.getDb();
    const row = db
      .prepare(
        `SELECT item_pid, item_name, item_classname, event_count, first_seen, last_seen,
                last_player_steam_id, last_player_name
         FROM tracked_items
         WHERE instance_id = ? AND item_pid = ?`
      )
      .get(instanceId, pid) as TrackedItemRow | undefined;

    if (row) return this.trackedRowToSummary(row);

    return this.summarizeItemFromEvents(instanceId, pid);
  }

  getItemTimeline(instanceId: string, pid: string, limit = 200, offset = 0): PaginatedResult<PlayerEvent> {
    const db = this.dbService.getDb();
    const capped = Math.min(Math.max(limit, 1), 500);

    const indexed = db
      .prepare('SELECT event_count FROM tracked_items WHERE instance_id = ? AND item_pid = ?')
      .get(instanceId, pid) as { event_count: number } | undefined;

    const rows = db
      .prepare(
        `SELECT timestamp, steam_id, event, category, session_id, player_name,
                position_x, position_y, position_z, orientation, metadata_json
         FROM events
         WHERE instance_id = ? AND item_pid = ?
         ORDER BY timestamp ASC
         LIMIT ? OFFSET ?`
      )
      .all(instanceId, pid, capped + 1, offset) as Array<Record<string, unknown>>;

    const hasMoreByFetch = rows.length > capped;
    const page = hasMoreByFetch ? rows.slice(0, capped) : rows;
    const total = indexed?.event_count ?? offset + page.length + (hasMoreByFetch ? 1 : 0);

    return {
      data: page.map((r) => this.rowToEvent(r)),
      total,
      limit: capped,
      offset,
      hasMore: hasMoreByFetch || offset + page.length < total,
    };
  }

  searchItems(instanceId: string, search?: string, steamId?: string, limit = 30): ItemSummary[] {
    const db = this.dbService.getDb();
    const capped = Math.min(Math.max(limit, 1), 100);
    const trimmed = search?.trim() ?? '';

    const searchSql = trimmed
      ? /^\d+(-\d+)*$/.test(trimmed)
        ? '(ti.item_pid = ? OR ti.item_pid LIKE ?)'
        : '(ti.item_name LIKE ? OR ti.item_classname LIKE ? OR ti.item_pid LIKE ?)'
      : '';
    const searchParams: unknown[] = trimmed
      ? /^\d+(-\d+)*$/.test(trimmed)
        ? [trimmed, `${trimmed}%`]
        : [`%${trimmed}%`, `%${trimmed}%`, `%${trimmed}%`]
      : [];

    if (steamId) {
      const rows = db
        .prepare(
          `SELECT ti.item_pid, ti.item_name, ti.item_classname, ti.event_count,
                  ti.first_seen, ti.last_seen, ti.last_player_steam_id, ti.last_player_name
           FROM tracked_items ti
           INNER JOIN (
             SELECT item_pid
             FROM events
             WHERE instance_id = ? AND steam_id = ? AND item_pid IS NOT NULL
             GROUP BY item_pid
             ORDER BY MAX(timestamp) DESC
             LIMIT 2000
           ) p ON p.item_pid = ti.item_pid
           WHERE ti.instance_id = ?
             ${searchSql ? `AND ${searchSql}` : ''}
           ORDER BY ti.last_seen DESC
           LIMIT ?`
        )
        .all(instanceId, steamId, instanceId, ...searchParams, capped) as TrackedItemRow[];
      return rows.map((row) => this.trackedRowToSummary(row));
    }

    const rows = db
      .prepare(
        `SELECT ti.item_pid, ti.item_name, ti.item_classname, ti.event_count,
                ti.first_seen, ti.last_seen, ti.last_player_steam_id, ti.last_player_name
         FROM tracked_items ti
         WHERE ti.instance_id = ?
           ${searchSql ? `AND ${searchSql}` : ''}
         ORDER BY ti.last_seen DESC
         LIMIT ?`
      )
      .all(instanceId, ...searchParams, capped) as TrackedItemRow[];

    return rows.map((row) => this.trackedRowToSummary(row));
  }

  listPlayerItems(instanceId: string, steamId: string, limit = 50): ItemSummary[] {
    return this.searchItems(instanceId, undefined, steamId, limit);
  }

  getEventsAtContainer(instanceId: string, query: ContainerLocationQuery): PaginatedResult<ContainerStorageEvent> {
    const db = this.dbService.getDb();
    const radius = query.radius ?? 0.5;
    const radiusSq = radius * radius;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const conditions: string[] = [
      'instance_id = ?',
      `(item_pid IS NOT NULL OR item_classname IS NOT NULL)`,
      `(
        (to_container_x IS NOT NULL AND to_container_z IS NOT NULL
          AND ((to_container_x - ?) * (to_container_x - ?) + (to_container_z - ?) * (to_container_z - ?)) <= ?)
        OR
        (from_container_x IS NOT NULL AND from_container_z IS NOT NULL
          AND ((from_container_x - ?) * (from_container_x - ?) + (from_container_z - ?) * (from_container_z - ?)) <= ?)
      )`,
    ];
    const params: unknown[] = [
      instanceId,
      query.x,
      query.x,
      query.z,
      query.z,
      radiusSq,
      query.x,
      query.x,
      query.z,
      query.z,
      radiusSq,
    ];

    if (query.containerPid?.trim()) {
      conditions.push('(to_container_pid = ? OR from_container_pid = ?)');
      params.push(query.containerPid.trim(), query.containerPid.trim());
    }
    if (query.from) {
      conditions.push('timestamp >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('timestamp <= ?');
      params.push(query.to);
    }

    const where = conditions.join(' AND ');

    const total = (
      db.prepare(`SELECT COUNT(*) as c FROM events WHERE ${where}`).get(...params) as { c: number }
    ).c;

    const rows = db
      .prepare(
        `SELECT timestamp, steam_id, event, category, session_id, player_name,
                position_x, position_y, position_z, orientation, metadata_json,
                from_container_x, from_container_y, from_container_z,
                to_container_x, to_container_y, to_container_z,
                from_container_pid, to_container_pid
         FROM events
         WHERE ${where}
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      data: rows.map((row) => this.rowToContainerStorageEvent(row, query.x, query.z, radiusSq)),
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    };
  }

  private rowToContainerStorageEvent(
    r: Record<string, unknown>,
    queryX: number,
    queryZ: number,
    radiusSq: number
  ): ContainerStorageEvent {
    const event = this.rowToEvent(r);
    const meta = event.metadata ?? {};

    const toX = r.to_container_x as number | null;
    const toZ = r.to_container_z as number | null;
    const fromX = r.from_container_x as number | null;
    const fromZ = r.from_container_z as number | null;

    const toDistSq =
      toX != null && toZ != null ? (toX - queryX) * (toX - queryX) + (toZ - queryZ) * (toZ - queryZ) : Infinity;
    const fromDistSq =
      fromX != null && fromZ != null
        ? (fromX - queryX) * (fromX - queryX) + (fromZ - queryZ) * (fromZ - queryZ)
        : Infinity;

    const intoContainer = toDistSq <= fromDistSq && toDistSq <= radiusSq;
    const direction: ContainerStorageEvent['direction'] = intoContainer ? 'into' : 'out_of';

    const containerPid = (
      intoContainer ? (r.to_container_pid as string | null) : (r.from_container_pid as string | null)
    )?.trim();
    const cx = intoContainer ? toX : fromX;
    const cy = intoContainer ? (r.to_container_y as number) : (r.from_container_y as number);
    const cz = intoContainer ? toZ : fromZ;

    const containerClass = intoContainer
      ? meta.toEntity ?? meta.to
      : meta.fromEntity ?? meta.from;

    return {
      direction,
      containerPid: containerPid || undefined,
      containerPosition: [cx ?? queryX, cy ?? 0, cz ?? queryZ],
      containerClass: containerClass && !containerClass.startsWith('Player:') ? containerClass : undefined,
      event,
    };
  }

  private rowToEvent(r: Record<string, unknown>): PlayerEvent {
    const event: PlayerEvent = {
      timestamp: r.timestamp as string,
      steamid: r.steam_id as string,
      event: r.event as string,
    };

    if (r.category) event.category = r.category as string;
    if (r.session_id) event.sessionId = r.session_id as string;
    if (r.player_name) event.playerName = r.player_name as string;

    if (r.position_x != null && r.position_y != null && r.position_z != null) {
      event.position = [r.position_x as number, r.position_y as number, r.position_z as number];
    }
    if (r.orientation != null) event.orientation = r.orientation as number;
    if (r.metadata_json) {
      try {
        event.metadata = JSON.parse(r.metadata_json as string);
      } catch {
        // skip
      }
    }

    return event;
  }

  private trackedRowToSummary(row: TrackedItemRow): ItemSummary {
    return {
      pid: row.item_pid,
      name: row.item_name ?? undefined,
      classname: row.item_classname ?? undefined,
      eventCount: row.event_count,
      firstSeen: row.first_seen ?? undefined,
      lastSeen: row.last_seen ?? undefined,
      lastPlayerSteamId: row.last_player_steam_id ?? undefined,
      lastPlayerName: row.last_player_name ?? undefined,
    };
  }

  /** Fallback when the denormalized index has not caught up yet. */
  private summarizeItemFromEvents(instanceId: string, pid: string): ItemSummary | null {
    const db = this.dbService.getDb();
    const row = db
      .prepare(
        `SELECT item_pid, item_name, item_classname, steam_id, player_name, timestamp
         FROM events
         WHERE instance_id = ? AND item_pid = ?
         ORDER BY timestamp DESC
         LIMIT 1`
      )
      .get(instanceId, pid) as
      | {
          item_pid: string;
          item_name: string | null;
          item_classname: string | null;
          steam_id: string;
          player_name: string | null;
          timestamp: string;
        }
      | undefined;

    if (!row) return null;

    const bounds = db
      .prepare(
        `SELECT COUNT(*) as event_count, MIN(timestamp) as first_seen, MAX(timestamp) as last_seen
         FROM events WHERE instance_id = ? AND item_pid = ?`
      )
      .get(instanceId, pid) as { event_count: number; first_seen: string | null; last_seen: string | null };

    return {
      pid: row.item_pid,
      name: row.item_name ?? undefined,
      classname: row.item_classname ?? undefined,
      eventCount: bounds.event_count,
      firstSeen: bounds.first_seen ?? undefined,
      lastSeen: bounds.last_seen ?? undefined,
      lastPlayerSteamId: row.steam_id,
      lastPlayerName: row.player_name ?? undefined,
    };
  }
}
