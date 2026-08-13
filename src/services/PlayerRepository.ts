import type { DatabaseService } from './DatabaseService.js';
import type {
  PlayerEvent,
  PlayerProfile,
  PlayerSummary,
  TimelineQuery,
  MultiTimelineQuery,
  PaginatedResult,
  EventStatistics,
  OnlinePlayerDetail,
  ChatMessage,
  ChatTab,
} from '../types/index.js';
import { formatEventLabel } from '../utils/eventFormat.js';
import { enrichEventItemFields } from '../utils/itemExtract.js';

export class PlayerRepository {
  constructor(private readonly dbService: DatabaseService) {}

  listPlayers(instanceId: string, search?: string, limit = 50, offset = 0): PaginatedResult<PlayerSummary> {
    const db = this.dbService.getDb();
    let where = 'WHERE instance_id = ?';
    const params: unknown[] = [instanceId];

    if (search) {
      where += ' AND (steam_id LIKE ? OR character_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    const total = (
      db.prepare(`SELECT COUNT(*) as c FROM players ${where}`).get(...params) as { c: number }
    ).c;

    const rows = db
      .prepare(
        `SELECT steam_id, character_name, first_seen, last_seen, total_events, profile_json
         FROM players ${where}
         ORDER BY last_seen DESC NULLS LAST
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<{
      steam_id: string;
      character_name: string | null;
      first_seen: string | null;
      last_seen: string | null;
      total_events: number;
      profile_json: string | null;
    }>;

    return {
      data: rows.map((r) => ({
        steamId: r.steam_id,
        characterName: r.character_name ?? undefined,
        firstSeen: r.first_seen ?? undefined,
        lastSeen: r.last_seen ?? undefined,
        totalEvents: r.total_events,
        isOnline: this.readIsOnline(r.profile_json),
      })),
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    };
  }

  private readIsOnline(profileJson: string | null): boolean {
    if (!profileJson) return false;
    try {
      const profile = JSON.parse(profileJson) as PlayerProfile;
      return profile.isOnline === true;
    } catch {
      return false;
    }
  }

  getPlayer(instanceId: string, steamId: string): PlayerProfile | null {
    const db = this.dbService.getDb();
    const row = db
      .prepare('SELECT profile_json, character_name, first_seen, last_seen FROM players WHERE instance_id = ? AND steam_id = ?')
      .get(instanceId, steamId) as {
      profile_json: string | null;
      character_name: string | null;
      first_seen: string | null;
      last_seen: string | null;
    } | undefined;

    if (!row) return null;

    if (row.profile_json) {
      try {
        return JSON.parse(row.profile_json) as PlayerProfile;
      } catch {
        // fall through
      }
    }

    return {
      steamId,
      characterName: row.character_name ?? undefined,
      firstSeen: row.first_seen ?? undefined,
      lastSeen: row.last_seen ?? undefined,
    };
  }

  getTimeline(instanceId: string, query: TimelineQuery): PaginatedResult<PlayerEvent> {
    const db = this.dbService.getDb();
    const conditions = ['instance_id = ?', 'steam_id = ?'];
    const params: unknown[] = [instanceId, query.steamid];

    if (query.event) {
      conditions.push('event = ?');
      params.push(query.event);
    }
    if (query.category) {
      conditions.push('category = ?');
      params.push(query.category);
    }
    if (query.from) {
      conditions.push('timestamp >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('timestamp <= ?');
      params.push(query.to);
    }
    if (query.search) {
      conditions.push('(event LIKE ? OR metadata_json LIKE ? OR player_name LIKE ?)');
      const s = `%${query.search}%`;
      params.push(s, s, s);
    }

    const where = conditions.join(' AND ');
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const total = (
      db.prepare(`SELECT COUNT(*) as c FROM events WHERE ${where}`).get(...params) as { c: number }
    ).c;

    const rows = db
      .prepare(
        `SELECT timestamp, steam_id, event, category, session_id, player_name,
                position_x, position_y, position_z, orientation, metadata_json
         FROM events WHERE ${where}
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    const data = rows.map((r) => this.rowToEvent(r));

    return { data, total, limit, offset, hasMore: offset + limit < total };
  }

  getMultiTimeline(instanceId: string, query: MultiTimelineQuery): PaginatedResult<PlayerEvent> {
    const steamIds = [...new Set(query.steamids.filter(Boolean))];
    if (steamIds.length === 0) {
      const limit = query.limit ?? 100;
      const offset = query.offset ?? 0;
      return { data: [], total: 0, limit, offset, hasMore: false };
    }

    const db = this.dbService.getDb();
    const placeholders = steamIds.map(() => '?').join(', ');
    const conditions = ['instance_id = ?', `steam_id IN (${placeholders})`];
    const params: unknown[] = [instanceId, ...steamIds];

    if (query.event) {
      conditions.push('event = ?');
      params.push(query.event);
    }
    if (query.category) {
      conditions.push('category = ?');
      params.push(query.category);
    }
    if (query.from) {
      conditions.push('timestamp >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('timestamp <= ?');
      params.push(query.to);
    }
    if (query.search) {
      conditions.push('(event LIKE ? OR metadata_json LIKE ? OR player_name LIKE ?)');
      const s = `%${query.search}%`;
      params.push(s, s, s);
    }

    const where = conditions.join(' AND ');
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const total = (
      db.prepare(`SELECT COUNT(*) as c FROM events WHERE ${where}`).get(...params) as { c: number }
    ).c;

    const rows = db
      .prepare(
        `SELECT timestamp, steam_id, event, category, session_id, player_name,
                position_x, position_y, position_z, orientation, metadata_json
         FROM events WHERE ${where}
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    const data = rows.map((r) => this.rowToEvent(r));

    return { data, total, limit, offset, hasMore: offset + limit < total };
  }

  getStatistics(instanceId: string, steamId: string): EventStatistics {
    const db = this.dbService.getDb();

    const total = (
      db.prepare('SELECT COUNT(*) as c FROM events WHERE instance_id = ? AND steam_id = ?').get(instanceId, steamId) as { c: number }
    ).c;

    const byCategory = db
      .prepare(
        `SELECT category, COUNT(*) as c FROM events WHERE instance_id = ? AND steam_id = ? AND category IS NOT NULL GROUP BY category`
      )
      .all(instanceId, steamId) as Array<{ category: string; c: number }>;

    const byType = db
      .prepare(`SELECT event, COUNT(*) as c FROM events WHERE instance_id = ? AND steam_id = ? GROUP BY event ORDER BY c DESC LIMIT 50`)
      .all(instanceId, steamId) as Array<{ event: string; c: number }>;

    const range = db
      .prepare(`SELECT MIN(timestamp) as first, MAX(timestamp) as last FROM events WHERE instance_id = ? AND steam_id = ?`)
      .get(instanceId, steamId) as { first: string | null; last: string | null };

    const deaths = (
      db
        .prepare(`SELECT COUNT(*) as c FROM events WHERE instance_id = ? AND steam_id = ? AND event = 'PlayerDeath'`)
        .get(instanceId, steamId) as { c: number }
    ).c;

    const kills = (
      db
        .prepare(`SELECT COUNT(*) as c FROM events WHERE instance_id = ? AND steam_id = ? AND event = 'PlayerKilled'`)
        .get(instanceId, steamId) as { c: number }
    ).c;

    const sessions = (
      db
        .prepare(`SELECT COUNT(*) as c FROM events WHERE instance_id = ? AND steam_id = ? AND event = 'Join'`)
        .get(instanceId, steamId) as { c: number }
    ).c;

    const animalKillRows = db
      .prepare(
        `SELECT event, COUNT(*) as c FROM events
         WHERE instance_id = ? AND steam_id = ? AND category = 'Animal' AND event LIKE '%Kill'
         GROUP BY event`
      )
      .all(instanceId, steamId) as Array<{ event: string; c: number }>;

    const animalKillCounts = Object.fromEntries(animalKillRows.map((r) => [r.event, r.c]));

    const killRows = db
      .prepare(
        `SELECT event, COUNT(*) as c FROM events
         WHERE instance_id = ? AND steam_id = ? AND event LIKE '%Kill'
         GROUP BY event`
      )
      .all(instanceId, steamId) as Array<{ event: string; c: number }>;

    const killCounts = Object.fromEntries(killRows.map((r) => [r.event, r.c]));

    return {
      steamId,
      totalEvents: total,
      eventsByCategory: Object.fromEntries(byCategory.map((r) => [r.category, r.c])),
      eventsByType: Object.fromEntries(byType.map((r) => [r.event, r.c])),
      firstEvent: range.first ?? undefined,
      lastEvent: range.last ?? undefined,
      deathCount: deaths,
      killCount: kills,
      sessionCount: sessions,
      animalKillCounts,
      killCounts,
    };
  }

  getKillFeed(instanceId: string, steamId: string, limit = 50): PlayerEvent[] {
    const db = this.dbService.getDb();
    const rows = db
      .prepare(
        `SELECT timestamp, steam_id, event, category, session_id, player_name,
                position_x, position_y, position_z, orientation, metadata_json
         FROM events
         WHERE instance_id = ? AND steam_id = ? AND (
           event IN ('PlayerDeath', 'PlayerKilled', 'DamageReceived', 'ZombieKill', 'BanditKill')
           OR (category = 'Animal' AND event LIKE '%Kill')
         )
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(instanceId, steamId, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => this.rowToEvent(r));
  }

  getVehicleHistory(instanceId: string, steamId: string, limit = 100): PlayerEvent[] {
    const db = this.dbService.getDb();
    const rows = db
      .prepare(
        `SELECT timestamp, steam_id, event, category, session_id, player_name,
                position_x, position_y, position_z, orientation, metadata_json
         FROM events
         WHERE instance_id = ? AND steam_id = ? AND category = 'Vehicle'
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(instanceId, steamId, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => this.rowToEvent(r));
  }

  getInventoryEvents(instanceId: string, steamId: string, limit = 100, offset = 0): PaginatedResult<PlayerEvent> {
    return this.getTimeline(instanceId, {
      steamid: steamId,
      category: 'Inventory',
      limit,
      offset,
    });
  }

  getPositionHistory(instanceId: string, steamId: string, from?: string, to?: string, limit = 1000): PlayerEvent[] {
    const db = this.dbService.getDb();
    const conditions = ['instance_id = ?', "steam_id = ?", "category = 'Position'"];
    const params: unknown[] = [instanceId, steamId];

    if (from) {
      conditions.push('timestamp >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('timestamp <= ?');
      params.push(to);
    }

    const rows = db
      .prepare(
        `SELECT timestamp, steam_id, event, category, session_id, player_name,
                position_x, position_y, position_z, orientation, metadata_json
         FROM events WHERE ${conditions.join(' AND ')}
         ORDER BY timestamp ASC LIMIT ?`
      )
      .all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => this.rowToEvent(r));
  }

  getMapEvents(
    instanceId: string,
    steamId: string,
    from?: string,
    to?: string,
    limit = 8000,
    slim = true
  ): PlayerEvent[] {
    const db = this.dbService.getDb();
    const conditions = ['instance_id = ?', 'steam_id = ?', 'position_x IS NOT NULL', 'position_z IS NOT NULL'];
    const params: unknown[] = [instanceId, steamId];

    if (from) {
      conditions.push('timestamp >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('timestamp <= ?');
      params.push(to);
    }

    const columns = slim
      ? `timestamp, steam_id, event, category, session_id, player_name,
         position_x, position_y, position_z, orientation, NULL as metadata_json`
      : `timestamp, steam_id, event, category, session_id, player_name,
         position_x, position_y, position_z, orientation, metadata_json`;

    const rows = db
      .prepare(
        `SELECT ${columns}
         FROM events WHERE ${conditions.join(' AND ')}
         ORDER BY timestamp ASC LIMIT ?`
      )
      .all(...params, Math.min(limit, 20000)) as Array<Record<string, unknown>>;

    return rows.map((r) => this.rowToEvent(r));
  }

  getHeatmapPoints(
    instanceId: string,
    mode: 'all' | 'deaths' | 'combat' | 'activity',
    from?: string,
    to?: string,
    limit = 50000
  ): { points: Array<{ x: number; z: number }>; total: number; truncated: boolean } {
    const db = this.dbService.getDb();
    const modeCondition =
      mode === 'all'
        ? null
        : mode === 'deaths'
          ? "(event = 'PlayerDeath' OR event = 'Death')"
          : mode === 'combat'
            ? "category = 'Combat'"
            : "category = 'Position'";

    const conditions = ['instance_id = ?', 'position_x IS NOT NULL', 'position_z IS NOT NULL'];
    if (modeCondition) conditions.push(modeCondition);
    const params: unknown[] = [instanceId];

    if (from) {
      conditions.push('timestamp >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('timestamp <= ?');
      params.push(to);
    }

    const where = conditions.join(' AND ');
    const cappedLimit = Math.min(limit, 25000);

    const rows = db
      .prepare(
        `SELECT position_x as x, position_z as z
         FROM events WHERE ${where}
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(...params, cappedLimit + 1) as Array<{ x: number; z: number }>;

    const truncated = rows.length > cappedLimit;
    const points = truncated ? rows.slice(0, cappedLimit) : rows;

    return {
      points,
      total: truncated ? cappedLimit + 1 : points.length,
      truncated,
    };
  }

  getEventTypes(instanceId: string, steamId?: string, steamIds?: string[]): string[] {
    const db = this.dbService.getDb();
    const ids = steamIds?.length ? [...new Set(steamIds.filter(Boolean))] : undefined;
    if (ids && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT DISTINCT event FROM events WHERE instance_id = ? AND steam_id IN (${placeholders}) ORDER BY event`
        )
        .all(instanceId, ...ids) as Array<{ event: string }>;
      return rows.map((r) => r.event);
    }
    if (steamId) {
      const rows = db
        .prepare('SELECT DISTINCT event FROM events WHERE instance_id = ? AND steam_id = ? ORDER BY event')
        .all(instanceId, steamId) as Array<{ event: string }>;
      return rows.map((r) => r.event);
    }
    const rows = db
      .prepare('SELECT DISTINCT event FROM events WHERE instance_id = ? ORDER BY event')
      .all(instanceId) as Array<{ event: string }>;
    return rows.map((r) => r.event);
  }

  getCategories(instanceId: string, steamId?: string, steamIds?: string[]): string[] {
    const db = this.dbService.getDb();
    const ids = steamIds?.length ? [...new Set(steamIds.filter(Boolean))] : undefined;
    if (ids && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT DISTINCT category FROM events WHERE instance_id = ? AND steam_id IN (${placeholders}) AND category IS NOT NULL ORDER BY category`
        )
        .all(instanceId, ...ids) as Array<{ category: string }>;
      return rows.map((r) => r.category);
    }
    if (steamId) {
      const rows = db
        .prepare(
          'SELECT DISTINCT category FROM events WHERE instance_id = ? AND steam_id = ? AND category IS NOT NULL ORDER BY category'
        )
        .all(instanceId, steamId) as Array<{ category: string }>;
      return rows.map((r) => r.category);
    }
    const rows = db
      .prepare(
        'SELECT DISTINCT category FROM events WHERE instance_id = ? AND category IS NOT NULL ORDER BY category'
      )
      .all(instanceId) as Array<{ category: string }>;
    return rows.map((r) => r.category);
  }

  getPlayerCount(instanceId: string): number {
    const db = this.dbService.getDb();
    return (
      db.prepare('SELECT COUNT(*) as c FROM players WHERE instance_id = ?').get(instanceId) as { c: number }
    ).c;
  }

  getRecentEventCount(instanceId: string, withinMinutes: number): number {
    const db = this.dbService.getDb();
    const since = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
    return (
      db
        .prepare('SELECT COUNT(*) as c FROM events WHERE instance_id = ? AND timestamp >= ?')
        .get(instanceId, since) as { c: number }
    ).c;
  }

  getPlayerDbStats(instanceId: string, steamId: string): {
    totalEvents: number;
    firstSeen?: string;
    lastSeen?: string;
    characterName?: string;
    profile?: PlayerProfile;
  } | null {
    const db = this.dbService.getDb();
    const row = db
      .prepare(
        `SELECT total_events, first_seen, last_seen, character_name, profile_json
         FROM players WHERE instance_id = ? AND steam_id = ?`
      )
      .get(instanceId, steamId) as {
      total_events: number;
      first_seen: string | null;
      last_seen: string | null;
      character_name: string | null;
      profile_json: string | null;
    } | undefined;

    if (!row) return null;

    let profile: PlayerProfile | undefined;
    if (row.profile_json) {
      try {
        profile = JSON.parse(row.profile_json) as PlayerProfile;
      } catch {
        profile = undefined;
      }
    }

    return {
      totalEvents: row.total_events,
      firstSeen: profile?.firstSeen ?? row.first_seen ?? undefined,
      lastSeen: profile?.lastSeen ?? row.last_seen ?? undefined,
      characterName: profile?.characterName ?? row.character_name ?? undefined,
      profile,
    };
  }

  listOnlinePlayersDetailed(instanceId: string): OnlinePlayerDetail[] {
    const db = this.dbService.getDb();
    const rows = db
      .prepare(
        `SELECT steam_id, character_name, first_seen, last_seen, total_events, profile_json, is_online
         FROM players
         WHERE instance_id = ?
           AND (
             is_online = 1
             OR json_extract(profile_json, '$.isOnline') = 1
             OR json_extract(profile_json, '$.isOnline') = 'true'
           )
         ORDER BY last_seen DESC`
      )
      .all(instanceId) as Array<{
      steam_id: string;
      character_name: string | null;
      first_seen: string | null;
      last_seen: string | null;
      total_events: number;
      profile_json: string | null;
      is_online: number;
    }>;

    const onlineProfiles: Array<{
      steamId: string;
      profile: PlayerProfile & { ipAddress?: string; sessionJoinTime?: string };
      row: (typeof rows)[number];
    }> = [];

    for (const row of rows) {
      let profile: PlayerProfile & { ipAddress?: string; sessionJoinTime?: string } = {
        steamId: row.steam_id,
        isOnline: true,
      };
      if (row.profile_json) {
        try {
          profile = JSON.parse(row.profile_json) as PlayerProfile & {
            ipAddress?: string;
            sessionJoinTime?: string;
          };
          if (profile.isOnline !== true && row.is_online !== 1) continue;
        } catch {
          if (row.is_online !== 1) continue;
        }
      } else if (row.is_online !== 1) {
        continue;
      }
      onlineProfiles.push({ steamId: row.steam_id, profile, row });
    }

    const lastActions = this.getLatestNonPositionEventsBatch(
      instanceId,
      onlineProfiles.map((p) => p.steamId)
    );

    return onlineProfiles.map(({ steamId, profile, row }) => {
      const lastAction = lastActions.get(steamId) ?? null;
      const itemFields = lastAction ? enrichEventItemFields(lastAction) : { itemPid: null, itemName: null };
      return {
        steamId,
        characterName: profile.characterName ?? row.character_name ?? undefined,
        ipAddress: profile.ipAddress,
        sessionJoinTime: profile.sessionJoinTime,
        totalEvents: row.total_events,
        totalSessions: profile.totalSessions,
        firstSeen: profile.firstSeen ?? row.first_seen ?? undefined,
        lastSeen: profile.lastSeen ?? row.last_seen ?? undefined,
        position: lastAction?.position,
        lastAction: lastAction ? formatEventLabel(lastAction) : undefined,
        lastActionTime: lastAction?.timestamp,
        lastActionCategory: lastAction?.category,
        lastActionItemPid: itemFields.itemPid ?? undefined,
        lastActionItemName: itemFields.itemName ?? undefined,
        isOnline: true,
      };
    });
  }

  getLatestNonPositionEvent(instanceId: string, steamId: string): PlayerEvent | null {
    return this.getLatestNonPositionEventsBatch(instanceId, [steamId]).get(steamId) ?? null;
  }

  /** One query for latest non-position event per steam id (dashboard hot path). */
  getLatestNonPositionEventsBatch(
    instanceId: string,
    steamIds: string[]
  ): Map<string, PlayerEvent> {
    const result = new Map<string, PlayerEvent>();
    const ids = [...new Set(steamIds.filter(Boolean))];
    if (ids.length === 0) return result;

    const db = this.dbService.getDb();
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT e.timestamp, e.steam_id, e.event, e.category, e.session_id, e.player_name,
                e.position_x, e.position_y, e.position_z, e.orientation, e.metadata_json
         FROM events e
         INNER JOIN (
           SELECT steam_id, MAX(timestamp) AS max_ts
           FROM events
           WHERE instance_id = ?
             AND steam_id IN (${placeholders})
             AND category IS NOT NULL
             AND category != 'Position'
           GROUP BY steam_id
         ) latest
           ON e.steam_id = latest.steam_id
          AND e.timestamp = latest.max_ts
         WHERE e.instance_id = ?
           AND e.category IS NOT NULL
           AND e.category != 'Position'`
      )
      .all(instanceId, ...ids, instanceId) as Array<Record<string, unknown>>;

    for (const row of rows) {
      const event = this.rowToEvent(row);
      const existing = result.get(event.steamid);
      if (!existing) result.set(event.steamid, event);
    }

    return result;
  }

  listChatMessages(
    instanceId: string,
    query: { tab?: string; since?: string; limit?: number }
  ): { data: ChatMessage[]; total: number } {
    const db = this.dbService.getDb();
    const conditions = ["instance_id = ?", "category = 'Chat'", "event = 'ChatMessage'"];
    const params: unknown[] = [instanceId];

    if (query.tab) {
      conditions.push("json_extract(metadata_json, '$.chatTab') = ?");
      params.push(query.tab);
    }
    if (query.since) {
      conditions.push('timestamp > ?');
      params.push(query.since);
    }

    const where = conditions.join(' AND ');
    const limit = Math.min(query.limit ?? 100, 500);

    const total = (
      db.prepare(`SELECT COUNT(*) as c FROM events WHERE ${where}`).get(...params) as { c: number }
    ).c;

    const rows = db
      .prepare(
        `SELECT timestamp, steam_id, player_name, metadata_json
         FROM events
         WHERE ${where}
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(...params, limit) as Array<Record<string, unknown>>;

    const data = rows.map((row) => this.rowToChatMessage(row)).reverse();
    return { data, total };
  }

  private rowToChatMessage(row: Record<string, unknown>): ChatMessage {
    let metadata: Record<string, string> = {};
    if (row.metadata_json) {
      try {
        metadata = JSON.parse(row.metadata_json as string) as Record<string, string>;
      } catch {
        metadata = {};
      }
    }

    const tab = (metadata.chatTab ?? 'global') as ChatTab;

    return {
      timestamp: row.timestamp as string,
      steamId: row.steam_id as string,
      playerName: (row.player_name as string) ?? undefined,
      message: metadata.message ?? '',
      chatTab: tab,
      chatChannel: metadata.chatChannel,
      chatSource: metadata.chatSource,
      groupTag: metadata.groupTag,
    };
  }

  getEventsSince(instanceId: string, steamId: string, sinceIso: string, limit = 20): PlayerEvent[] {
    const db = this.dbService.getDb();
    const rows = db
      .prepare(
        `SELECT timestamp, steam_id, event, category, session_id, player_name,
                position_x, position_y, position_z, orientation, metadata_json
         FROM events
         WHERE instance_id = ? AND steam_id = ? AND timestamp > ?
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(instanceId, steamId, sinceIso, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEvent(row));
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
}
