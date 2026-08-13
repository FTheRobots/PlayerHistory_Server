import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ensureConfigFromExample, getAppRoot, resolveAppPath } from './appRoot.js';

export interface ServerConfig {
  playerHistoryPath?: string;
  dbPath?: string;
  host?: string;
  port?: number;
  corsAllowAll?: boolean;
  corsOrigins?: string[];
  publicBaseUrl?: string;
  /** Display name shown to admin clients (login screen, health check). */
  serverName?: string;
  trustProxy?: boolean;
  jwtSecret?: string;
  accessTokenMinutes?: number;
  refreshTokenDays?: number;
  /** Delete indexed events and daily log files older than this many days. 0 = disabled. */
  eventRetentionDays?: number;
}

function readConfigFile(configPath: string): ServerConfig {
  if (!fs.existsSync(configPath)) return {};

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw) as ServerConfig;
  } catch (err) {
    console.warn('[PlayerHistory Server] Failed to read config.json:', err);
    return {};
  }
}

/** True when config has a real DayZ profiles/PlayerHistory path (not empty or template text). */
export function isPlayerHistoryPathConfigured(value: string | undefined): boolean {
  if (!value?.trim()) return false;

  const normalized = value.trim().replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('path/to') || normalized.includes('path\\to')) return false;
  if (normalized.includes('your_public_ip') || normalized.includes('change_me')) return false;

  return true;
}

export function normalizePlayerHistoryPath(input: string, appRoot: string): string {
  let trimmed = input.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return '';

  if (!path.isAbsolute(trimmed)) {
    trimmed = path.resolve(appRoot, trimmed);
  }

  return path.normalize(trimmed);
}

export function writeConfigField(configPath: string, field: keyof ServerConfig, value: unknown): void {
  const existing = readConfigFile(configPath);
  const updated: ServerConfig = { ...existing, [field]: value };
  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
}

function parseCorsOrigins(raw: string | undefined, fileOrigins: string[] | undefined): string[] {
  if (raw) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (fileOrigins?.length) return fileOrigins;
  return ['http://localhost:5173', 'http://127.0.0.1:5173'];
}

export function resolveRuntimeConfig() {
  const appRoot = getAppRoot();
  const configPath = path.join(appRoot, 'config.json');
  ensureConfigFromExample(appRoot, configPath);

  const file = readConfigFile(configPath);

  let playerHistoryPath = '';
  if (process.env.PLAYER_HISTORY_PATH) {
    playerHistoryPath = resolveAppPath(process.env.PLAYER_HISTORY_PATH, appRoot);
  } else if (isPlayerHistoryPathConfigured(file.playerHistoryPath)) {
    playerHistoryPath = resolveAppPath(file.playerHistoryPath!, appRoot);
  }

  const dbPath = resolveAppPath(
    process.env.DB_PATH || file.dbPath || path.join(appRoot, 'data', 'player-history.db'),
    appRoot
  );

  const host = process.env.HOST || file.host || '0.0.0.0';
  const port = parseInt(process.env.PORT || String(file.port ?? 3847), 10);

  const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGINS, file.corsOrigins);

  const corsAllowAll =
    process.env.CORS_ALLOW_ALL !== undefined
      ? process.env.CORS_ALLOW_ALL === '1' || process.env.CORS_ALLOW_ALL.toLowerCase() === 'true'
      : file.corsAllowAll !== false;

  const trustProxy =
    process.env.TRUST_PROXY !== undefined
      ? process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY.toLowerCase() === 'true'
      : file.trustProxy !== false;

  const publicBaseUrl =
    process.env.PUBLIC_BASE_URL ||
    file.publicBaseUrl ||
    `http://localhost:${port}`;

  const serverName =
    process.env.SERVER_NAME?.trim() ||
    file.serverName?.trim() ||
    'Player History API';

  let jwtSecret =
    process.env.JWT_SECRET ||
    file.jwtSecret ||
    '';

  if (!jwtSecret) {
    jwtSecret = crypto.randomBytes(48).toString('hex');
    console.warn('[PlayerHistory Server] No jwtSecret configured — using ephemeral secret (tokens invalid after restart)');
  }

  const accessTokenMinutes = file.accessTokenMinutes ?? 15;
  const refreshTokenDays = file.refreshTokenDays ?? 7;

  const eventRetentionDays = parseInt(
    process.env.EVENT_RETENTION_DAYS || String(file.eventRetentionDays ?? 0),
    10
  );

  return {
    projectRoot: appRoot,
    configPath,
    playerHistoryPath,
    dbPath,
    host,
    port,
    corsOrigins,
    corsAllowAll,
    trustProxy,
    publicBaseUrl,
    serverName,
    jwtSecret,
    accessTokenMinutes,
    refreshTokenDays,
    eventRetentionDays: Number.isFinite(eventRetentionDays) && eventRetentionDays > 0 ? eventRetentionDays : 0,
  };
}

export type RuntimeConfig = ReturnType<typeof resolveRuntimeConfig>;
