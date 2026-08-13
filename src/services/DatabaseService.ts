import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

/** Increment when migrations change — stored in schema_version. */
const SCHEMA_VERSION = 5;

const UPSERT_TRACKED_ITEM_SQL = `
  INSERT INTO tracked_items (
    instance_id, item_pid, item_name, item_classname,
    event_count, first_seen, last_seen,
    last_player_steam_id, last_player_name
  ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
  ON CONFLICT(instance_id, item_pid) DO UPDATE SET
    item_name = COALESCE(excluded.item_name, tracked_items.item_name),
    item_classname = COALESCE(excluded.item_classname, tracked_items.item_classname),
    event_count = tracked_items.event_count + 1,
    first_seen = CASE
      WHEN tracked_items.first_seen IS NULL OR excluded.first_seen < tracked_items.first_seen
      THEN excluded.first_seen ELSE tracked_items.first_seen END,
    last_seen = CASE
      WHEN excluded.last_seen >= tracked_items.last_seen
      THEN excluded.last_seen ELSE tracked_items.last_seen END,
    last_player_steam_id = CASE
      WHEN excluded.last_seen >= tracked_items.last_seen
      THEN excluded.last_player_steam_id ELSE tracked_items.last_player_steam_id END,
    last_player_name = CASE
      WHEN excluded.last_seen >= tracked_items.last_seen
      THEN excluded.last_player_name ELSE tracked_items.last_player_name END
`;

export class DatabaseService {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        applied_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS players (
        instance_id TEXT NOT NULL DEFAULT 'default',
        steam_id TEXT NOT NULL,
        character_name TEXT,
        first_seen TEXT,
        last_seen TEXT,
        total_events INTEGER DEFAULT 0,
        profile_json TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (instance_id, steam_id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL DEFAULT 'default',
        steam_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event TEXT NOT NULL,
        category TEXT,
        session_id TEXT,
        player_name TEXT,
        position_x REAL,
        position_y REAL,
        position_z REAL,
        orientation REAL,
        metadata_json TEXT,
        source_file TEXT,
        source_line INTEGER,
        UNIQUE(instance_id, steam_id, timestamp, event, source_file, source_line)
      );

      CREATE INDEX IF NOT EXISTS idx_events_steam_id ON events(steam_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
      CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
      CREATE INDEX IF NOT EXISTS idx_events_steam_timestamp ON events(steam_id, timestamp);

      CREATE TABLE IF NOT EXISTS indexed_files (
        file_path TEXT PRIMARY KEY,
        last_modified REAL NOT NULL,
        line_count INTEGER DEFAULT 0,
        indexed_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Instance columns must exist before any index or query references instance_id.
    this.migrateInstanceSchema();
    this.migrateSchema();
    this.ensureInstanceIndexes();
    this.verifySchema();
    this.recordSchemaVersion();
  }

  private migrateInstanceSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dayz_instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        player_history_path TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    const eventCols = this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    const eventNames = new Set(eventCols.map((c) => c.name));
    if (!eventNames.has('instance_id')) {
      this.db.exec(`ALTER TABLE events ADD COLUMN instance_id TEXT NOT NULL DEFAULT 'default'`);
    }

    const playerCols = this.db.prepare('PRAGMA table_info(players)').all() as Array<{ name: string }>;
    const playerNames = new Set(playerCols.map((c) => c.name));
    if (!playerNames.has('instance_id')) {
      this.db.exec(`
        CREATE TABLE players_new (
          instance_id TEXT NOT NULL DEFAULT 'default',
          steam_id TEXT NOT NULL,
          character_name TEXT,
          first_seen TEXT,
          last_seen TEXT,
          total_events INTEGER DEFAULT 0,
          profile_json TEXT,
          updated_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (instance_id, steam_id)
        );
        INSERT INTO players_new (instance_id, steam_id, character_name, first_seen, last_seen, total_events, profile_json, updated_at)
          SELECT 'default', steam_id, character_name, first_seen, last_seen, total_events, profile_json, updated_at FROM players;
        DROP TABLE players;
        ALTER TABLE players_new RENAME TO players;
      `);
    }
  }

  private migrateSchema(): void {
    const cols = this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));

    if (!names.has('item_pid')) {
      this.db.exec('ALTER TABLE events ADD COLUMN item_pid TEXT');
    }
    if (!names.has('item_name')) {
      this.db.exec('ALTER TABLE events ADD COLUMN item_name TEXT');
    }
    if (!names.has('item_classname')) {
      this.db.exec('ALTER TABLE events ADD COLUMN item_classname TEXT');
    }
    if (!names.has('from_container_x')) {
      this.db.exec('ALTER TABLE events ADD COLUMN from_container_x REAL');
      this.db.exec('ALTER TABLE events ADD COLUMN from_container_y REAL');
      this.db.exec('ALTER TABLE events ADD COLUMN from_container_z REAL');
      this.db.exec('ALTER TABLE events ADD COLUMN to_container_x REAL');
      this.db.exec('ALTER TABLE events ADD COLUMN to_container_y REAL');
      this.db.exec('ALTER TABLE events ADD COLUMN to_container_z REAL');
      this.db.exec('ALTER TABLE events ADD COLUMN from_container_pid TEXT');
      this.db.exec('ALTER TABLE events ADD COLUMN to_container_pid TEXT');
    }

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_item_pid ON events(item_pid)');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_events_to_container_xz ON events(to_container_x, to_container_z) WHERE to_container_x IS NOT NULL'
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_events_from_container_xz ON events(from_container_x, from_container_z) WHERE from_container_x IS NOT NULL'
    );
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_to_container_pid ON events(to_container_pid) WHERE to_container_pid IS NOT NULL');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_events_from_container_pid ON events(from_container_pid) WHERE from_container_pid IS NOT NULL'
    );

    if (!names.has('from_loc')) {
      this.db.exec('ALTER TABLE events ADD COLUMN from_loc TEXT');
    }
    if (!names.has('to_loc')) {
      this.db.exec('ALTER TABLE events ADD COLUMN to_loc TEXT');
    }
    if (!names.has('from_entity')) {
      this.db.exec('ALTER TABLE events ADD COLUMN from_entity TEXT');
    }
    if (!names.has('to_entity')) {
      this.db.exec('ALTER TABLE events ADD COLUMN to_entity TEXT');
    }
    if (!names.has('source_class')) {
      this.db.exec('ALTER TABLE events ADD COLUMN source_class TEXT');
    }
    if (!names.has('target_type')) {
      this.db.exec('ALTER TABLE events ADD COLUMN target_type TEXT');
    }
    if (!names.has('killer_class')) {
      this.db.exec('ALTER TABLE events ADD COLUMN killer_class TEXT');
    }
    if (!names.has('ammo')) {
      this.db.exec('ALTER TABLE events ADD COLUMN ammo TEXT');
    }
    if (!names.has('damage_amount')) {
      this.db.exec('ALTER TABLE events ADD COLUMN damage_amount REAL');
    }

    const playerCols = this.db.prepare('PRAGMA table_info(players)').all() as Array<{ name: string }>;
    const playerNames = new Set(playerCols.map((c) => c.name));
    if (!playerNames.has('is_online')) {
      this.db.exec('ALTER TABLE players ADD COLUMN is_online INTEGER NOT NULL DEFAULT 0');
      // Backfill from existing profile JSON where possible.
      try {
        this.db.exec(`
          UPDATE players
          SET is_online = 1
          WHERE json_extract(profile_json, '$.isOnline') = 1
             OR json_extract(profile_json, '$.isOnline') = 'true'
        `);
      } catch {
        /* older sqlite without json1 — leave defaults */
      }
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_players_instance_online ON players(instance_id, is_online) WHERE is_online = 1'
    );

    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_events_source_class ON events(source_class) WHERE source_class IS NOT NULL'
    );
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_from_loc ON events(from_loc) WHERE from_loc IS NOT NULL');

    this.ensureTrackedItems();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS saved_queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        instance_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        query_json TEXT NOT NULL,
        is_watch INTEGER NOT NULL DEFAULT 0,
        last_match_count INTEGER,
        last_watch_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_saved_queries_user ON saved_queries(user_id, instance_id);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS query_watch_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        saved_query_id INTEGER NOT NULL,
        instance_id TEXT NOT NULL,
        message TEXT NOT NULL,
        match_count INTEGER NOT NULL,
        previous_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        read_flag INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_query_watch_alerts_user ON query_watch_alerts(user_id, read_flag);
    `);
  }

  private ensureInstanceIndexes(): void {
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_instance_id ON events(instance_id)`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_events_instance_steam_timestamp ON events(instance_id, steam_id, timestamp)`
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_instance_timestamp ON events(instance_id, timestamp)`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_events_instance_steam_category_timestamp
       ON events(instance_id, steam_id, category, timestamp)`
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_events_non_position
       ON events(instance_id, steam_id, timestamp)
       WHERE category IS NOT NULL AND category != 'Position'`
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_event_instance ON events(instance_id, event)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_players_instance_last_seen ON players(instance_id, last_seen)`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_events_instance_item_timestamp
       ON events(instance_id, item_pid, timestamp)
       WHERE item_pid IS NOT NULL`
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_events_instance_steam_item
       ON events(instance_id, steam_id, item_pid)
       WHERE item_pid IS NOT NULL`
    );
  }

  /** Denormalized item index so search/history do not GROUP BY the full events table. */
  private ensureTrackedItems(): void {
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_events_instance_item_timestamp
       ON events(instance_id, item_pid, timestamp)
       WHERE item_pid IS NOT NULL`
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracked_items (
        instance_id TEXT NOT NULL,
        item_pid TEXT NOT NULL,
        item_name TEXT,
        item_classname TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT,
        last_seen TEXT,
        last_player_steam_id TEXT,
        last_player_name TEXT,
        PRIMARY KEY (instance_id, item_pid)
      );
      CREATE INDEX IF NOT EXISTS idx_tracked_items_last_seen
        ON tracked_items(instance_id, last_seen DESC);
      CREATE INDEX IF NOT EXISTS idx_tracked_items_name
        ON tracked_items(instance_id, item_name);
      CREATE INDEX IF NOT EXISTS idx_tracked_items_classname
        ON tracked_items(instance_id, item_classname);
    `);

    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM tracked_items').get() as { c: number }).c;
    if (count > 0) return;

    const hasItemEvents = this.db
      .prepare('SELECT 1 FROM events WHERE item_pid IS NOT NULL LIMIT 1')
      .get();
    if (!hasItemEvents) return;

    console.log('[Database] Building tracked items index (one-time)…');
    const started = Date.now();
    this.rebuildTrackedItems();
    console.log(`[Database] Tracked items index ready in ${Date.now() - started}ms`);
  }

  rebuildTrackedItems(instanceId?: string): number {
    const run = this.db.transaction(() => {
      if (instanceId) {
        this.db.prepare('DELETE FROM tracked_items WHERE instance_id = ?').run(instanceId);
      } else {
        this.db.exec('DELETE FROM tracked_items');
      }

      const sql = `
        INSERT INTO tracked_items (
          instance_id, item_pid, item_name, item_classname,
          event_count, first_seen, last_seen,
          last_player_steam_id, last_player_name
        )
        SELECT
          g.instance_id,
          g.item_pid,
          e.item_name,
          e.item_classname,
          g.event_count,
          g.first_seen,
          g.last_seen,
          e.steam_id,
          e.player_name
        FROM (
          SELECT instance_id, item_pid,
                 COUNT(*) AS event_count,
                 MIN(timestamp) AS first_seen,
                 MAX(timestamp) AS last_seen
          FROM events
          WHERE item_pid IS NOT NULL
            ${instanceId ? 'AND instance_id = ?' : ''}
          GROUP BY instance_id, item_pid
        ) g
        LEFT JOIN events e
          ON e.instance_id = g.instance_id
         AND e.item_pid = g.item_pid
         AND e.timestamp = g.last_seen
        GROUP BY g.instance_id, g.item_pid
      `;

      const result = instanceId ? this.db.prepare(sql).run(instanceId) : this.db.prepare(sql).run();
      return result.changes;
    });

    return run();
  }

  prepareUpsertTrackedItem(): Database.Statement {
    return this.db.prepare(UPSERT_TRACKED_ITEM_SQL);
  }

  private verifySchema(): void {
    const eventCols = this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    if (!eventCols.some((c) => c.name === 'instance_id')) {
      throw new Error('Database schema invalid: events.instance_id is missing. Delete the database file and restart.');
    }

    const playerCols = this.db.prepare('PRAGMA table_info(players)').all() as Array<{ name: string }>;
    if (!playerCols.some((c) => c.name === 'instance_id')) {
      throw new Error('Database schema invalid: players.instance_id is missing. Delete the database file and restart.');
    }
  }

  private recordSchemaVersion(): void {
    this.db
      .prepare(
        `INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`
      )
      .run(SCHEMA_VERSION);
  }

  getDb(): Database.Database {
    return this.db;
  }

  isFileIndexed(filePath: string, mtimeMs: number): boolean {
    const row = this.db
      .prepare('SELECT last_modified FROM indexed_files WHERE file_path = ?')
      .get(filePath) as { last_modified: number } | undefined;
    return row !== undefined && row.last_modified >= mtimeMs;
  }

  getIndexedLineCount(filePath: string): number {
    const row = this.db
      .prepare('SELECT line_count FROM indexed_files WHERE file_path = ?')
      .get(filePath) as { line_count: number } | undefined;
    return row?.line_count ?? 0;
  }

  markFileIndexed(filePath: string, mtimeMs: number, lineCount: number): void {
    this.db
      .prepare(
        `INSERT INTO indexed_files (file_path, last_modified, line_count, indexed_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
           last_modified = excluded.last_modified,
           line_count = excluded.line_count,
           indexed_at = datetime('now')`
      )
      .run(filePath, mtimeMs, lineCount);
  }

  clearAll(instanceId?: string): { eventsDeleted: number; playersDeleted: number; filesCleared: number } {
    if (instanceId) {
      const sourceFiles = (
        this.db
          .prepare(
            `SELECT DISTINCT source_file FROM events WHERE instance_id = ? AND source_file IS NOT NULL`
          )
          .all(instanceId) as Array<{ source_file: string }>
      ).map((r) => r.source_file);

      const eventsDeleted = this.db
        .prepare('DELETE FROM events WHERE instance_id = ?')
        .run(instanceId).changes;
      const playersDeleted = this.db
        .prepare('DELETE FROM players WHERE instance_id = ?')
        .run(instanceId).changes;
      this.db.prepare('DELETE FROM tracked_items WHERE instance_id = ?').run(instanceId);

      let filesCleared = 0;
      const deleteIndexed = this.db.prepare('DELETE FROM indexed_files WHERE file_path = ?');
      for (const filePath of sourceFiles) {
        filesCleared += deleteIndexed.run(filePath).changes;
      }

      return { eventsDeleted, playersDeleted, filesCleared };
    }

    const eventsDeleted = this.db.prepare('DELETE FROM events').run().changes;
    const playersDeleted = this.db.prepare('DELETE FROM players').run().changes;
    this.db.prepare('DELETE FROM tracked_items').run();
    const filesCleared = this.db.prepare('DELETE FROM indexed_files').run().changes;
    return { eventsDeleted, playersDeleted, filesCleared };
  }

  close(): void {
    this.db.close();
  }
}
