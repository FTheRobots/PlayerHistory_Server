import fs from 'fs';
import path from 'path';

export interface BanRecord {
  steamId: string;
  reason: string;
  bannedAt: string;
  expiresAt: string;
  isPermanent: boolean;
  isExpired: boolean;
  characterName?: string;
}

interface BanFileEntry {
  steamId: string;
  reason: string;
  bannedAt: string;
  expiresAt: string;
}

export class BanService {
  constructor(private readonly dataRoot: string) {}

  private bansDir(): string {
    const dir = path.join(this.dataRoot, 'bans');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private banPath(steamId: string): string {
    return path.join(this.bansDir(), `${steamId}.json`);
  }

  private readBanFile(steamId: string): BanFileEntry | null {
    const filePath = this.banPath(steamId);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as BanFileEntry;
    } catch {
      return null;
    }
  }

  private isExpired(expiresAt: string): boolean {
    if (!expiresAt) return false;
    return expiresAt < new Date().toISOString();
  }

  listBans(): BanRecord[] {
    const dir = this.bansDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const bans: BanRecord[] = [];

    for (const file of files) {
      const steamId = file.replace(/\.json$/, '');
      const entry = this.readBanFile(steamId);
      if (!entry) continue;

      const expired = entry.expiresAt ? this.isExpired(entry.expiresAt) : false;
      if (expired) {
        this.removeBan(steamId);
        continue;
      }

      bans.push({
        steamId: entry.steamId || steamId,
        reason: entry.reason || '',
        bannedAt: entry.bannedAt || '',
        expiresAt: entry.expiresAt || '',
        isPermanent: !entry.expiresAt,
        isExpired: false,
      });
    }

    return bans.sort((a, b) => b.bannedAt.localeCompare(a.bannedAt));
  }

  getBan(steamId: string): BanRecord | null {
    const entry = this.readBanFile(steamId);
    if (!entry) return null;
    if (entry.expiresAt && this.isExpired(entry.expiresAt)) {
      this.removeBan(steamId);
      return null;
    }
    return {
      steamId: entry.steamId || steamId,
      reason: entry.reason || '',
      bannedAt: entry.bannedAt || '',
      expiresAt: entry.expiresAt || '',
      isPermanent: !entry.expiresAt,
      isExpired: false,
    };
  }

  createBan(steamId: string, reason: string, banDurationMinutes = 0): BanRecord {
    if (!steamId.trim()) throw new Error('steamId is required');

    const bannedAt = new Date().toISOString();
    let expiresAt = '';
    if (banDurationMinutes > 0) {
      expiresAt = new Date(Date.now() + banDurationMinutes * 60_000).toISOString();
    }

    const entry: BanFileEntry = {
      steamId: steamId.trim(),
      reason: reason.trim(),
      bannedAt,
      expiresAt,
    };

    fs.writeFileSync(this.banPath(steamId.trim()), JSON.stringify(entry, null, 2), 'utf8');

    return {
      steamId: entry.steamId,
      reason: entry.reason,
      bannedAt: entry.bannedAt,
      expiresAt: entry.expiresAt,
      isPermanent: !entry.expiresAt,
      isExpired: false,
    };
  }

  removeBan(steamId: string): boolean {
    const filePath = this.banPath(steamId);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }
}
