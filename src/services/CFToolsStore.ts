import type Database from 'better-sqlite3';
import { encryptSecret, decryptSecret } from '../utils/SecretCrypto.js';

export interface CFToolsConfigPublic {
  enabled: boolean;
  applicationId: string;
  serverApiId: string;
  banlistId: string;
  hasSecret: boolean;
  updatedAt: string | null;
}

export interface CFToolsConfigFull extends CFToolsConfigPublic {
  applicationSecret: string;
}

interface Row {
  enabled: number;
  application_id: string;
  application_secret_enc: string | null;
  server_api_id: string;
  banlist_id: string;
  updated_at: string | null;
}

export class CFToolsStore {
  constructor(
    private readonly db: Database.Database,
    private readonly masterSecret: string
  ) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cftools_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        application_id TEXT NOT NULL DEFAULT '',
        application_secret_enc TEXT,
        server_api_id TEXT NOT NULL DEFAULT '',
        banlist_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT
      );
    `);
  }

  getPublicConfig(): CFToolsConfigPublic {
    const row = this.db.prepare('SELECT * FROM cftools_config WHERE id = 1').get() as Row | undefined;
    if (!row) {
      return {
        enabled: false,
        applicationId: '',
        serverApiId: '',
        banlistId: '',
        hasSecret: false,
        updatedAt: null,
      };
    }
    return {
      enabled: row.enabled === 1,
      applicationId: row.application_id ?? '',
      serverApiId: row.server_api_id ?? '',
      banlistId: row.banlist_id ?? '',
      hasSecret: Boolean(row.application_secret_enc),
      updatedAt: row.updated_at,
    };
  }

  getFullConfig(): CFToolsConfigFull | null {
    const row = this.db.prepare('SELECT * FROM cftools_config WHERE id = 1').get() as Row | undefined;
    if (!row) return null;
    let applicationSecret = '';
    if (row.application_secret_enc) {
      try {
        applicationSecret = decryptSecret(row.application_secret_enc, this.masterSecret);
      } catch {
        applicationSecret = '';
      }
    }
    return {
      enabled: row.enabled === 1,
      applicationId: row.application_id ?? '',
      applicationSecret,
      serverApiId: row.server_api_id ?? '',
      banlistId: row.banlist_id ?? '',
      hasSecret: Boolean(row.application_secret_enc),
      updatedAt: row.updated_at,
    };
  }

  isOperational(): boolean {
    const cfg = this.getFullConfig();
    return Boolean(cfg?.enabled && cfg.applicationId && cfg.applicationSecret && cfg.serverApiId);
  }

  saveConfig(input: {
    enabled: boolean;
    applicationId: string;
    applicationSecret?: string;
    serverApiId: string;
    banlistId: string;
  }): CFToolsConfigPublic {
    const existing = this.db.prepare('SELECT application_secret_enc FROM cftools_config WHERE id = 1').get() as
      | { application_secret_enc: string | null }
      | undefined;

    let secretEnc = existing?.application_secret_enc ?? null;
    if (input.applicationSecret !== undefined && input.applicationSecret !== '') {
      secretEnc = encryptSecret(input.applicationSecret, this.masterSecret);
    }

    this.db
      .prepare(
        `INSERT INTO cftools_config (id, enabled, application_id, application_secret_enc, server_api_id, banlist_id, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled,
           application_id = excluded.application_id,
           application_secret_enc = COALESCE(excluded.application_secret_enc, cftools_config.application_secret_enc),
           server_api_id = excluded.server_api_id,
           banlist_id = excluded.banlist_id,
           updated_at = datetime('now')`
      )
      .run(
        input.enabled ? 1 : 0,
        input.applicationId.trim(),
        secretEnc,
        input.serverApiId.trim(),
        input.banlistId.trim()
      );

    return this.getPublicConfig();
  }
}
