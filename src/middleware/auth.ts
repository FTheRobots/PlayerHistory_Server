import type { Request, Response, NextFunction } from 'express';
import type { AuthService, AuthUser } from '../auth/AuthService.js';
import type { Permission } from '../auth/permissions.js';

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      permissions?: Set<Permission>;
    }
  }
}

export function createAuthMiddleware(authService: AuthService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const token = header.slice(7);
    try {
      const user = authService.verifyAccessToken(token);
      req.authUser = user;
      req.permissions = authService.getPermissions(user);
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

export function optionalAuthMiddleware(authService: AuthService) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      next();
      return;
    }
    try {
      const user = authService.verifyAccessToken(header.slice(7));
      req.authUser = user;
      req.permissions = authService.getPermissions(user);
    } catch {
      // ignore invalid token for optional auth
    }
    next();
  };
}
