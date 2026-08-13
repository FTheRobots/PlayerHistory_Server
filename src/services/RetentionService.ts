import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { DatabaseService } from './DatabaseService.js';

export interface RetentionPurgeResult {
  eventsDeleted: number;
  filesDeleted: number;
  indexedFilesRemoved: number;
  playersUpdated: number;
  cutoffIso: string;
  cutoffDate: string;
}

const EVENT_LOG_NAME = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const VACUUM_EVENT_THRESHOLD = 10_000;

export class RetentionService {
  private running = false;

  constructor(
    private readonly dbService: DatabaseService,
    private readonly dataRoot: string,
    private readonly instanceId: string,
    private readonly retentionDays: number
  ) {}

  isEnabled(): boolean {
    return this.retentionDays > 0;
  }

  computeCutoff(): { cutoffIso: string; cutoffDate: string } {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - this.retentionDays);
    cutoff.setUTCHours(0, 0, 0, 0);

    const cutoffDate = cutoff.toISOString().slice(0, 10);
    return { cutoffIso: `${cutoffDate}T00:00:00.000Z`, cutoffDate };
  }

  async purge(): Promise<RetentionPurgeResult> {
    if (!this.isEnabled()) {
      return {
        eventsDeleted: 0,
        filesDeleted: 0,
        indexedFilesRemoved: 0,
        playersUpdated: 0,
        cutoffIso: '',
        cutoffDate: '',
      };
    }

    if (this.running) {
      console.warn('[Retention] Purge already in progress — skipping');
      return {
        eventsDeleted: 0,
        filesDeleted: 0,
        indexedFilesRemoved: 0,
        playersUpdated: 0,
        cutoffIso: '',
        cutoffDate: '',
      };
    }

    this.running = true;
    const { cutoffIso, cutoffDate } = this.computeCutoff();

    try {
      const db = this.dbService.getDb();
      let filesDeleted = 0;
      let indexedFilesRemoved = 0;

      const pattern = path.join(this.dataRoot, '**', 'events', '*.jsonl').replace(/\\/g, '/');
      const files = await glob(pattern);
      const deletedPaths: string[] = [];

      for (const filePath of files) {
        const base = path.basename(filePath);
        const match = base.match(EVENT_LOG_NAME);
        if (!match) continue;

        if (match[1] < cutoffDate) {
          try {
            fs.unlinkSync(filePath);
            filesDeleted++;
            deletedPaths.push(path.normalize(filePath));
          } catch (err) {
            console.warn(`[Retention] Failed to delete ${filePath}:`, err);
          }
        }
      }

      const deleteIndexed = db.prepare('DELETE FROM indexed_files WHERE file_path = ?');
      for (const filePath of deletedPaths) {
        indexedFilesRemoved += deleteIndexed.run(filePath).changes;
      }

      const staleIndexed = db
        .prepare('SELECT file_path FROM indexed_files')
        .all() as Array<{ file_path: string }>;

      for (const row of staleIndexed) {
        if (!fs.existsSync(row.file_path)) {
          indexedFilesRemoved += deleteIndexed.run(row.file_path).changes;
        }
      }

      const eventsDeleted = db
        .prepare('DELETE FROM events WHERE instance_id = ? AND timestamp < ?')
        .run(this.instanceId, cutoffIso).changes;
      const playersUpdated = this.refreshPlayerStatsAfterPurge();
      if (eventsDeleted > 0) {
        this.dbService.rebuildTrackedItems(this.instanceId);
      }

      if (eventsDeleted >= VACUUM_EVENT_THRESHOLD) {
        try {
          console.log('[Retention] Running VACUUM to reclaim disk space...');
          db.exec('VACUUM');
        } catch (err) {
          console.warn('[Retention] VACUUM failed:', err);
        }
      }

      return {
        eventsDeleted,
        filesDeleted,
        indexedFilesRemoved,
        playersUpdated,
        cutoffIso,
        cutoffDate,
      };
    } finally {
      this.running = false;
    }
  }

  private refreshPlayerStatsAfterPurge(): number {
    const db = this.dbService.getDb();

    const rows = db
      .prepare(
        `SELECT steam_id, COUNT(*) as total, MIN(timestamp) as first_seen, MAX(timestamp) as last_seen
         FROM events WHERE instance_id = ?
         GROUP BY steam_id`
      )
      .all(this.instanceId) as Array<{
      steam_id: string;
      total: number;
      first_seen: string | null;
      last_seen: string | null;
    }>;

    const updateStats = db.prepare(
      `INSERT INTO players (instance_id, steam_id, total_events, first_seen, last_seen, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(instance_id, steam_id) DO UPDATE SET
         total_events = excluded.total_events,
         first_seen = excluded.first_seen,
         last_seen = excluded.last_seen,
         updated_at = datetime('now')`
    );

    const refresh = db.transaction(() => {
      for (const row of rows) {
        updateStats.run(this.instanceId, row.steam_id, row.total, row.first_seen, row.last_seen);
      }

      db.prepare(
        `UPDATE players SET total_events = 0, first_seen = NULL, last_seen = NULL, updated_at = datetime('now')
         WHERE instance_id = ? AND steam_id NOT IN (SELECT DISTINCT steam_id FROM events WHERE instance_id = ?)`
      ).run(this.instanceId, this.instanceId);
    });

    refresh();
    return rows.length;
  }

  startPeriodicPurge(intervalMs: number, onComplete?: (result: RetentionPurgeResult) => void): NodeJS.Timeout {
    return setInterval(async () => {
      try {
        const result = await this.purge();
        if (
          result.eventsDeleted > 0 ||
          result.filesDeleted > 0 ||
          result.indexedFilesRemoved > 0
        ) {
          console.log(
            `[Retention] Purged ${result.eventsDeleted} events, ${result.filesDeleted} log files (older than ${result.cutoffDate})`
          );
        }
        onComplete?.(result);
      } catch (err) {
        console.error('[Retention] Periodic purge failed:', err);
      }
    }, intervalMs);
  }
}
