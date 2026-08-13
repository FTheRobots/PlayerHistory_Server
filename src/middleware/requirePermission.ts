import type { Request, Response, NextFunction } from 'express';
import type { Permission } from '../auth/permissions.js';
import { hasPermission } from '../auth/permissions.js';

export function requirePermission(...required: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const perms = req.permissions;
    if (!perms || !req.authUser) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    for (const p of required) {
      if (!hasPermission(perms, p)) {
        res.status(403).json({ error: 'Insufficient permissions', permission: p });
        return;
      }
    }
    next();
  };
}

export function requireAnyPermission(...required: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const perms = req.permissions;
    if (!perms || !req.authUser) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!required.some((p) => hasPermission(perms, p))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
