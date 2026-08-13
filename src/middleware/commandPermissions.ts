import type { Request, Response, NextFunction } from 'express';
import { PERMISSIONS, hasPermission, type Permission } from '../auth/permissions.js';

export interface DashboardCommandBody {
  type?: string;
  forceRestore?: boolean;
}

export function getCommandPermissions(body: DashboardCommandBody): Permission[] {
  const type = (body.type ?? '').toLowerCase();
  switch (type) {
    case 'heal':
      return [PERMISSIONS.ADMIN_HEAL];
    case 'kill':
      return [PERMISSIONS.ADMIN_KILL];
    case 'kick':
      return [PERMISSIONS.ADMIN_KICK];
    case 'ban':
      return [PERMISSIONS.ADMIN_BAN];
    case 'message':
      return [PERMISSIONS.ADMIN_MESSAGE];
    case 'teleport':
      return [PERMISSIONS.ADMIN_TELEPORT];
    case 'spawn':
      return [PERMISSIONS.ADMIN_SPAWN];
    case 'captureinventory':
      return [PERMISSIONS.ADMIN_CAPTURE_INVENTORY];
    case 'deleteitem':
      return [PERMISSIONS.ADMIN_DELETE_ITEM];
    case 'restoredeath':
      return body.forceRestore
        ? [PERMISSIONS.DEATHS_RERESTORE]
        : [PERMISSIONS.DEATHS_RESTORE];
    case 'deletedeath':
      return [PERMISSIONS.DEATHS_DELETE];
    case 'restoreinventory':
      return body.forceRestore
        ? [PERMISSIONS.INVENTORY_RERESTORE]
        : [PERMISSIONS.INVENTORY_RESTORE];
    case 'deleteinventory':
      return [PERMISSIONS.INVENTORY_DELETE];
    default:
      return [];
  }
}

export function requireCommandPermission(req: Request, res: Response, next: NextFunction): void {
  const perms = req.permissions;
  if (!perms || !req.authUser) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const required = getCommandPermissions(req.body as DashboardCommandBody);
  if (required.length === 0) {
    res.status(400).json({ error: 'Unknown or missing command type' });
    return;
  }

  for (const p of required) {
    if (!hasPermission(perms, p)) {
      res.status(403).json({ error: 'Insufficient permissions', permission: p });
      return;
    }
  }
  next();
}

export function canViewRestoredDeaths(req: Request): boolean {
  return !!req.permissions && hasPermission(req.permissions, PERMISSIONS.DEATHS_VIEW_RESTORED);
}

export function canViewRestoredInventory(req: Request): boolean {
  return !!req.permissions && hasPermission(req.permissions, PERMISSIONS.INVENTORY_VIEW_RESTORED);
}
