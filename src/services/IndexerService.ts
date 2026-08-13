import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { glob } from 'glob';
import { DatabaseService } from './DatabaseService.js';
import type { PlayerEvent, PlayerProfile } from '../types/index.js';
import { enrichEventItemFields } from '../utils/itemExtract.js';
import { enrichContainerFields } from '../utils/containerExtract.js';
import { enrichQueryableMetadata } from '../utils/metadataExtract.js';

export class IndexerService {
  private queryBackfillDone = false;
  private syncRunning = false;

  constructor(
    private readonly dbService: DatabaseService,
    private readonly dataRoot: string,
    private readonly instanceId: string
  ) {}

  getInstanceId(): string {
    return this.instanceId;
  }

  clearIndex(): { eventsDeleted: number; playersDeleted: number; filesCleared: number } {
    return this.dbService.clearAll(this.instanceId);
  }

  deletePlayer(
    steamId: string,
    deleteFiles = false
  ): {
    steamId: string;
    eventsDeleted: number;
    playerDeleted: number;
    indexedFilesRemoved: number;
    logFilesDeleted: boolean;
  } {
    const { eventsDeleted, playerDeleted, sourceFiles } = this.repoDeletePlayer(steamId);

    const db = this.dbService.getDb();
    let indexedFilesRemoved = 0;
    for (const filePath of sourceFiles) {
      indexedFilesRemoved += db.prepare('DELETE FROM indexed_files WHERE file_path = ?').run(filePath).changes;
    }

    let logFilesDeleted = false;
    if (deleteFiles) {
      const playerDir = path.join(this.dataRoot, steamId);
      if (fs.existsSync(playerDir)) {
        fs.rmSync(playerDir, { recursive: true, force: true });
        logFilesDeleted = true;
      }
    }

    return {
      steamId,
      eventsDeleted,
      playerDeleted,
      indexedFilesRemoved,
      logFilesDeleted,
    };
  }

  private repoDeletePlayer(steamId: string) {
    const db = this.dbService.getDb();

    const sourceFiles = (
      db
        .prepare(
          'SELECT DISTINCT source_file FROM events WHERE instance_id = ? AND steam_id = ? AND source_file IS NOT NULL'
        )
        .all(this.instanceId, steamId) as Array<{ source_file: string }>
    ).map((r) => r.source_file);

    const eventsDeleted = db.prepare('DELETE FROM events WHERE instance_id = ? AND steam_id = ?').run(this.instanceId, steamId).changes;
    const playerDeleted = db.prepare('DELETE FROM players WHERE instance_id = ? AND steam_id = ?').run(this.instanceId, steamId).changes;
    if (eventsDeleted > 0) {
      this.dbService.rebuildTrackedItems(this.instanceId);
    }

    return { eventsDeleted, playerDeleted, sourceFiles };
  }

  async indexAll(options: { light?: boolean } = {}): Promise<{ filesProcessed: number; eventsIndexed: number }> {
    if (this.syncRunning) {
      return { filesProcessed: 0, eventsIndexed: 0 };
    }
    this.syncRunning = true;
    try {
      let filesProcessed = 0;
      let eventsIndexed = 0;

      const pattern = path.join(this.dataRoot, '**', 'events', '*.jsonl').replace(/\\/g, '/');
      const files = await glob(pattern);

      for (const filePath of files) {
        const count = await this.indexFile(filePath);
        if (count >= 0) {
          filesProcessed++;
          eventsIndexed += count;
        }
      }

      // Full profile + backfill only on heavy sync (startup / manual reindex).
      if (!options.light) {
        await this.indexProfiles();
        this.backfillItemColumns();
        this.backfillContainerColumns();
        this.backfillQueryableColumns();
      } else if (eventsIndexed > 0) {
        // Cheap catch-up: only backfill queryable when new rows arrived.
        this.backfillQueryableColumns();
      }

      return { filesProcessed, eventsIndexed };
    } finally {
      this.syncRunning = false;
    }
  }

  /** Populate item_pid columns from metadata on rows indexed before item tracking. */
  backfillItemColumns(): number {
    const db = this.dbService.getDb();
    const rows = db
      .prepare(
        `SELECT rowid, instance_id, steam_id, timestamp, player_name, metadata_json FROM events
         WHERE item_pid IS NULL AND metadata_json IS NOT NULL
         LIMIT 100000`
      )
      .all() as Array<{
      rowid: number;
      instance_id: string;
      steam_id: string;
      timestamp: string;
      player_name: string | null;
      metadata_json: string;
    }>;

    if (rows.length === 0) return 0;

    const update = db.prepare(
      `UPDATE events SET item_pid = ?, item_name = ?, item_classname = ? WHERE rowid = ?`
    );
    const upsertItem = this.dbService.prepareUpsertTrackedItem();

    let updated = 0;
    const run = db.transaction(() => {
      for (const row of rows) {
        try {
          const metadata = JSON.parse(row.metadata_json) as Record<string, string>;
          const fields = enrichEventItemFields({ metadata } as PlayerEvent);
          if (!fields.itemPid) continue;
          update.run(fields.itemPid, fields.itemName, fields.itemClassname, row.rowid);
          upsertItem.run(
            row.instance_id,
            fields.itemPid,
            fields.itemName,
            fields.itemClassname,
            row.timestamp,
            row.timestamp,
            row.steam_id,
            row.player_name
          );
          updated++;
        } catch {
          // skip
        }
      }
    });
    run();
    if (updated > 0) {
      console.log(`[Indexer] Backfilled item PID on ${updated} events`);
    }
    return updated;
  }

  /** Populate container position columns from metadata on older rows. */
  backfillContainerColumns(): number {
    const db = this.dbService.getDb();
    const rows = db
      .prepare(
        `SELECT rowid, metadata_json FROM events
         WHERE to_container_x IS NULL AND from_container_x IS NULL
           AND metadata_json IS NOT NULL
         LIMIT 100000`
      )
      .all() as Array<{ rowid: number; metadata_json: string }>;

    if (rows.length === 0) return 0;

    const update = db.prepare(
      `UPDATE events SET
         from_container_x = ?, from_container_y = ?, from_container_z = ?,
         to_container_x = ?, to_container_y = ?, to_container_z = ?,
         from_container_pid = ?, to_container_pid = ?
       WHERE rowid = ?`
    );

    let updated = 0;
    const run = db.transaction(() => {
      for (const row of rows) {
        try {
          const metadata = JSON.parse(row.metadata_json) as Record<string, string>;
          const fields = enrichContainerFields({ metadata } as PlayerEvent);
          const hasContainer =
            fields.fromContainerX != null ||
            fields.toContainerX != null ||
            fields.fromContainerPid ||
            fields.toContainerPid;
          if (!hasContainer) continue;

          update.run(
            fields.fromContainerX,
            fields.fromContainerY,
            fields.fromContainerZ,
            fields.toContainerX,
            fields.toContainerY,
            fields.toContainerZ,
            fields.fromContainerPid,
            fields.toContainerPid,
            row.rowid
          );
          updated++;
        } catch {
          // skip
        }
      }
    });
    run();
    if (updated > 0) {
      console.log(`[Indexer] Backfilled container fields on ${updated} events`);
    }
    return updated;
  }

  backfillQueryableColumns(): number {
    if (this.queryBackfillDone) return 0;

    const db = this.dbService.getDb();
    const rows = db
      .prepare(
        `SELECT rowid, metadata_json, event FROM events
         WHERE metadata_json IS NOT NULL
           AND from_loc IS NULL AND to_loc IS NULL AND from_entity IS NULL AND to_entity IS NULL
           AND source_class IS NULL AND target_type IS NULL AND killer_class IS NULL
           AND ammo IS NULL AND damage_amount IS NULL
         LIMIT 100000`
      )
      .all() as Array<{ rowid: number; metadata_json: string; event: string }>;

    if (rows.length === 0) {
      this.queryBackfillDone = true;
      return 0;
    }

    const update = db.prepare(
      `UPDATE events SET from_loc = ?, to_loc = ?, from_entity = ?, to_entity = ?,
         source_class = ?, target_type = ?, killer_class = ?, ammo = ?, damage_amount = ?
       WHERE rowid = ?`
    );

    let updated = 0;
    const run = db.transaction(() => {
      for (const row of rows) {
        try {
          const metadata = JSON.parse(row.metadata_json) as Record<string, string>;
          const q = enrichQueryableMetadata({ metadata, event: row.event } as import('../types/index.js').PlayerEvent);
          const hasAny =
            q.fromLoc ||
            q.toLoc ||
            q.fromEntity ||
            q.toEntity ||
            q.sourceClass ||
            q.targetType ||
            q.killerClass ||
            q.ammo ||
            q.damageAmount != null;
          if (!hasAny) continue;
          const result = update.run(
            q.fromLoc,
            q.toLoc,
            q.fromEntity,
            q.toEntity,
            q.sourceClass,
            q.targetType,
            q.killerClass,
            q.ammo,
            q.damageAmount,
            row.rowid
          );
          if (result.changes > 0) updated++;
        } catch {
          // skip
        }
      }
    });
    run();
    const remaining = db
      .prepare(
        `SELECT 1 FROM events
         WHERE metadata_json IS NOT NULL
           AND from_loc IS NULL AND to_loc IS NULL AND from_entity IS NULL AND to_entity IS NULL
           AND source_class IS NULL AND target_type IS NULL AND killer_class IS NULL
           AND ammo IS NULL AND damage_amount IS NULL
         LIMIT 1`
      )
      .get();
    if (!remaining) this.queryBackfillDone = true;
    if (updated > 0) console.log(`[Indexer] Backfilled queryable metadata on ${updated} events`);
    return updated;
  }

  async indexFile(filePath: string): Promise<number> {
    if (!fs.existsSync(filePath)) return -1;

    const stat = fs.statSync(filePath);
    const skipLines = this.dbService.getIndexedLineCount(filePath);

    if (this.dbService.isFileIndexed(filePath, stat.mtimeMs)) {
      // Trust mtime: the watcher already catches appends that bump mtime.
      return 0;
    }

    const steamId = this.extractSteamId(filePath);
    if (!steamId) return -1;

    const db = this.dbService.getDb();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO events
        (instance_id, steam_id, timestamp, event, category, session_id, player_name,
         position_x, position_y, position_z, orientation, metadata_json,
         item_pid, item_name, item_classname,
         from_container_x, from_container_y, from_container_z,
         to_container_x, to_container_y, to_container_z,
         from_container_pid, to_container_pid,
         from_loc, to_loc, from_entity, to_entity,
         source_class, target_type, killer_class, ammo, damage_amount,
         source_file, source_line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertItem = this.dbService.prepareUpsertTrackedItem();

    let lineNum = 0;
    let inserted = 0;

    const insertMany = db.transaction((lines: { event: PlayerEvent; line: number }[]) => {
      for (const { event, line } of lines) {
        const itemFields = enrichEventItemFields(event);
        const containerFields = enrichContainerFields(event);
        const queryFields = enrichQueryableMetadata(event);
        const result = insert.run(
          this.instanceId,
          steamId,
          event.timestamp,
          event.event,
          event.category ?? null,
          event.sessionId ?? null,
          event.playerName ?? null,
          event.position?.[0] ?? null,
          event.position?.[1] ?? null,
          event.position?.[2] ?? null,
          event.orientation ?? null,
          event.metadata ? JSON.stringify(event.metadata) : null,
          itemFields.itemPid,
          itemFields.itemName,
          itemFields.itemClassname,
          containerFields.fromContainerX,
          containerFields.fromContainerY,
          containerFields.fromContainerZ,
          containerFields.toContainerX,
          containerFields.toContainerY,
          containerFields.toContainerZ,
          containerFields.fromContainerPid,
          containerFields.toContainerPid,
          queryFields.fromLoc,
          queryFields.toLoc,
          queryFields.fromEntity,
          queryFields.toEntity,
          queryFields.sourceClass,
          queryFields.targetType,
          queryFields.killerClass,
          queryFields.ammo,
          queryFields.damageAmount,
          filePath,
          line
        );
        if (result.changes > 0) {
          inserted++;
          if (itemFields.itemPid) {
            upsertItem.run(
              this.instanceId,
              itemFields.itemPid,
              itemFields.itemName,
              itemFields.itemClassname,
              event.timestamp,
              event.timestamp,
              steamId,
              event.playerName ?? null
            );
          }
        }
      }
    });

    const batch: { event: PlayerEvent; line: number }[] = [];

    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (line) => {
        lineNum++;
        if (lineNum <= skipLines) return;

        const trimmed = line.trim();
        if (!trimmed) return;

        try {
          const event = JSON.parse(trimmed) as PlayerEvent;
          batch.push({ event, line: lineNum });

          if (batch.length >= 500) {
            insertMany(batch.splice(0));
          }
        } catch {
          // skip malformed lines
        }
      });

      rl.on('close', () => {
        if (batch.length > 0) insertMany(batch);
        resolve();
      });

      rl.on('error', reject);
    });

    this.dbService.markFileIndexed(filePath, stat.mtimeMs, lineNum);
    if (inserted > 0) {
      this.bumpPlayerStats(steamId, inserted);
    }
    await this.indexProfileForSteamId(steamId);
    return inserted;
  }

  async indexProfileForSteamId(steamId: string): Promise<void> {
    const profilePath = path.join(this.dataRoot, steamId, 'profile.json');
    if (!fs.existsSync(profilePath)) return;

    try {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as PlayerProfile;
      const isOnline = profile.isOnline === true ? 1 : 0;
      const upsert = this.dbService.getDb().prepare(`
        INSERT INTO players (instance_id, steam_id, character_name, first_seen, last_seen, profile_json, is_online, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(instance_id, steam_id) DO UPDATE SET
          character_name = excluded.character_name,
          first_seen = COALESCE(players.first_seen, excluded.first_seen),
          last_seen = excluded.last_seen,
          profile_json = excluded.profile_json,
          is_online = excluded.is_online,
          updated_at = datetime('now')
      `);
      upsert.run(
        this.instanceId,
        profile.steamId,
        profile.characterName ?? null,
        profile.firstSeen ?? null,
        profile.lastSeen ?? null,
        JSON.stringify(profile),
        isOnline
      );
    } catch {
      // skip
    }
  }

  private async indexProfiles(): Promise<void> {
    const pattern = path.join(this.dataRoot, '*', 'profile.json').replace(/\\/g, '/');
    const files = await glob(pattern);

    const upsert = this.dbService.getDb().prepare(`
      INSERT INTO players (instance_id, steam_id, character_name, first_seen, last_seen, profile_json, is_online, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(instance_id, steam_id) DO UPDATE SET
        character_name = excluded.character_name,
        first_seen = COALESCE(players.first_seen, excluded.first_seen),
        last_seen = excluded.last_seen,
        profile_json = excluded.profile_json,
        is_online = excluded.is_online,
        updated_at = datetime('now')
    `);

    for (const filePath of files) {
      try {
        const profile = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PlayerProfile;
        upsert.run(
          this.instanceId,
          profile.steamId,
          profile.characterName ?? null,
          profile.firstSeen ?? null,
          profile.lastSeen ?? null,
          JSON.stringify(profile),
          profile.isOnline === true ? 1 : 0
        );
      } catch {
        // skip
      }
    }
  }

  /** Cheap incremental stats update — avoids full COUNT/MIN/MAX on every file append. */
  private bumpPlayerStats(steamId: string, insertedCount: number): void {
    const db = this.dbService.getDb();
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO players (instance_id, steam_id, total_events, first_seen, last_seen, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(instance_id, steam_id) DO UPDATE SET
         total_events = COALESCE(players.total_events, 0) + excluded.total_events,
         first_seen = COALESCE(players.first_seen, excluded.first_seen),
         last_seen = excluded.last_seen,
         updated_at = datetime('now')`
    ).run(this.instanceId, steamId, insertedCount, nowIso, nowIso);
  }

  private extractSteamId(filePath: string): string | null {
    const parts = filePath.split(/[/\\]/);
    const eventsIdx = parts.lastIndexOf('events');
    if (eventsIdx > 0) return parts[eventsIdx - 1];
    return null;
  }
}
