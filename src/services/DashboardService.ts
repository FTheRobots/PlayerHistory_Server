import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { PlayerRepository } from './PlayerRepository.js';
import { enrichEventItemFields } from '../utils/itemExtract.js';
import { formatEventLabel, isRawEventType } from '../utils/eventFormat.js';
import type {
  DashboardData,
  DashboardCommand,
  DashboardCommandRequest,
  OnlinePlayerDetail,
  ServerSnapshot,
} from '../types/index.js';
import type { CFToolsService } from './CFToolsService.js';
import { resolveMapConfig } from '../config/mapRegistry.js';
import type { DashboardMapConfig } from '../types/index.js';
import { isPlayerOnline, queuePendingDeletion } from '../utils/pendingDeletions.js';
import {
  isSnapshotLive,
  readModSnapshotIntervalSeconds,
  readServerSnapshotResilient,
  type SnapshotReadState,
} from '../utils/serverSnapshot.js';

const COUNTRY_CACHE = new Map<string, string>();

async function lookupCountry(ip: string): Promise<string | undefined> {
  if (!ip || ip === '127.0.0.1' || ip.startsWith('10.') || ip.startsWith('192.168.')) {
    return undefined;
  }

  const cached = COUNTRY_CACHE.get(ip);
  if (cached) return cached;

  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=country,countryCode`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { country?: string; countryCode?: string };
    const country = data.country ?? data.countryCode;
    if (country) COUNTRY_CACHE.set(ip, country);
    return country;
  } catch {
    return undefined;
  }
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function formatDurationSince(iso?: string): string | undefined {
  if (!iso) return undefined;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return undefined;
  const mins = Math.floor(ms / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ${hrs % 24}h`;
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

export class DashboardService {
  private readonly snapshotState: SnapshotReadState = {
    lastGood: null,
    intervalSeconds: 10,
  };
  private lastMapConfig: DashboardMapConfig | null = null;
  private dashboardCache: { at: number; includeCftools: boolean; data: DashboardData } | null = null;
  private static readonly CACHE_TTL_MS = 1500;
  private recentCountCache = new Map<number, { at: number; value: number }>();
  private static readonly COUNT_CACHE_TTL_MS = 10_000;

  private getCachedRecentCount(withinMinutes: number): number {
    const cached = this.recentCountCache.get(withinMinutes);
    if (cached && Date.now() - cached.at < DashboardService.COUNT_CACHE_TTL_MS) {
      return cached.value;
    }
    const value = this.repo.getRecentEventCount(this.instanceId, withinMinutes);
    this.recentCountCache.set(withinMinutes, { at: Date.now(), value });
    return value;
  }

  constructor(
    private readonly dataRoot: string,
    private readonly repo: PlayerRepository,
    private readonly instanceId: string,
    private readonly cftools?: CFToolsService
  ) {
    const fromModConfig = readModSnapshotIntervalSeconds(dataRoot);
    if (fromModConfig) {
      this.snapshotState.intervalSeconds = fromModConfig;
    }
  }

  getSnapshotFilePath(): string {
    return path.join(this.dataRoot, 'server.json');
  }

  readServerSnapshot(): ServerSnapshot | null {
    return readServerSnapshotResilient(this.getSnapshotFilePath(), this.snapshotState);
  }

  getMapConfig(): DashboardMapConfig {
    const snapshot = this.readServerSnapshot();
    if (snapshot?.worldName) {
      const cfg = resolveMapConfig(snapshot.worldName, snapshot.worldSize);
      this.lastMapConfig = {
        id: cfg.id,
        displayName: cfg.displayName,
        mapSize: cfg.mapSize,
        tileUrl: cfg.tileUrl,
        tileUrlSatellite: cfg.tileUrlSatellite,
        xamMapSlug: cfg.tileSlug,
        maxNativeZoom: cfg.maxNativeZoom,
        imageUrl: cfg.imageUrl,
      };
      return this.lastMapConfig;
    }

    if (this.lastMapConfig) return this.lastMapConfig;

    const cfg = resolveMapConfig(undefined, snapshot?.worldSize);
    return {
      id: cfg.id,
      displayName: cfg.displayName,
      mapSize: cfg.mapSize,
      tileUrl: cfg.tileUrl,
      tileUrlSatellite: cfg.tileUrlSatellite,
      xamMapSlug: cfg.tileSlug,
      maxNativeZoom: cfg.maxNativeZoom,
      imageUrl: cfg.imageUrl,
    };
  }

  private readPlayerSession(steamId: string): { joinTime?: string; ipAddress?: string; active?: boolean } | null {
    const sessionPath = path.join(this.dataRoot, steamId, 'session.json');
    return readJsonFile<{ joinTime?: string; ipAddress?: string; active?: boolean }>(sessionPath);
  }

  private readPlayerProfileFile(steamId: string): {
    characterName?: string;
    firstSeen?: string;
    lastSeen?: string;
    totalSessions?: number;
    ipAddress?: string;
    sessionJoinTime?: string;
  } | null {
    const profilePath = path.join(this.dataRoot, steamId, 'profile.json');
    return readJsonFile(profilePath);
  }

  private async enrichPlayerDetail(player: OnlinePlayerDetail): Promise<OnlinePlayerDetail> {
    const profile = this.readPlayerProfileFile(player.steamId);
    const session = this.readPlayerSession(player.steamId);
    const dbStats = this.repo.getPlayerDbStats(this.instanceId, player.steamId);
    const dbProfile = dbStats?.profile;

    const ipAddress =
      player.ipAddress ||
      profile?.ipAddress ||
      session?.ipAddress ||
      dbProfile?.ipAddress ||
      undefined;

    const sessionJoinTime =
      player.sessionJoinTime ||
      profile?.sessionJoinTime ||
      (session?.active !== false ? session?.joinTime : undefined) ||
      dbProfile?.sessionJoinTime;

    const country =
      player.country ?? (ipAddress ? await lookupCountry(ipAddress) : undefined);

    return {
      ...player,
      characterName:
        player.characterName ?? profile?.characterName ?? dbStats?.characterName ?? dbProfile?.characterName,
      ipAddress,
      country,
      sessionJoinTime,
      timeOnline: formatDurationSince(sessionJoinTime) ?? player.timeOnline,
      totalEvents: player.totalEvents ?? dbStats?.totalEvents,
      totalSessions: player.totalSessions ?? profile?.totalSessions ?? dbProfile?.totalSessions,
      firstSeen: player.firstSeen ?? profile?.firstSeen ?? dbStats?.firstSeen ?? dbProfile?.firstSeen,
      lastSeen: player.lastSeen ?? profile?.lastSeen ?? dbStats?.lastSeen ?? dbProfile?.lastSeen,
    };
  }

  async getDashboard(options: { includeCftools?: boolean } = {}): Promise<DashboardData> {
    const includeCftools = Boolean(options.includeCftools);
    const cached = this.dashboardCache;
    if (
      cached &&
      cached.includeCftools === includeCftools &&
      Date.now() - cached.at < DashboardService.CACHE_TTL_MS
    ) {
      return cached.data;
    }

    const data = await this.buildDashboard({ includeCftools });
    this.dashboardCache = { at: Date.now(), includeCftools, data };
    return data;
  }

  private async buildDashboard(options: { includeCftools: boolean }): Promise<DashboardData> {
    const snapshot = this.readServerSnapshot();
    const live = isSnapshotLive(snapshot, this.snapshotState.intervalSeconds);

    const totalPlayers = this.repo.getPlayerCount(this.instanceId);
    const eventsLastHour = this.getCachedRecentCount(60);
    const eventsLast24h = this.getCachedRecentCount(24 * 60);

    const map = this.getMapConfig();
    const cftoolsStatus = this.cftools?.getStatus();

    const onlineFromDb = this.repo.listOnlinePlayersDetailed(this.instanceId);
    const snapshotPlayers = snapshot?.onlinePlayers ?? [];

    const merged = new Map<string, OnlinePlayerDetail>();
    const needLastActionIds: string[] = [];

    for (const player of onlineFromDb) {
      // Prefer snapshot/DB fields — skip disk session read when already complete.
      if (player.sessionJoinTime && player.ipAddress) {
        merged.set(player.steamId, {
          ...player,
          timeOnline: formatDurationSince(player.sessionJoinTime) ?? player.timeOnline,
        });
        continue;
      }
      const session = this.readPlayerSession(player.steamId);
      merged.set(player.steamId, {
        ...player,
        sessionJoinTime: player.sessionJoinTime ?? session?.joinTime,
        ipAddress: player.ipAddress ?? session?.ipAddress,
        timeOnline: formatDurationSince(player.sessionJoinTime ?? session?.joinTime),
      });
    }

    for (const snapPlayer of snapshotPlayers) {
      const existing = merged.get(snapPlayer.steamId);
      if (!existing?.lastAction || !existing.lastActionItemPid) {
        needLastActionIds.push(snapPlayer.steamId);
      }
    }

    const batchActions = this.repo.getLatestNonPositionEventsBatch(
      this.instanceId,
      needLastActionIds
    );

    for (const snapPlayer of snapshotPlayers) {
      const existing = merged.get(snapPlayer.steamId);
      const ip = snapPlayer.ipAddress || existing?.ipAddress;
      const dbEvent = batchActions.get(snapPlayer.steamId) ?? null;
      const dbItems = dbEvent ? enrichEventItemFields(dbEvent) : { itemPid: null, itemName: null };
      const dbLabel = dbEvent ? formatEventLabel(dbEvent) : undefined;

      let lastAction = snapPlayer.lastAction ?? existing?.lastAction;
      if (lastAction && isRawEventType(lastAction) && dbLabel) {
        lastAction = dbLabel;
      } else if (!lastAction && dbLabel) {
        lastAction = dbLabel;
      }

      merged.set(snapPlayer.steamId, {
        ...(existing ?? { steamId: snapPlayer.steamId, isOnline: true }),
        steamId: snapPlayer.steamId,
        characterName: snapPlayer.characterName ?? existing?.characterName,
        ipAddress: ip,
        country: existing?.country,
        sessionJoinTime: snapPlayer.sessionJoinTime ?? existing?.sessionJoinTime,
        timeOnline: formatDurationSince(snapPlayer.sessionJoinTime ?? existing?.sessionJoinTime),
        position:
          snapPlayer.posX != null && snapPlayer.posZ != null
            ? [snapPlayer.posX, snapPlayer.posY ?? 0, snapPlayer.posZ]
            : existing?.position,
        lastAction,
        lastActionTime: snapPlayer.lastActionTime ?? existing?.lastActionTime,
        lastActionCategory: snapPlayer.lastActionCategory ?? existing?.lastActionCategory,
        lastActionItemPid:
          snapPlayer.lastActionItemPid ?? dbItems.itemPid ?? existing?.lastActionItemPid ?? undefined,
        lastActionItemName:
          snapPlayer.lastActionItemName ?? dbItems.itemName ?? existing?.lastActionItemName ?? undefined,
        totalEvents: existing?.totalEvents,
        totalSessions: existing?.totalSessions,
        firstSeen: existing?.firstSeen,
        lastSeen: existing?.lastSeen,
        isOnline: live,
      });
    }

    const includeCftools = Boolean(options.includeCftools && cftoolsStatus?.configured);

    if (includeCftools && this.cftools) {
      try {
        const enrichMap = await this.cftools.enrichOnlinePlayers(Array.from(merged.keys()));
        for (const [steamId, enrich] of enrichMap) {
          const player = merged.get(steamId);
          if (!player) continue;
          merged.set(steamId, {
            ...player,
            ...(enrich.cftoolsId ? { cftoolsId: enrich.cftoolsId } : {}),
            ...(enrich.activeBan ? { cftoolsBan: enrich.activeBan } : {}),
            ipAddress: enrich.ipAddress ?? player.ipAddress,
            country: enrich.country ?? player.country,
          });
        }
      } catch (err) {
        console.warn('[Dashboard] CFTools enrichment failed:', err);
      }
    }

    // Prefer DB profile_json already loaded; only hit disk when fields are still missing.
    const enrichedPlayers = await Promise.all(
      Array.from(merged.values()).map((player) => {
        if (
          player.characterName &&
          player.sessionJoinTime &&
          player.totalEvents != null &&
          (player.country || !player.ipAddress)
        ) {
          return Promise.resolve({
            ...player,
            timeOnline: formatDurationSince(player.sessionJoinTime) ?? player.timeOnline,
          });
        }
        return this.enrichPlayerDetail(player);
      })
    );

    const onlinePlayers = live
      ? enrichedPlayers.sort((a, b) =>
          (a.characterName ?? a.steamId).localeCompare(b.characterName ?? b.steamId)
        )
      : [];

    return {
      server: {
        timestamp: snapshot?.timestamp ?? new Date().toISOString(),
        serverFps: live ? snapshot?.serverFps : undefined,
        playerCount: live ? (snapshot?.playerCount ?? onlinePlayers.length) : 0,
        zombieCount: live ? snapshot?.zombieCount : undefined,
        animalCount: live ? snapshot?.animalCount : undefined,
        aiCount: live ? snapshot?.aiCount : undefined,
        totalPlayers,
        eventsLastHour,
        eventsLast24h,
        snapshotAvailable: snapshot != null,
        live,
        worldName: snapshot?.worldName,
        worldSize: snapshot?.worldSize,
      },
      onlinePlayers,
      map,
      cftools: cftoolsStatus,
    };
  }

  enqueueCommand(request: DashboardCommandRequest): DashboardCommand {
    const command: DashboardCommand = {
      id: randomUUID(),
      type: request.type,
      steamId: request.steamId,
      classname: request.classname,
      deathEntryId: request.deathEntryId,
      itemPid: request.itemPid,
      message: request.message,
      banDurationMinutes: request.banDurationMinutes,
      x: request.x,
      y: request.y,
      z: request.z,
      quantity: request.quantity ?? 1,
      forceRestore: request.forceRestore ? 1 : undefined,
      createdAt: new Date().toISOString(),
    };

    if (request.type === 'deleteitem' && request.itemPid?.trim()) {
      if (!isPlayerOnline(this.dataRoot, request.steamId)) {
        queuePendingDeletion(this.dataRoot, request.steamId, request.itemPid.trim());
        command.queuedForLogin = true;
        return command;
      }
    }

    const commandsDir = path.join(this.dataRoot, 'commands');
    if (!fs.existsSync(commandsDir)) {
      fs.mkdirSync(commandsDir, { recursive: true });
    }

    const pendingPath = path.join(commandsDir, 'pending.json');
    const existing = readJsonFile<{ commands: DashboardCommand[] }>(pendingPath) ?? { commands: [] };

    existing.commands.push(command);
    fs.writeFileSync(pendingPath, JSON.stringify(existing, null, 2), 'utf8');
    return command;
  }
}
