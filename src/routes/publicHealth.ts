import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import type { AuthService } from '../auth/AuthService.js';
import type { InstanceCoordinator } from '../services/InstanceCoordinator.js';
import { getServerVersionInfo } from '../appVersion.js';

export interface ServerPublicInfo {
  publicBaseUrl: string;
  websocketPath: string;
  serverName: string;
}

/** Public connectivity check — must stay unauthenticated (client connect flow). */
export function createHealthHandler(
  coordinator: InstanceCoordinator,
  authService: AuthService,
  serverInfo: ServerPublicInfo
) {
  return (_req: Request, res: Response): void => {
    const dataRoot = coordinator.resolve().dataRoot;
    const serverJsonPath = path.join(dataRoot, 'server.json');
    let serverJsonAgeMs: number | null = null;
    if (fs.existsSync(serverJsonPath)) {
      serverJsonAgeMs = Date.now() - fs.statSync(serverJsonPath).mtimeMs;
    }
    const base = serverInfo.publicBaseUrl.replace(/\/$/, '');
    const versionInfo = getServerVersionInfo();
    res.json({
      status: 'ok',
      name: serverInfo.serverName,
      ...versionInfo,
      timestamp: new Date().toISOString(),
      serverJsonAgeMs,
      needsAuth: authService.hasUsers(),
      publicBaseUrl: base,
      apiBaseUrl: `${base}/api`,
      websocketUrl: `${base.replace(/^http/, 'ws')}${serverInfo.websocketPath}`,
    });
  };
}
