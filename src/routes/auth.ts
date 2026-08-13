import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { AuthService } from '../auth/AuthService.js';
import type { AuditStore } from '../services/AuditStore.js';
import { createAuthMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import { auditFromRequest, getClientIp } from '../utils/auditHelper.js';

export function createAuthRoutes(authService: AuthService, auditStore: AuditStore): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);
  const optionalAuth = optionalAuthMiddleware(authService);

  const loginLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, try again later' },
  });

  router.post('/login', loginLimiter, async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body as { username?: string; password?: string };
      if (!username?.trim() || !password) {
        return res.status(400).json({ error: 'username and password are required' });
      }
      const result = await authService.login(username.trim(), password);
      auditFromRequest(auditStore, req, {
        action: 'auth.login',
        targetLabel: result.user.username,
        details: { userId: result.user.id, role: result.user.role },
      });
      res.json({
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        expiresIn: result.tokens.expiresIn,
        user: result.user,
        permissions: result.permissions,
      });
    } catch (err) {
      auditStore.log({
        action: 'auth.login_failed',
        targetLabel: (req.body as { username?: string }).username?.trim() ?? null,
        ipAddress: getClientIp(req),
        details: { error: err instanceof Error ? err.message : 'Login failed' },
      });
      res.status(401).json({ error: err instanceof Error ? err.message : 'Login failed' });
    }
  });

  router.post('/refresh', (req: Request, res: Response) => {
    try {
      const { refreshToken } = req.body as { refreshToken?: string };
      if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });
      const result = authService.refresh(refreshToken);
      res.json(result);
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : 'Refresh failed' });
    }
  });

  router.post('/logout', optionalAuth, (req: Request, res: Response) => {
    const { refreshToken } = req.body as { refreshToken?: string };
    if (refreshToken) authService.logout(refreshToken);
    if (req.authUser) {
      auditFromRequest(auditStore, req, { action: 'auth.logout' });
    }
    res.json({ ok: true });
  });

  router.get('/me', auth, (req: Request, res: Response) => {
    res.json({
      user: req.authUser,
      permissions: req.permissions ? [...req.permissions] : [],
    });
  });

  return router;
}
