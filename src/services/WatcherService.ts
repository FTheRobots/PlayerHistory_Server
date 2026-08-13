import path from 'path';
import type { FSWatcher } from 'chokidar';
import chokidar from 'chokidar';
import { IndexerService } from './IndexerService.js';

export interface WatcherCallbacks {
  onEventsIndexed?: (steamId: string, count: number) => void;
  onProfileIndexed?: (steamId: string) => void;
  onServerJsonChange?: () => void;
}

export class WatcherService {
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly indexer: IndexerService,
    private readonly dataRoot: string,
    private readonly callbacks: WatcherCallbacks = {}
  ) {}

  start(): void {
    const eventsPath = path.join(this.dataRoot, '**', 'events', '*.jsonl');
    const profilePath = path.join(this.dataRoot, '*', 'profile.json');
    const serverJsonPath = path.join(this.dataRoot, 'server.json');

    // Polling remains required for many DayZ host paths / network shares.
    // Slower interval + shorter awaitWriteFinish cuts background I/O vs 1s/3s.
    this.watcher = chokidar.watch([eventsPath, profilePath, serverJsonPath], {
      persistent: true,
      ignoreInitial: false,
      usePolling: true,
      interval: 4000,
      binaryInterval: 4000,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 },
    });

    this.watcher.on('add', (filePath: string) => this.handleFile(filePath));
    this.watcher.on('change', (filePath: string) => this.handleFile(filePath));

    console.log(`[Watcher] Monitoring events, profiles, and server.json (poll 4s)`);
  }

  private async handleFile(filePath: string): Promise<void> {
    try {
      if (filePath.endsWith('server.json')) {
        this.callbacks.onServerJsonChange?.();
        return;
      }

      if (filePath.endsWith('profile.json')) {
        const steamId = path.basename(path.dirname(filePath));
        await this.indexer.indexProfileForSteamId(steamId);
        this.callbacks.onProfileIndexed?.(steamId);
        return;
      }

      const count = await this.indexer.indexFile(filePath);
      if (count > 0) {
        console.log(`[Watcher] Indexed ${count} new events from ${filePath}`);
        const parts = filePath.split(/[/\\]/);
        const eventsIdx = parts.lastIndexOf('events');
        const steamId = eventsIdx > 0 ? parts[eventsIdx - 1] : '';
        if (steamId) this.callbacks.onEventsIndexed?.(steamId, count);
      }
    } catch (err) {
      console.error(`[Watcher] Error indexing ${filePath}:`, err);
    }
  }

  stop(): void {
    this.watcher?.close();
  }
}
