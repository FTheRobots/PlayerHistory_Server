import fs from 'fs';
import path from 'path';
import type { ServerSnapshot } from '../types/index.js';

const DEFAULT_SNAPSHOT_INTERVAL_SECONDS = 10;
const MIN_LIVE_AGE_MS = 60_000;
const MAX_LIVE_AGE_MS = 900_000;

function parseSnapshotFile(filePath: string): ServerSnapshot | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ServerSnapshot;
    return parsed?.timestamp ? parsed : null;
  } catch {
    return null;
  }
}

export function snapshotIntervalSeconds(snapshot: ServerSnapshot | null): number {
  const value = snapshot?.snapshotIntervalSeconds;
  if (typeof value === 'number' && value > 0) return value;
  return DEFAULT_SNAPSHOT_INTERVAL_SECONDS;
}

/** How long a snapshot timestamp may age before the dashboard treats the game server as offline. */
export function snapshotMaxAgeMs(intervalSeconds: number): number {
  const intervalMs = Math.max(5, intervalSeconds) * 1000;
  const scaled = intervalMs * 2.5 + 15_000;
  return Math.min(MAX_LIVE_AGE_MS, Math.max(MIN_LIVE_AGE_MS, scaled));
}

export function isSnapshotLive(snapshot: ServerSnapshot | null, intervalSeconds?: number): boolean {
  if (!snapshot?.timestamp) return false;
  const age = Date.now() - new Date(snapshot.timestamp).getTime();
  if (Number.isNaN(age) || age < 0) return false;
  const maxAge = snapshotMaxAgeMs(intervalSeconds ?? snapshotIntervalSeconds(snapshot));
  return age <= maxAge;
}

export interface SnapshotReadState {
  lastGood: ServerSnapshot | null;
  intervalSeconds: number;
}

/**
 * Read server.json without blocking the event loop.
 * Mid-write failures fall back to lastGood (watcher + awaitWriteFinish covers most races).
 */
export function readServerSnapshotResilient(
  filePath: string,
  state: SnapshotReadState
): ServerSnapshot | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const parsed = parseSnapshotFile(filePath);
    if (parsed) {
      state.lastGood = parsed;
      state.intervalSeconds = snapshotIntervalSeconds(parsed);
      return parsed;
    }
  }

  return state.lastGood;
}

/** Read serverSnapshotIntervalSeconds from mod config.json (same folder as server.json). */
export function readModSnapshotIntervalSeconds(dataRoot: string): number | undefined {
  const configPath = path.join(dataRoot, 'config.json');
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      serverSnapshotIntervalSeconds?: number;
    };
    const value = parsed.serverSnapshotIntervalSeconds;
    if (typeof value === 'number' && value > 0) return value;
  } catch {
    /* ignore corrupt mod config */
  }
  return undefined;
}
