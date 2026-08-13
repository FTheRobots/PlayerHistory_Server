export type QueryOperator =
  | 'eq'
  | 'ne'
  | 'in'
  | 'notIn'
  | 'contains'
  | 'startsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'isNull'
  | 'isNotNull';

export type QueryMode = 'events' | 'count' | 'groupBy' | 'topN' | 'timeseries';

export type TimeseriesInterval = 'hour' | 'day';

export interface QueryFilter {
  field: string;
  op: QueryOperator;
  value?: string | number | boolean | string[] | number[];
  valueTo?: string | number;
}

export interface EventQueryRequest {
  filters?: QueryFilter[];
  mode?: QueryMode;
  groupBy?: string | string[];
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  timeseriesInterval?: TimeseriesInterval;
}

export interface QueryFieldDefinition {
  field: string;
  label: string;
  type: 'text' | 'number' | 'timestamp' | 'boolean';
  operators: QueryOperator[];
  description?: string;
  eventHints?: string[];
}

export interface QueryGroupRow {
  key: string;
  keys: Record<string, string | number | null>;
  count: number;
}

export interface QueryTimeseriesRow {
  bucket: string;
  count: number;
}

export interface EventQueryResult {
  mode: QueryMode;
  total: number;
  limit?: number;
  offset?: number;
  events?: import('./index.js').PlayerEvent[];
  count?: number;
  groups?: QueryGroupRow[];
  timeseries?: QueryTimeseriesRow[];
}

export interface SavedQueryRecord {
  id: number;
  userId: number;
  instanceId: string;
  name: string;
  description?: string;
  query: EventQueryRequest;
  isWatch: boolean;
  lastMatchCount?: number;
  lastWatchAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QueryWatchAlert {
  id: number;
  userId: number;
  savedQueryId: number;
  instanceId: string;
  message: string;
  matchCount: number;
  previousCount: number;
  createdAt: string;
  read: boolean;
}
