import type { CFToolsStore } from './CFToolsStore.js';

const API_BASE = 'https://data.cftools.cloud';
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const GSM_CACHE_TTL_MS = 30 * 1000;

export interface CFToolsNetworkInfo {
  ipAddress?: string;
  country?: string;
}

export interface CFToolsSessionInfo extends CFToolsNetworkInfo {
  banCount?: number;
}

export interface CFToolsGrantedBanlist {
  id: string;
  name?: string;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readIdField(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return pickString(obj, ['id', 'steam64', 'steam_id', 'steamId']);
  }
  return undefined;
}

function extractNetworkFields(source: unknown): CFToolsNetworkInfo {
  if (!source || typeof source !== 'object') return {};

  const obj = source as Record<string, unknown>;
  const connection =
    typeof obj.connection === 'object' && obj.connection ? (obj.connection as Record<string, unknown>) : null;
  const geolocation =
    typeof obj.geolocation === 'object' && obj.geolocation ? (obj.geolocation as Record<string, unknown>) : null;
  const connectionGeo =
    connection && typeof connection.geolocation === 'object' && connection.geolocation
      ? (connection.geolocation as Record<string, unknown>)
      : null;

  const ipAddress =
    pickString(obj, ['ipv4', 'ip', 'ipAddress', 'ip_address', 'player_ipv4']) ??
    (connection ? pickString(connection, ['ipv4', 'ip', 'ipAddress']) : undefined);

  let country =
    pickString(obj, ['country', 'countryName', 'country_name', 'player_country']) ??
    (connection ? pickString(connection, ['country', 'countryName']) : undefined);

  if (connection && !country) {
    const countryNames = connection.country_names;
    if (countryNames && typeof countryNames === 'object') {
      const names = countryNames as Record<string, unknown>;
      const localized =
        pickString(names, ['en']) ??
        Object.values(names).find((value) => typeof value === 'string' && value.trim());
      if (typeof localized === 'string') country = localized;
    }
  }

  const countryObj =
    (typeof obj.country === 'object' && obj.country ? (obj.country as Record<string, unknown>) : null) ??
    (geolocation && typeof geolocation.country === 'object' && geolocation.country
      ? (geolocation.country as Record<string, unknown>)
      : null) ??
    (connectionGeo && typeof connectionGeo.country === 'object' && connectionGeo.country
      ? (connectionGeo.country as Record<string, unknown>)
      : null);

  if (countryObj) {
    country = pickString(countryObj, ['name', 'country']) ?? country;
  }

  if (!country) {
    country =
      pickString(obj, ['country_code', 'countryCode', 'player_country_code']) ??
      (connection ? pickString(connection, ['country_code', 'countryCode']) : undefined) ??
      (geolocation ? pickString(geolocation, ['country', 'countryCode']) : undefined);
  }

  return { ipAddress, country };
}

function normalizeGameSession(entry: Record<string, unknown>): Record<string, unknown> {
  const nested =
    typeof entry.session === 'object' && entry.session ? (entry.session as Record<string, unknown>) : null;
  if (!nested) return entry;

  return {
    ...nested,
    ...entry,
    connection: entry.connection ?? nested.connection,
    gamedata: entry.gamedata ?? nested.gamedata,
  };
}

function extractSteamId(session: Record<string, unknown>): string | undefined {
  const direct = pickString(session, ['steamId', 'steam_id', 'steam64', 'steamId64']);
  if (direct) return direct;

  const gamedata =
    typeof session.gamedata === 'object' && session.gamedata
      ? (session.gamedata as Record<string, unknown>)
      : null;
  if (gamedata) {
    const fromGameData = pickString(gamedata, ['steam64', 'steam_id', 'steamId']);
    if (fromGameData) return fromGameData;
  }

  return (
    readIdField(session.steamId) ??
    readIdField(session.steam_id) ??
    readIdField(session.steam64)
  );
}

function parseGameSessionsPayload(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) {
    return data.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>;
  }
  if (!data || typeof data !== 'object') return [];

  const obj = data as Record<string, unknown>;
  for (const key of ['sessions', 'entries', 'data', 'players', 'list']) {
    const value = obj[key];
    if (Array.isArray(value)) {
      return value.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function parseBanlistGrant(entry: unknown): CFToolsGrantedBanlist | null {
  if (!entry || typeof entry !== 'object') return null;
  const grant = entry as Record<string, unknown>;
  const resource =
    typeof grant.resource === 'object' && grant.resource ? (grant.resource as Record<string, unknown>) : grant;
  const id = pickString(resource, ['id', 'object_id']);
  if (!id) return null;
  const name = pickString(resource, ['identifier', 'nickname', 'name']);
  return { id, name: name && name !== id ? name : undefined };
}

function parseGrantedBanlists(data: unknown): CFToolsGrantedBanlist[] {
  if (!data || typeof data !== 'object') return [];

  const obj = data as Record<string, unknown>;
  const tokens =
    typeof obj.tokens === 'object' && obj.tokens ? (obj.tokens as Record<string, unknown>) : null;
  const banlistGrants = tokens?.banlist;
  if (Array.isArray(banlistGrants)) {
    const parsed = banlistGrants.map(parseBanlistGrant).filter((entry): entry is CFToolsGrantedBanlist => entry != null);
    if (parsed.length > 0) return parsed;
  }

  const grants = obj.grants;
  if (Array.isArray(grants)) {
    return grants
      .filter((entry) => entry && typeof entry === 'object')
      .map(parseBanlistGrant)
      .filter((entry): entry is CFToolsGrantedBanlist => entry != null);
  }

  return [];
}

function isActiveBanStatus(status?: string): boolean {
  return !status || status === 'Ban.ACTIVE' || status === 'ACTIVE';
}

function parseExpiration(value: unknown): string | null | undefined {
  if (value === 'Permanent') return 'Permanent';
  if (value === null) return null;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

export interface CFToolsBanEntry {
  id: string;
  reason: string;
  created?: string;
  expiration?: string | null;
  status?: string;
  banlistId?: string;
  banlistName?: string;
}

export interface CFToolsActiveBan {
  banId: string;
  reason: string;
  expiresAt?: string | null;
  status: string;
  banlistId?: string;
  banlistName?: string;
  banlistCount?: number;
}

export interface CFToolsOnlineEnrichment {
  cftoolsId?: string;
  ipAddress?: string;
  country?: string;
  activeBan?: CFToolsActiveBan;
}

export interface CFToolsUserLookup {
  cftoolsId?: string;
  steamId?: string;
  battleyeGuid?: string;
  bohemiaUid?: string;
  ipAddress?: string;
  country?: string;
  raw?: unknown;
}

export interface CFToolsPlayerProfile {
  configured: boolean;
  steamId: string;
  lookup: CFToolsUserLookup | null;
  stats: Record<string, unknown> | null;
  bans: CFToolsBanEntry[];
  activeBan: CFToolsActiveBan | null;
  whitelist: Record<string, unknown> | null;
  queuePriority: Record<string, unknown> | null;
  error?: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class CFToolsService {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private readonly lookupCache = new Map<string, CacheEntry<CFToolsUserLookup | null>>();
  private readonly banCache = new Map<string, CacheEntry<CFToolsBanEntry[]>>();
  private gsmSessionsCache: CacheEntry<Map<string, CFToolsSessionInfo>> | null = null;
  private grantedBanlistsCache: CacheEntry<CFToolsGrantedBanlist[]> | null = null;

  constructor(private readonly store: CFToolsStore) {}

  isOperational(): boolean {
    return this.store.isOperational();
  }

  getStatus(): { enabled: boolean; configured: boolean } {
    const pub = this.store.getPublicConfig();
    return {
      enabled: pub.enabled,
      configured: this.store.isOperational(),
    };
  }

  invalidateCaches(): void {
    this.token = null;
    this.tokenExpiresAt = 0;
    this.lookupCache.clear();
    this.banCache.clear();
    this.gsmSessionsCache = null;
    this.grantedBanlistsCache = null;
  }

  private getCredentials(): {
    applicationId: string;
    secret: string;
    serverApiId: string;
    banlistId?: string;
  } | null {
    const cfg = this.store.getFullConfig();
    if (!cfg?.enabled || !cfg.applicationId || !cfg.applicationSecret || !cfg.serverApiId) {
      return null;
    }
    return {
      applicationId: cfg.applicationId,
      secret: cfg.applicationSecret,
      serverApiId: cfg.serverApiId,
      banlistId: cfg.banlistId || undefined,
    };
  }

  private async getToken(force = false): Promise<string> {
    const creds = this.getCredentials();
    if (!creds) throw new Error('CFTools integration is not configured');

    if (!force && this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }

    const res = await fetch(`${API_BASE}/v1/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': creds.applicationId,
      },
      body: JSON.stringify({
        application_id: creds.applicationId,
        secret: creds.secret,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`CFTools authentication failed (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as { token?: string };
    if (!data.token) throw new Error('CFTools authentication response missing token');

    this.token = data.token;
    this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    return data.token;
  }

  private async apiRequest<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string>; retry?: boolean } = {}
  ): Promise<T | null> {
    const creds = this.getCredentials();
    if (!creds) return null;

    const token = await this.getToken(options.retry === true);
    const url = new URL(`${API_BASE}${path}`);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': creds.applicationId,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 403 && !options.retry) {
      this.token = null;
      this.tokenExpiresAt = 0;
      return this.apiRequest<T>(method, path, { ...options, retry: true });
    }

    if (res.status === 404) return null;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`CFTools API error (${res.status}): ${body || res.statusText}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return (await res.json()) as T;
    }

    const text = await res.text();
    if (!text.trim()) return null;

    try {
      return JSON.parse(text) as T;
    } catch {
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const parsed: unknown[] = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line));
        } catch {
          /* skip malformed stream lines */
        }
      }
      if (parsed.length === 0) return null;
      return { entries: parsed } as T;
    }
  }

  async testConnection(): Promise<{
    ok: boolean;
    serverName?: string;
    grantCount?: number;
    onlineSessionCount?: number;
    error?: string;
  }> {
    try {
      const creds = this.getCredentials();
      if (!creds) {
        return { ok: false, error: 'Save application ID, secret, and server API ID first' };
      }

      await this.getToken(true);

      const grantedBanlists = await this.listGrantedBanlists();
      const grantCount = grantedBanlists.length;

      const info = await this.apiRequest<{ name?: string; hostname?: string }>(
        'GET',
        `/v1/server/${encodeURIComponent(creds.serverApiId)}/info`
      );

      const sessions = await this.listOnlineSessionsBySteamId();

      return {
        ok: true,
        serverName: info?.name ?? info?.hostname,
        grantCount,
        onlineSessionCount: sessions.size,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
    map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  async lookupUser(steamId: string): Promise<CFToolsUserLookup | null> {
    const cached = this.cacheGet(this.lookupCache, steamId);
    if (cached !== undefined) return cached;

    const data = await this.apiRequest<Record<string, unknown>>('GET', '/v1/users/lookup', {
      query: { identifier: steamId },
    });

    if (!data) {
      this.cacheSet(this.lookupCache, steamId, null);
      return null;
    }

    const lookup: CFToolsUserLookup = {
      cftoolsId: typeof data.cftools_id === 'string' ? data.cftools_id : undefined,
      steamId: typeof data.steam_id === 'string' ? data.steam_id : steamId,
      battleyeGuid: typeof data.battleye_guid === 'string' ? data.battleye_guid : undefined,
      bohemiaUid: typeof data.bohemia_uid === 'string' ? data.bohemia_uid : undefined,
      ...extractNetworkFields(data),
      raw: data,
    };

    this.cacheSet(this.lookupCache, steamId, lookup);
    return lookup;
  }

  private parseBanEntries(data: unknown, banlist?: CFToolsGrantedBanlist): CFToolsBanEntry[] {
    if (!data || typeof data !== 'object') return [];
    const obj = data as { entries?: unknown[]; bans?: unknown[] };
    const list = Array.isArray(obj.entries) ? obj.entries : Array.isArray(obj.bans) ? obj.bans : [];
    const bans: CFToolsBanEntry[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const id = typeof e.id === 'string' ? e.id : '';
      const reason = typeof e.reason === 'string' ? e.reason : 'No reason';
      if (!id) continue;
      bans.push({
        id,
        reason,
        created:
          typeof e.created === 'string'
            ? e.created
            : typeof e.created_at === 'string'
              ? e.created_at
              : undefined,
        expiration: parseExpiration(e.expiration ?? e.expires_at),
        status: typeof e.status === 'string' ? e.status : undefined,
        banlistId: banlist?.id,
        banlistName: banlist?.name,
      });
    }
    return bans;
  }

  async listGrantedBanlists(): Promise<CFToolsGrantedBanlist[]> {
    if (this.grantedBanlistsCache && Date.now() < this.grantedBanlistsCache.expiresAt) {
      return this.grantedBanlistsCache.value;
    }

    const creds = this.getCredentials();
    if (!creds) return [];

    try {
      const data = await this.apiRequest<unknown>('GET', '/v1/@app/grants');
      const banlists = parseGrantedBanlists(data);
      if (banlists.length === 0 && creds.banlistId) {
        banlists.push({ id: creds.banlistId });
      }
      this.grantedBanlistsCache = {
        value: banlists,
        expiresAt: Date.now() + CACHE_TTL_MS,
      };
      return banlists;
    } catch (err) {
      console.warn('[CFTools] Failed to list granted banlists:', err);
      if (creds.banlistId) return [{ id: creds.banlistId }];
      return [];
    }
  }

  async listBansForSteamId(steamId: string): Promise<CFToolsBanEntry[]> {
    const cached = this.cacheGet(this.banCache, steamId);
    if (cached !== undefined) return cached;

    const creds = this.getCredentials();
    if (!creds) return [];

    const lookup = await this.lookupUser(steamId);
    if (!lookup?.cftoolsId) {
      this.cacheSet(this.banCache, steamId, []);
      return [];
    }

    const banlists = await this.listGrantedBanlists();
    if (banlists.length === 0) {
      this.cacheSet(this.banCache, steamId, []);
      return [];
    }

    const results = await Promise.all(
      banlists.map(async (banlist) => {
        try {
          const data = await this.apiRequest<unknown>(
            'GET',
            `/v1/banlist/${encodeURIComponent(banlist.id)}/bans`,
            { query: { filter: lookup.cftoolsId! } }
          );
          return this.parseBanEntries(data, banlist);
        } catch (err) {
          console.warn(`[CFTools] Ban lookup failed for banlist ${banlist.id}:`, err);
          return [];
        }
      })
    );

    const bans = results.flat().sort((a, b) => {
      const aActive = isActiveBanStatus(a.status);
      const bActive = isActiveBanStatus(b.status);
      if (aActive !== bActive) return aActive ? -1 : 1;
      return (b.created ?? '').localeCompare(a.created ?? '');
    });

    this.cacheSet(this.banCache, steamId, bans);
    return bans;
  }

  findActiveBan(bans: CFToolsBanEntry[]): CFToolsActiveBan | null {
    const activeBans = bans.filter((ban) => isActiveBanStatus(ban.status));
    const active = activeBans[0];
    if (!active) return null;

    const distinctBanlists = new Set(
      activeBans.map((ban) => ban.banlistId).filter((id): id is string => Boolean(id))
    );

    let reason = active.reason;
    if (activeBans.length > 1) {
      reason = `${active.reason} (+${activeBans.length - 1} more active ban${activeBans.length === 2 ? '' : 's'})`;
    }

    return {
      banId: active.id,
      reason,
      expiresAt: active.expiration === 'Permanent' ? null : active.expiration ?? null,
      status: active.status ?? 'Ban.ACTIVE',
      banlistId: active.banlistId,
      banlistName: active.banlistName,
      ...(distinctBanlists.size > 1 ? { banlistCount: distinctBanlists.size } : {}),
    };
  }

  async getActiveBanForSteamId(steamId: string): Promise<CFToolsActiveBan | null> {
    const bans = await this.listBansForSteamId(steamId);
    return this.findActiveBan(bans);
  }

  private mergeNetwork(
    primary: CFToolsNetworkInfo,
    fallback: CFToolsNetworkInfo
  ): CFToolsNetworkInfo {
    return {
      ipAddress: primary.ipAddress ?? fallback.ipAddress,
      country: primary.country ?? fallback.country,
    };
  }

  private mergeSession(
    primary: CFToolsSessionInfo,
    fallback: CFToolsSessionInfo
  ): CFToolsSessionInfo {
    return {
      ipAddress: primary.ipAddress ?? fallback.ipAddress,
      country: primary.country ?? fallback.country,
      banCount: primary.banCount ?? fallback.banCount,
    };
  }

  async listOnlineSessionsBySteamId(): Promise<Map<string, CFToolsSessionInfo>> {
    if (this.gsmSessionsCache && Date.now() < this.gsmSessionsCache.expiresAt) {
      return this.gsmSessionsCache.value;
    }

    const creds = this.getCredentials();
    const map = new Map<string, CFToolsSessionInfo>();
    if (!creds) return map;

    try {
      const data = await this.apiRequest<unknown>(
        'GET',
        `/v1/server/${encodeURIComponent(creds.serverApiId)}/GSM/list`
      );
      const sessions = parseGameSessionsPayload(data).map(normalizeGameSession);

      for (const session of sessions) {
        const steamId = extractSteamId(session);
        if (!steamId) continue;

        const info =
          typeof session.info === 'object' && session.info ? (session.info as Record<string, unknown>) : null;
        const banCount = info && typeof info.ban_count === 'number' ? info.ban_count : undefined;

        const sessionInfo: CFToolsSessionInfo = {
          ...extractNetworkFields(session),
          banCount,
        };
        const existing = map.get(steamId);
        map.set(steamId, existing ? this.mergeSession(sessionInfo, existing) : sessionInfo);
      }
    } catch (err) {
      console.warn('[CFTools] GSM/list fetch failed:', err);
    }

    this.gsmSessionsCache = {
      value: map,
      expiresAt: Date.now() + GSM_CACHE_TTL_MS,
    };
    return map;
  }

  async enrichOnlinePlayers(
    steamIds: string[]
  ): Promise<Map<string, CFToolsOnlineEnrichment>> {
    const result = new Map<string, CFToolsOnlineEnrichment>();
    if (!this.isOperational() || steamIds.length === 0) return result;

    const sessionsBySteamId = await this.listOnlineSessionsBySteamId();

    await Promise.all(
      steamIds.map(async (steamId) => {
        try {
          const lookup = await this.lookupUser(steamId);
          const session = sessionsBySteamId.get(steamId) ?? {};
          const lookupNetwork = lookup ? { ipAddress: lookup.ipAddress, country: lookup.country } : {};
          const network = this.mergeNetwork(session, lookupNetwork);

          const entry: CFToolsOnlineEnrichment = {};
          if (lookup?.cftoolsId) entry.cftoolsId = lookup.cftoolsId;
          if (network.ipAddress) entry.ipAddress = network.ipAddress;
          if (network.country) entry.country = network.country;

          let ban = await this.getActiveBanForSteamId(steamId);
          if (!ban && session.banCount && session.banCount > 0) {
            ban = {
              banId: 'cftools-network',
              reason: `Active on ${session.banCount} CFTools banlist${session.banCount === 1 ? '' : 's'}`,
              status: 'Ban.ACTIVE',
              banlistCount: session.banCount,
            };
          }
          if (ban) entry.activeBan = ban;

          if (
            entry.cftoolsId ||
            entry.activeBan ||
            entry.ipAddress ||
            entry.country
          ) {
            result.set(steamId, entry);
          }
        } catch (err) {
          console.warn(`[CFTools] Enrichment failed for ${steamId}:`, err);
        }
      })
    );

    return result;
  }

  async getPlayerProfile(steamId: string): Promise<CFToolsPlayerProfile> {
    if (!this.isOperational()) {
      return {
        configured: false,
        steamId,
        lookup: null,
        stats: null,
        bans: [],
        activeBan: null,
        whitelist: null,
        queuePriority: null,
      };
    }

    try {
      const creds = this.getCredentials()!;
      let lookup = await this.lookupUser(steamId);
      const sessionNetwork = (await this.listOnlineSessionsBySteamId()).get(steamId);
      if (lookup && sessionNetwork) {
        const network = this.mergeNetwork(sessionNetwork, {
          ipAddress: lookup.ipAddress,
          country: lookup.country,
        });
        lookup = { ...lookup, ...network };
      } else if (!lookup && sessionNetwork) {
        lookup = {
          steamId,
          ...sessionNetwork,
        };
      }
      const bans = await this.listBansForSteamId(steamId);
      const activeBan = this.findActiveBan(bans);

      let stats: Record<string, unknown> | null = null;
      let whitelist: Record<string, unknown> | null = null;
      let queuePriority: Record<string, unknown> | null = null;

      if (lookup?.cftoolsId) {
        stats = await this.apiRequest<Record<string, unknown>>(
          'GET',
          `/v2/server/${encodeURIComponent(creds.serverApiId)}/player`,
          { query: { cftools_id: lookup.cftoolsId } }
        );

        whitelist = await this.apiRequest<Record<string, unknown>>(
          'GET',
          `/v1/server/${encodeURIComponent(creds.serverApiId)}/whitelist`,
          { query: { cftools_id: lookup.cftoolsId } }
        );

        queuePriority = await this.apiRequest<Record<string, unknown>>(
          'GET',
          `/v1/server/${encodeURIComponent(creds.serverApiId)}/queuepriority`,
          { query: { cftools_id: lookup.cftoolsId } }
        );
      }

      return {
        configured: true,
        steamId,
        lookup,
        stats,
        bans,
        activeBan,
        whitelist,
        queuePriority,
      };
    } catch (err) {
      return {
        configured: true,
        steamId,
        lookup: null,
        stats: null,
        bans: [],
        activeBan: null,
        whitelist: null,
        queuePriority: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
