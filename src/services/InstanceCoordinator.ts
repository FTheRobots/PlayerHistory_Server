import type { DatabaseService } from './DatabaseService.js';
import { InstanceStore, type DayZInstance } from './InstanceStore.js';
import { IndexerService } from './IndexerService.js';
import { DashboardService } from './DashboardService.js';
import { DeathService } from './DeathService.js';
import { BanService } from './BanService.js';
import { RetentionService } from './RetentionService.js';
import { WatcherService } from './WatcherService.js';
import type { PlayerRepository } from './PlayerRepository.js';
import type { CFToolsService } from './CFToolsService.js';

export interface InstanceRuntime {
  instance: DayZInstance;
  dataRoot: string;
  indexer: IndexerService;
  dashboard: DashboardService;
  deaths: DeathService;
  banService: BanService;
  retention: RetentionService;
  watcher: WatcherService;
}

export interface InstanceCoordinatorOptions {
  onServerJsonChange?: () => void;
  onEventsIndexed?: (steamId: string, instanceId: string) => void;
}

export class InstanceCoordinator {
  private readonly runtimes = new Map<string, InstanceRuntime>();
  private syncTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dbService: DatabaseService,
    private readonly instanceStore: InstanceStore,
    private readonly repo: PlayerRepository,
    private readonly cftoolsService: CFToolsService,
    private readonly retentionDays: number,
    private readonly options: InstanceCoordinatorOptions = {}
  ) {}

  initialize(defaultPlayerHistoryPath: string): DayZInstance {
    this.instanceStore.ensureDefault(defaultPlayerHistoryPath);
    for (const instance of this.instanceStore.list()) {
      this.mount(instance);
    }
    return this.instanceStore.getById(this.getDefaultInstanceId())!;
  }

  mount(instance: DayZInstance): InstanceRuntime {
    const existing = this.runtimes.get(instance.id);
    if (existing && existing.dataRoot === instance.playerHistoryPath) {
      existing.instance = instance;
      return existing;
    }

    if (existing) {
      existing.watcher.stop();
    }

    const indexer = new IndexerService(this.dbService, instance.playerHistoryPath, instance.id);
    const dashboard = new DashboardService(instance.playerHistoryPath, this.repo, instance.id, this.cftoolsService);
    const deaths = new DeathService(instance.playerHistoryPath);
    const banService = new BanService(instance.playerHistoryPath);
    const retention = new RetentionService(this.dbService, instance.playerHistoryPath, instance.id, this.retentionDays);

    const watcher = new WatcherService(indexer, instance.playerHistoryPath, {
      onServerJsonChange: this.options.onServerJsonChange,
      onEventsIndexed: (steamId) => this.options.onEventsIndexed?.(steamId, instance.id),
    });

    const runtime: InstanceRuntime = {
      instance,
      dataRoot: instance.playerHistoryPath,
      indexer,
      dashboard,
      deaths,
      banService,
      retention,
      watcher,
    };

    this.runtimes.set(instance.id, runtime);
    return runtime;
  }

  unmount(instanceId: string): void {
    const runtime = this.runtimes.get(instanceId);
    if (runtime) {
      runtime.watcher.stop();
      this.runtimes.delete(instanceId);
    }
  }

  has(instanceId: string): boolean {
    return this.runtimes.has(instanceId);
  }

  list(): DayZInstance[] {
    return this.instanceStore.list();
  }

  getDefaultInstanceId(): string {
    return this.instanceStore.getDefaultId();
  }

  resolve(instanceId?: string): InstanceRuntime {
    const id = instanceId?.trim() || this.getDefaultInstanceId();
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      throw new Error(`Unknown instance: ${id}`);
    }
    return runtime;
  }

  async indexAll(options: { light?: boolean } = {}): Promise<{ filesProcessed: number; eventsIndexed: number }> {
    let filesProcessed = 0;
    let eventsIndexed = 0;
    for (const runtime of this.runtimes.values()) {
      const result = await runtime.indexer.indexAll(options);
      filesProcessed += result.filesProcessed;
      eventsIndexed += result.eventsIndexed;
    }
    return { filesProcessed, eventsIndexed };
  }

  async runRetentionPurge(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      if (runtime.retention.isEnabled()) {
        await runtime.retention.purge();
      }
    }
  }

  startWatchers(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.watcher.start();
    }
  }

  stopWatchers(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.watcher.stop();
    }
  }

  startPeriodicSync(intervalMs = 60000): NodeJS.Timeout {
    this.syncTimer = setInterval(async () => {
      try {
        // Light catch-up only — watcher handles realtime file changes.
        const result = await this.indexAll({ light: true });
        if (result.eventsIndexed > 0) {
          console.log(
            `[Indexer] Synced ${result.eventsIndexed} new events from ${result.filesProcessed} files`
          );
        }
      } catch (err) {
        console.error('[Indexer] Periodic sync failed:', err);
      }
    }, intervalMs);
    return this.syncTimer;
  }

  startPeriodicRetention(intervalMs: number): NodeJS.Timeout {
    this.retentionTimer = setInterval(async () => {
      try {
        await this.runRetentionPurge();
      } catch (err) {
        console.error('[Retention] Periodic purge failed:', err);
      }
    }, intervalMs);
    return this.retentionTimer;
  }

  stopTimers(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
  }

  addInstance(input: { name: string; playerHistoryPath: string }): DayZInstance {
    const created = this.instanceStore.create(input);
    this.mount(created);
    void this.runtimes.get(created.id)?.indexer.indexAll();
    this.runtimes.get(created.id)?.watcher.start();
    return created;
  }

  updateInstance(id: string, patch: { name?: string; playerHistoryPath?: string }): DayZInstance {
    const updated = this.instanceStore.update(id, patch);
    this.mount(updated);
    return updated;
  }

  removeInstance(id: string): void {
    this.unmount(id);
    this.instanceStore.delete(id);
    this.dbService.clearAll(id);
  }
}
