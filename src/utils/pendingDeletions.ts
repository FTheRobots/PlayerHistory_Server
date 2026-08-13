import fs from 'fs';
import path from 'path';

export interface PendingDeletionEntry {
  itemPid: string;
  queuedAt: string;
}

interface PendingDeletionsFile {
  deletions?: PendingDeletionEntry[];
}

function pendingDeletionsPath(dataRoot: string, steamId: string): string {
  return path.join(dataRoot, steamId, 'pending_deletions.json');
}

function readFile(dataRoot: string, steamId: string): PendingDeletionsFile {
  const filePath = pendingDeletionsPath(dataRoot, steamId);
  if (!fs.existsSync(filePath)) return { deletions: [] };

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PendingDeletionsFile;
    return { deletions: data.deletions ?? [] };
  } catch {
    return { deletions: [] };
  }
}

function writeFile(dataRoot: string, steamId: string, file: PendingDeletionsFile): void {
  const playerDir = path.join(dataRoot, steamId);
  if (!fs.existsSync(playerDir)) {
    fs.mkdirSync(playerDir, { recursive: true });
  }

  const filePath = pendingDeletionsPath(dataRoot, steamId);
  const deletions = file.deletions ?? [];

  if (deletions.length === 0) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }

  fs.writeFileSync(filePath, JSON.stringify({ deletions }, null, 2), 'utf8');
}

export function readPendingDeletions(dataRoot: string, steamId: string): PendingDeletionEntry[] {
  return readFile(dataRoot, steamId).deletions ?? [];
}

export function queuePendingDeletion(
  dataRoot: string,
  steamId: string,
  itemPid: string
): PendingDeletionEntry[] {
  const trimmedPid = itemPid.trim();
  if (!trimmedPid) return readPendingDeletions(dataRoot, steamId);

  const file = readFile(dataRoot, steamId);
  const deletions = file.deletions ?? [];

  if (!deletions.some((entry) => entry.itemPid === trimmedPid)) {
    deletions.push({ itemPid: trimmedPid, queuedAt: new Date().toISOString() });
  }

  writeFile(dataRoot, steamId, { deletions });
  return deletions;
}

export function isPlayerOnline(dataRoot: string, steamId: string): boolean {
  const snapshotPath = path.join(dataRoot, 'server.json');
  if (!fs.existsSync(snapshotPath)) return false;

  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
      onlinePlayers?: { steamId?: string }[];
      timestamp?: string;
    };

    if (!snapshot.timestamp) return false;
    const age = Date.now() - new Date(snapshot.timestamp).getTime();
    if (Number.isNaN(age) || age < 0 || age > 45_000) return false;

    return (snapshot.onlinePlayers ?? []).some((player) => player.steamId === steamId);
  } catch {
    return false;
  }
}
