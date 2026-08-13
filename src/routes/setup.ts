import { Router, type Request, type Response } from 'express';
import type { AuthService } from '../auth/AuthService.js';

export function createSetupRoutes(authService: AuthService): Router {
  const router = Router();

  router.get('/status', (_req: Request, res: Response) => {
    res.json({ needsSetup: !authService.hasUsers() });
  });

  router.post('/owner', async (req: Request, res: Response) => {
    try {
      if (authService.hasUsers()) {
        return res.status(403).json({ error: 'Setup already completed' });
      }
      const { username, password } = req.body as { username?: string; password?: string };
      if (!username?.trim() || !password || password.length < 8) {
        return res.status(400).json({ error: 'username and password (min 8 chars) are required' });
      }
      const user = await authService.createOwner(username.trim(), password);
      const tokens = authService.issueTokens(user);
      const permissions = [...authService.getPermissions(user)];
      res.status(201).json({
        user,
        permissions,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Setup failed' });
    }
  });

  return router;
}
