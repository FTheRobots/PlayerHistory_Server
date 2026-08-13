export interface PlayerEvent {
  timestamp: string;
  steamid: string;
  playerName?: string;
  sessionId?: string;
  event: string;
  category?: string;
  position?: [number, number, number];
  orientation?: number;
  metadata?: Record<string, string>;
}

export interface PlayerProfile {
  steamId: string;
  characterName?: string;
  characterId?: string;
  firstSeen?: string;
  lastSeen?: string;
  totalSessions?: number;
  totalPlaytimeSeconds?: number;
  totalDeaths?: number;
  totalKills?: number;
  isOnline?: boolean;
  ipAddress?: string;
  sessionJoinTime?: string;
}

export interface SessionData {
  sessionId: string;
  steamId: string;
  characterName?: string;
  joinTime?: string;
  disconnectTime?: string;
  disconnectReason?: string;
  durationSeconds?: number;
  active?: boolean;
}

export interface PlayerSummary {
  steamId: string;
  characterName?: string;
  firstSeen?: string;
  lastSeen?: string;
  totalEvents: number;
  lastEvent?: string;
  isOnline?: boolean;
}

export interface TimelineQuery {
  steamid: string;
  event?: string;
  category?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface MultiTimelineQuery {
  steamids: string[];
  event?: string;
  category?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export const MAX_COMPARE_PLAYERS = 5;

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
}

export type ChatTab = 'global' | 'team' | 'admin' | 'transport';

export interface ChatMessage {
  timestamp: string;
  steamId: string;
  playerName?: string;
  message: string;
  chatTab: ChatTab;
  chatChannel?: string;
  chatSource?: string;
  groupTag?: string;
}

export interface ChatQuery {
  tab?: ChatTab;
  since?: string;
  limit?: number;
}

export interface EventStatistics {
  steamId: string;
  totalEvents: number;
  eventsByCategory: Record<string, number>;
  eventsByType: Record<string, number>;
  firstEvent?: string;
  lastEvent?: string;
  deathCount: number;
  killCount: number;
  sessionCount: number;
  animalKillCounts: Record<string, number>;
  killCounts: Record<string, number>;
}

export interface ItemSummary {
  pid: string;
  name?: string;
  classname?: string;
  eventCount: number;
  firstSeen?: string;
  lastSeen?: string;
  lastPlayerSteamId?: string;
  lastPlayerName?: string;
}

export type ContainerStorageDirection = 'into' | 'out_of';

export interface ContainerStorageEvent {
  direction: ContainerStorageDirection;
  containerPid?: string;
  containerPosition: [number, number, number];
  containerClass?: string;
  event: PlayerEvent;
}

export interface ServerSnapshot {
  timestamp?: string;
  serverFps?: number;
  playerCount?: number;
  zombieCount?: number;
  animalCount?: number;
  aiCount?: number;
  worldName?: string;
  worldSize?: number;
  /** Seconds between server.json writes (from mod config). Used for live/offline threshold. */
  snapshotIntervalSeconds?: number;
  onlinePlayers?: Array<{
    steamId: string;
    characterName?: string;
    ipAddress?: string;
    sessionJoinTime?: string;
    posX?: number;
    posY?: number;
    posZ?: number;
    lastAction?: string;
    lastActionTime?: string;
    lastActionCategory?: string;
    lastActionItemPid?: string;
    lastActionItemName?: string;
  }>;
}

export interface OnlinePlayerDetail {
  steamId: string;
  characterName?: string;
  ipAddress?: string;
  country?: string;
  sessionJoinTime?: string;
  timeOnline?: string;
  position?: [number, number, number];
  lastAction?: string;
  lastActionTime?: string;
  lastActionCategory?: string;
  lastActionItemPid?: string;
  lastActionItemName?: string;
  totalEvents?: number;
  totalSessions?: number;
  firstSeen?: string;
  lastSeen?: string;
  isOnline?: boolean;
  cftoolsId?: string;
  cftoolsBan?: {
    banId: string;
    reason: string;
    expiresAt?: string | null;
    status: string;
  };
}

export interface DashboardCFToolsStatus {
  enabled: boolean;
  configured: boolean;
}

export interface DashboardServerStats {
  timestamp: string;
  serverFps?: number;
  playerCount: number;
  zombieCount?: number;
  animalCount?: number;
  aiCount?: number;
  totalPlayers: number;
  eventsLastHour: number;
  eventsLast24h: number;
  snapshotAvailable: boolean;
  /** When false, snapshot timestamp is older than the mod write interval allows. */
  live?: boolean;
  worldName?: string;
  worldSize?: number;
}

export interface DashboardMapConfig {
  id: string;
  displayName: string;
  mapSize: number;
  tileUrl: string;
  tileUrlSatellite?: string;
  /** dayz.xam.nu path segment (e.g. namalsk, livonia; empty for Chernarus root) */
  xamMapSlug: string;
  maxNativeZoom: number;
  imageUrl?: string;
}

export interface DashboardData {
  server: DashboardServerStats;
  onlinePlayers: OnlinePlayerDetail[];
  map: DashboardMapConfig;
  cftools?: DashboardCFToolsStatus;
}

export type DashboardCommandType =
  | 'heal'
  | 'kill'
  | 'teleport'
  | 'spawn'
  | 'restoredeath'
  | 'deletedeath'
  | 'restoreinventory'
  | 'deleteinventory'
  | 'captureinventory'
  | 'deleteitem'
  | 'kick'
  | 'ban'
  | 'message';

export interface DashboardCommandRequest {
  type: DashboardCommandType;
  steamId: string;
  classname?: string;
  deathEntryId?: string;
  itemPid?: string;
  message?: string;
  banDurationMinutes?: number;
  x?: number;
  y?: number;
  z?: number;
  quantity?: number;
  forceRestore?: boolean;
}

export interface DashboardCommand extends Omit<DashboardCommandRequest, 'forceRestore'> {
  id: string;
  createdAt: string;
  /** 1 = allow re-restore of an already-restored snapshot (DayZ mod reads int). */
  forceRestore?: number;
  /** Set when deleteitem was queued for next login (player offline). */
  queuedForLogin?: boolean;
}

export type HeatmapMode = 'all' | 'deaths' | 'combat' | 'activity';

export interface HeatmapPoint {
  x: number;
  z: number;
}

export interface HeatmapResponse {
  points: HeatmapPoint[];
  total: number;
  truncated: boolean;
  mode: HeatmapMode;
  from?: string;
  to?: string;
}
