import fs from 'fs';
import path from 'path';
import pkg from '../package.json';
import { getAppRoot } from './appRoot.js';

/** Bump when the REST/WebSocket contract changes incompatibly. */
export const API_VERSION = 1;

/**
 * Minimum admin client semver required for full compatibility.
 * Raise when the server depends on new client behavior or headers.
 */
export const MIN_CLIENT_VERSION = '2.1.0';

export const APP_CODENAME = 'Nimble Jackal';

function readVersionFile(): { version: string; codename?: string } | null {
  const candidates = [
    path.join(getAppRoot(), 'VERSION'),
    path.resolve(__dirname, '..', 'VERSION'),
    path.resolve(__dirname, '..', '..', 'VERSION'),
  ];

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const lines = fs
        .readFileSync(filePath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const version = lines[0];
      if (!version) continue;
      const codename = lines[1] || undefined;
      return { version, codename };
    } catch {
      // try next candidate
    }
  }
  return null;
}

const fromFile = readVersionFile();

/** Product semver — canonical `VERSION` file beside the server, else package.json. */
export const APP_VERSION = fromFile?.version ?? pkg.version;

/** Friendly release name (e.g. Nimble Jackal). */
export const RELEASE_CODENAME = fromFile?.codename ?? APP_CODENAME;

export interface ServerVersionInfo {
  version: string;
  codename?: string;
  apiVersion: number;
  minClientVersion: string;
}

export function getServerVersionInfo(): ServerVersionInfo {
  return {
    version: APP_VERSION,
    codename: RELEASE_CODENAME,
    apiVersion: API_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
  };
}
