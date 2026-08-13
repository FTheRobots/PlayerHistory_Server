import type { DatabaseService } from './DatabaseService.js';
import type { PlayerEvent } from '../types/index.js';
import type {
  EventQueryRequest,
  EventQueryResult,
  QueryFilter,
  QueryGroupRow,
  QueryMode,
  QueryOperator,
} from '../types/query.js';
import { QUERY_FIELD_CATALOG } from '../query/queryFields.js';

type FieldSpec = { column: string; type: string };

const FIELD_MAP: Record<string, FieldSpec> = {
  event: { column: 'event', type: 'text' },
  category: { column: 'category', type: 'text' },
  steam_id: { column: 'steam_id', type: 'text' },
  player_name: { column: 'player_name', type: 'text' },
  timestamp: { column: 'timestamp', type: 'timestamp' },
  item_pid: { column: 'item_pid', type: 'text' },
  item_name: { column: 'item_name', type: 'text' },
  item_classname: { column: 'item_classname', type: 'text' },
  from: { column: 'from_loc', type: 'text' },
  from_loc: { column: 'from_loc', type: 'text' },
  to: { column: 'to_loc', type: 'text' },
  to_loc: { column: 'to_loc', type: 'text' },
  from_entity: { column: 'from_entity', type: 'text' },
  to_entity: { column: 'to_entity', type: 'text' },
  source_class: { column: 'source_class', type: 'text' },
  target_type: { column: 'target_type', type: 'text' },
  killer_class: { column: 'killer_class', type: 'text' },
  ammo: { column: 'ammo', type: 'text' },
  damage: { column: 'damage_amount', type: 'number' },
  position_x: { column: 'position_x', type: 'number' },
  position_z: { column: 'position_z', type: 'number' },
};

const GROUPABLE_FIELDS = new Set(Object.keys(FIELD_MAP));

export class QueryService {
  constructor(private readonly dbService: DatabaseService) {}

  execute(instanceId: string, request: EventQueryRequest): EventQueryResult {
    const mode: QueryMode = request.mode ?? 'events';
    const { where, params } = this.buildWhere(instanceId, request.filters ?? []);

    if (mode === 'count') {
      const count = this.scalarCount(where, params);
      return { mode, total: count, count };
    }

    if (mode === 'groupBy' || mode === 'topN') {
      const groups = this.runGroupBy(where, params, request);
      return { mode, total: groups.length, groups };
    }

    if (mode === 'timeseries') {
      const timeseries = this.runTimeseries(where, params, request.timeseriesInterval ?? 'hour');
      const total = timeseries.reduce((s, r) => s + r.count, 0);
      return { mode, total, timeseries };
    }

    const limit = Math.min(request.limit ?? 100, 500);
    const offset = request.offset ?? 0;
    const order = request.order === 'asc' ? 'ASC' : 'DESC';
    const total = this.scalarCount(where, params);
    const db = this.dbService.getDb();
    const rows = db
      .prepare(
        `SELECT timestamp, steam_id, event, category, session_id, player_name,
                position_x, position_y, position_z, orientation, metadata_json
         FROM events WHERE ${where}
         ORDER BY timestamp ${order}
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      mode: 'events',
      total,
      limit,
      offset,
      events: rows.map((r) => this.rowToEvent(r)),
    };
  }

  exportCsv(instanceId: string, request: EventQueryRequest): string {
    const result = this.execute(instanceId, { ...request, mode: 'events', limit: 500, offset: 0 });
    const events = result.events ?? [];
    const header = ['timestamp', 'steam_id', 'player_name', 'event', 'category', 'position_x', 'position_z'];
    const lines = [header.join(',')];
    for (const e of events) {
      lines.push(
        [
          e.timestamp,
          e.steamid,
          csvEscape(e.playerName ?? ''),
          e.event,
          e.category ?? '',
          e.position?.[0]?.toFixed(1) ?? '',
          e.position?.[2]?.toFixed(1) ?? '',
        ].join(',')
      );
    }
    return lines.join('\n');
  }

  validateRequest(request: EventQueryRequest): string | null {
    for (const f of request.filters ?? []) {
      if (f.field === 'has_position') continue;
      if (!FIELD_MAP[f.field]) return `Unknown field: ${f.field}`;
      const allowed = QUERY_FIELD_CATALOG.find((c) => c.field === f.field)?.operators;
      if (allowed && !allowed.includes(f.op as QueryOperator)) {
        return `Operator ${f.op} not allowed for field ${f.field}`;
      }
    }
    return null;
  }

  private buildWhere(instanceId: string, filters: QueryFilter[]): { where: string; params: unknown[] } {
    const conditions = ['instance_id = ?'];
    const params: unknown[] = [instanceId];
    for (const filter of filters) {
      const clause = this.filterClause(filter, params);
      if (clause) conditions.push(clause);
    }
    return { where: conditions.join(' AND '), params };
  }

  private filterClause(filter: QueryFilter, params: unknown[]): string | null {
    if (filter.field === 'has_position') {
      const want = filter.value === true || filter.value === 'true';
      return want ? 'position_x IS NOT NULL AND position_z IS NOT NULL' : '(position_x IS NULL OR position_z IS NULL)';
    }
    const spec = FIELD_MAP[filter.field];
    if (!spec) return null;
    const col = spec.column;
    switch (filter.op) {
      case 'eq':
        params.push(filter.value);
        return `${col} = ?`;
      case 'ne':
        params.push(filter.value);
        return `${col} != ?`;
      case 'contains':
        params.push(`%${String(filter.value ?? '')}%`);
        return `${col} LIKE ?`;
      case 'startsWith':
        params.push(`${String(filter.value ?? '')}%`);
        return `${col} LIKE ?`;
      case 'gt':
        params.push(filter.value);
        return `${col} > ?`;
      case 'gte':
        params.push(filter.value);
        return `${col} >= ?`;
      case 'lt':
        params.push(filter.value);
        return `${col} < ?`;
      case 'lte':
        params.push(filter.value);
        return `${col} <= ?`;
      case 'between':
        params.push(filter.value, filter.valueTo);
        return `${col} BETWEEN ? AND ?`;
      case 'isNull':
        return `${col} IS NULL`;
      case 'isNotNull':
        return `${col} IS NOT NULL`;
      case 'in': {
        const values = Array.isArray(filter.value) ? filter.value : [filter.value];
        if (values.length === 0) return '1=0';
        params.push(...values);
        return `${col} IN (${values.map(() => '?').join(', ')})`;
      }
      case 'notIn': {
        const values = Array.isArray(filter.value) ? filter.value : [filter.value];
        if (values.length === 0) return null;
        params.push(...values);
        return `${col} NOT IN (${values.map(() => '?').join(', ')})`;
      }
      default:
        return null;
    }
  }

  private scalarCount(where: string, params: unknown[]): number {
    const db = this.dbService.getDb();
    return (db.prepare(`SELECT COUNT(*) as c FROM events WHERE ${where}`).get(...params) as { c: number }).c;
  }

  private runGroupBy(where: string, params: unknown[], request: EventQueryRequest): QueryGroupRow[] {
    const raw = request.groupBy ?? 'event';
    const fields = (Array.isArray(raw) ? raw : [raw]).filter((f) => GROUPABLE_FIELDS.has(f));
    if (fields.length === 0) fields.push('event');
    const selectParts = fields.map((f) => `${FIELD_MAP[f].column} AS g_${f}`);
    const groupCols = fields.map((f) => FIELD_MAP[f].column);
    const limit = Math.min(request.limit ?? 50, 200);
    const order = request.order === 'asc' ? 'ASC' : 'DESC';
    const db = this.dbService.getDb();
    const rows = db
      .prepare(
        `SELECT ${selectParts.join(', ')}, COUNT(*) as cnt FROM events WHERE ${where}
         GROUP BY ${groupCols.join(', ')} ORDER BY cnt ${order} LIMIT ?`
      )
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const keys: Record<string, string | number | null> = {};
      const keyParts: string[] = [];
      for (const f of fields) {
        const v = row[`g_${f}`];
        const normalized = v == null ? null : typeof v === 'number' ? v : String(v);
        keys[f] = normalized;
        keyParts.push(normalized == null ? '—' : String(normalized));
      }
      return { key: keyParts.join(' · '), keys, count: Number(row.cnt) };
    });
  }

  private runTimeseries(where: string, params: unknown[], interval: 'hour' | 'day') {
    const fmt = interval === 'day' ? '%Y-%m-%d' : '%Y-%m-%dT%H:00:00';
    const db = this.dbService.getDb();
    const rows = db
      .prepare(
        `SELECT strftime('${fmt}', timestamp) as bucket, COUNT(*) as cnt FROM events
         WHERE ${where} AND timestamp IS NOT NULL GROUP BY bucket ORDER BY bucket ASC LIMIT 500`
      )
      .all(...params) as Array<{ bucket: string; cnt: number }>;
    return rows.map((r) => ({ bucket: r.bucket, count: Number(r.cnt) }));
  }

  private rowToEvent(r: Record<string, unknown>): PlayerEvent {
    const event: PlayerEvent = {
      timestamp: String(r.timestamp),
      steamid: String(r.steam_id),
      event: String(r.event),
    };
    if (r.category) event.category = String(r.category);
    if (r.session_id) event.sessionId = String(r.session_id);
    if (r.player_name) event.playerName = String(r.player_name);
    if (r.orientation != null) event.orientation = Number(r.orientation);
    if (r.position_x != null && r.position_z != null) {
      event.position = [Number(r.position_x), Number(r.position_y ?? 0), Number(r.position_z)];
    }
    if (r.metadata_json) {
      try {
        event.metadata = JSON.parse(String(r.metadata_json));
      } catch {
        /* ignore */
      }
    }
    return event;
  }
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"')) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
