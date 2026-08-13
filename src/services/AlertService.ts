import type { DashboardData, OnlinePlayerDetail } from '../types/index.js';
import type { PlayerRepository } from './PlayerRepository.js';
import type { WatchlistStore, WatchlistEntry } from './WatchlistStore.js';
import type { AlertStore, AlertEventType } from './AlertStore.js';
import type { WebSocketHub } from './WebSocketHub.js';

const JOIN_EVENTS = new Set(['Join', 'PlayerConnect']);
const LEAVE_EVENTS = new Set(['Disconnect', 'PlayerDisconnect']);
const DEATH_EVENTS = new Set(['PlayerDeath', 'Death']);
const KILL_EVENTS = new Set(['PlayerKilled', 'Kill']);
const BAN_EVENTS = new Set(['Ban']);

export class AlertService {
  private onlineSteamIds = new Set<string>();
  private lastEventCheck = new Map<string, string>();

  constructor(
    private readonly watchlistStore: WatchlistStore,
    private readonly alertStore: AlertStore,
    private readonly repo: PlayerRepository,
    private readonly wsHub: WebSocketHub | null
  ) {}

  processDashboard(data: DashboardData): void {
    const current = new Set(data.onlinePlayers.map((p) => p.steamId));
    const playerBySteam = new Map(data.onlinePlayers.map((p) => [p.steamId, p]));

    for (const steamId of current) {
      if (!this.onlineSteamIds.has(steamId)) {
        this.emitForSteam(steamId, 'join', playerBySteam.get(steamId), `${this.label(playerBySteam.get(steamId), steamId)} joined the server`);
      }
    }

    for (const steamId of this.onlineSteamIds) {
      if (!current.has(steamId)) {
        this.emitForSteam(steamId, 'leave', undefined, `${steamId} left the server`);
      }
    }

    this.onlineSteamIds = current;
  }

  processIndexedEvents(instanceId: string, steamId: string): void {
    const since = this.lastEventCheck.get(`${instanceId}:${steamId}`) ?? new Date(Date.now() - 60_000).toISOString();
    const events = this.repo.getEventsSince(instanceId, steamId, since, 20);
    if (events.length === 0) return;

    this.lastEventCheck.set(`${instanceId}:${steamId}`, events[events.length - 1]!.timestamp);

    for (const event of events) {
      let eventType: AlertEventType | null = null;
      if (JOIN_EVENTS.has(event.event)) eventType = 'join';
      else if (LEAVE_EVENTS.has(event.event)) eventType = 'leave';
      else if (DEATH_EVENTS.has(event.event)) eventType = 'death';
      else if (KILL_EVENTS.has(event.event)) eventType = 'kill';
      else if (BAN_EVENTS.has(event.event)) eventType = 'ban';

      if (!eventType) continue;

      const message = `${this.label(undefined, steamId, event.playerName)} — ${event.event}${event.metadata?.reason ? `: ${event.metadata.reason}` : ''}`;
      this.emitForSteam(steamId, eventType, undefined, message, event.playerName);
    }
  }

  private label(player?: OnlinePlayerDetail, steamId?: string, playerName?: string): string {
    return player?.characterName ?? playerName ?? steamId ?? 'Unknown player';
  }

  private emitForSteam(
    steamId: string,
    eventType: AlertEventType,
    player?: OnlinePlayerDetail,
    message?: string,
    playerName?: string
  ): void {
    const entries = this.watchlistStore.findMatching(steamId);
    if (entries.length === 0) return;

    const displayName = this.label(player, steamId, playerName);
    const text = message ?? `${displayName} — ${eventType}`;

    for (const entry of entries) {
      if (!this.shouldAlert(entry, eventType)) continue;

      const alert = this.alertStore.create({
        watchlistEntryId: entry.id,
        steamId,
        playerName: displayName,
        eventType,
        message: text,
        scope: entry.scope,
        userId: entry.scope === 'personal' ? entry.userId : null,
      });

      this.wsHub?.broadcastAlert(alert);
    }
  }

  private shouldAlert(entry: WatchlistEntry, eventType: AlertEventType): boolean {
    switch (eventType) {
      case 'join':
        return entry.alertOnJoin;
      case 'leave':
        return entry.alertOnLeave;
      case 'death':
        return entry.alertOnDeath;
      case 'kill':
        return entry.alertOnKill;
      case 'ban':
        return entry.alertOnBan;
      default:
        return false;
    }
  }
}
