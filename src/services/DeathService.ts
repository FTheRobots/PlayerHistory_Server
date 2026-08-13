import fs from 'fs';
import path from 'path';
import { readPendingDeletions, type PendingDeletionEntry } from '../utils/pendingDeletions.js';

export interface DeathSnapshotSummary {
  entryId: string;
  ownerSteam64: string;
  ownerName?: string;
  deathTimeText?: string;
  deathPosition?: [number, number, number];
  wasRestored: boolean;
  rootItemCount: number;
}

export interface DeathSnapshotItemRow {
  itemTypeName: string;
  depth: number;
  itemPid?: string;
  inHands?: boolean;
  quantity?: number;
  ammoCount?: number;
}

export type { PendingDeletionEntry };

export interface PlayerInventoryResponse {
  source: 'live' | 'snapshot' | 'none';
  steamId: string;
  capturedAt?: string;
  snapshotEntryId?: string;
  rootItemCount: number;
  items: DeathSnapshotItemRow[];
  pendingDeletions?: PendingDeletionEntry[];
}

interface DeathSnapshotItemNode {
  ItemTypeName?: string;
  ItemPid?: string;
  InHands?: boolean;
  ItemQuantity?: number;
  MagazineAmmoCount?: number;
  Attachments?: DeathSnapshotItemNode[];
  Cargo?: DeathSnapshotItemNode[];
}

interface DeathSnapshotFile {
  EntryId?: string;
  OwnerSteam64?: string;
  OwnerName?: string;
  DeathTimeText?: string;
  DeathPosition?: number[];
  WasRestored?: number;
  RootItemCount?: number;
  RootItems?: DeathSnapshotItemNode[];
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function flattenItems(items: DeathSnapshotItemNode[] | undefined, depth = 0): DeathSnapshotItemRow[] {
  if (!items?.length) return [];

  const rows: DeathSnapshotItemRow[] = [];
  for (const item of items) {
    rows.push({
      itemTypeName: item.ItemTypeName?.trim() || 'Unknown',
      depth,
      itemPid: item.ItemPid?.trim() || undefined,
      inHands: item.InHands === true,
      quantity: item.ItemQuantity != null && item.ItemQuantity >= 0 ? item.ItemQuantity : undefined,
      ammoCount:
        item.MagazineAmmoCount != null && item.MagazineAmmoCount >= 0
          ? item.MagazineAmmoCount
          : undefined,
    });
    rows.push(...flattenItems(item.Attachments, depth + 1));
    rows.push(...flattenItems(item.Cargo, depth + 1));
  }
  return rows;
}

function toSummary(data: DeathSnapshotFile): DeathSnapshotSummary | null {
  if (!data.EntryId || !data.OwnerSteam64) return null;

  const pos = data.DeathPosition;
  const deathPosition =
    pos && pos.length >= 3 ? ([pos[0], pos[1] ?? 0, pos[2]] as [number, number, number]) : undefined;

  const rootItemCount =
    data.RootItemCount != null && data.RootItemCount >= 0
      ? data.RootItemCount
      : data.RootItems?.length ?? 0;

  return {
    entryId: data.EntryId,
    ownerSteam64: data.OwnerSteam64,
    ownerName: data.OwnerName,
    deathTimeText: data.DeathTimeText,
    deathPosition,
    wasRestored: data.WasRestored === 1,
    rootItemCount,
  };
}

export class DeathService {
  constructor(private readonly dataRoot: string) {}

  private snapshotDir(steamId: string, kind: 'deaths' | 'inventory_snapshots'): string {
    return path.join(this.dataRoot, steamId, kind);
  }

  private listFromDir(steamId: string, kind: 'deaths' | 'inventory_snapshots', includeRestored = false): DeathSnapshotSummary[] {
    const dir = this.snapshotDir(steamId, kind);
    if (!fs.existsSync(dir)) return [];

    const entries: DeathSnapshotSummary[] = [];
    for (const fileName of fs.readdirSync(dir)) {
      if (!fileName.endsWith('.json')) continue;

      const data = readJsonFile<DeathSnapshotFile>(path.join(dir, fileName));
      if (!data) continue;

      const summary = toSummary(data);
      if (!summary) continue;
      if (!includeRestored && summary.wasRestored) continue;

      entries.push(summary);
    }

    return entries.sort((a, b) => (b.deathTimeText ?? '').localeCompare(a.deathTimeText ?? ''));
  }

  private getFromDir(steamId: string, entryId: string, kind: 'deaths' | 'inventory_snapshots'): DeathSnapshotSummary | null {
    const filePath = path.join(this.snapshotDir(steamId, kind), `${entryId}.json`);
    const data = readJsonFile<DeathSnapshotFile>(filePath);
    if (!data) return null;
    return toSummary(data);
  }

  private getItemsFromDir(steamId: string, entryId: string, kind: 'deaths' | 'inventory_snapshots'): DeathSnapshotItemRow[] {
    const filePath = path.join(this.snapshotDir(steamId, kind), `${entryId}.json`);
    const data = readJsonFile<DeathSnapshotFile>(filePath);
    if (!data?.RootItems) return [];
    return flattenItems(data.RootItems);
  }

  listDeaths(steamId: string, includeRestored = false): DeathSnapshotSummary[] {
    return this.listFromDir(steamId, 'deaths', includeRestored);
  }

  listInventorySnapshots(steamId: string, includeRestored = false): DeathSnapshotSummary[] {
    return this.listFromDir(steamId, 'inventory_snapshots', includeRestored);
  }

  getDeathItems(steamId: string, entryId: string): DeathSnapshotItemRow[] {
    return this.getItemsFromDir(steamId, entryId, 'deaths');
  }

  getInventorySnapshotItems(steamId: string, entryId: string): DeathSnapshotItemRow[] {
    return this.getItemsFromDir(steamId, entryId, 'inventory_snapshots');
  }

  getDeath(steamId: string, entryId: string): DeathSnapshotSummary | null {
    return this.getFromDir(steamId, entryId, 'deaths');
  }

  getInventorySnapshot(steamId: string, entryId: string): DeathSnapshotSummary | null {
    return this.getFromDir(steamId, entryId, 'inventory_snapshots');
  }

  getLiveInventory(steamId: string): PlayerInventoryResponse {
    const pendingDeletions = readPendingDeletions(this.dataRoot, steamId);

    const livePath = path.join(this.dataRoot, steamId, 'live_inventory.json');
    const liveData = readJsonFile<DeathSnapshotFile>(livePath);
    if (liveData?.RootItems) {
      return {
        source: 'live',
        steamId,
        capturedAt: liveData.DeathTimeText,
        rootItemCount:
          liveData.RootItemCount != null && liveData.RootItemCount >= 0
            ? liveData.RootItemCount
            : liveData.RootItems.length,
        items: flattenItems(liveData.RootItems),
        pendingDeletions: pendingDeletions.length > 0 ? pendingDeletions : undefined,
      };
    }

    const snapshots = this.listInventorySnapshots(steamId, true);
    if (snapshots.length > 0) {
      const latest = snapshots[0];
      return {
        source: 'snapshot',
        steamId,
        capturedAt: latest.deathTimeText,
        snapshotEntryId: latest.entryId,
        rootItemCount: latest.rootItemCount,
        items: this.getInventorySnapshotItems(steamId, latest.entryId),
        pendingDeletions: pendingDeletions.length > 0 ? pendingDeletions : undefined,
      };
    }

    return {
      source: 'none',
      steamId,
      rootItemCount: 0,
      items: [],
      pendingDeletions: pendingDeletions.length > 0 ? pendingDeletions : undefined,
    };
  }
}
