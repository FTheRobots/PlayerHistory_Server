import { Router, type Request, type Response } from 'express';
import type { AuthService } from '../auth/AuthService.js';
import type { AuditStore } from '../services/AuditStore.js';
import type { CFToolsStore } from '../services/CFToolsStore.js';
import type { CFToolsService } from '../services/CFToolsService.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { auditFromRequest } from '../utils/auditHelper.js';

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

export function createIntegrationsRoutes(
  authService: AuthService,
  auditStore: AuditStore,
  cftoolsStore: CFToolsStore,
  cftoolsService: CFToolsService
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);

  router.use(auth);

  router.get('/integrations/cftools/status', requirePermission(PERMISSIONS.CFTOOLS_VIEW), (_req, res) => {
    res.json(cftoolsService.getStatus());
  });

  router.get('/integrations/cftools/config', requirePermission(PERMISSIONS.CFTOOLS_MANAGE), (_req, res) => {
    res.json(cftoolsStore.getPublicConfig());
  });

  router.put('/integrations/cftools/config', requirePermission(PERMISSIONS.CFTOOLS_MANAGE), (req, res) => {
    try {
      const body = req.body as {
        enabled?: boolean;
        applicationId?: string;
        applicationSecret?: string;
        serverApiId?: string;
        banlistId?: string;
      };

      const saved = cftoolsStore.saveConfig({
        enabled: Boolean(body.enabled),
        applicationId: body.applicationId ?? '',
        applicationSecret: body.applicationSecret,
        serverApiId: body.serverApiId ?? '',
        banlistId: body.banlistId ?? '',
      });

      cftoolsService.invalidateCaches();

      auditFromRequest(auditStore, req, {
        action: 'cftools.config.update',
        details: { enabled: saved.enabled, applicationId: saved.applicationId },
      });

      res.json(saved);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/integrations/cftools/test', requirePermission(PERMISSIONS.CFTOOLS_MANAGE), async (_req, res) => {
    try {
      const result = await cftoolsService.testConnection();
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get(
    '/integrations/cftools/player/:steamId',
    requirePermission(PERMISSIONS.CFTOOLS_VIEW),
    async (req: Request, res: Response) => {
      try {
        const steamId = param(req.params.steamId);
        const profile = await cftoolsService.getPlayerProfile(steamId);
        res.json(profile);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    }
  );

  return router;
}
