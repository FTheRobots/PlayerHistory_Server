import { Router, type Request, type Response } from 'express';
import type { AuthService } from '../auth/AuthService.js';
import type { InstanceCoordinator } from '../services/InstanceCoordinator.js';
import type { AuditStore } from '../services/AuditStore.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requirePermission, requireAnyPermission } from '../middleware/requirePermission.js';
import { auditFromRequest } from '../utils/auditHelper.js';

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

export function createInstanceRoutes(
  coordinator: InstanceCoordinator,
  authService: AuthService,
  auditStore: AuditStore
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);

  router.get(
    '/instances',
    auth,
    requireAnyPermission(PERMISSIONS.INSTANCES_VIEW, PERMISSIONS.INSTANCES_MANAGE),
    (_req: Request, res: Response) => {
      res.json({ instances: coordinator.list(), defaultInstanceId: coordinator.getDefaultInstanceId() });
    }
  );

  router.post('/instances', auth, requirePermission(PERMISSIONS.INSTANCES_MANAGE), (req: Request, res: Response) => {
    try {
      const { name, playerHistoryPath } = req.body as { name?: string; playerHistoryPath?: string };
      if (!playerHistoryPath?.trim()) {
        return res.status(400).json({ error: 'name and playerHistoryPath are required' });
      }
      const created = coordinator.addInstance({
        name: name?.trim() || 'DayZ server',
        playerHistoryPath: playerHistoryPath.trim(),
      });
      auditFromRequest(auditStore, req, {
        action: 'instances.create',
        details: { instanceId: created.id, name: created.name, playerHistoryPath: created.playerHistoryPath },
      });
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create instance' });
    }
  });

  router.patch('/instances/:id', auth, requirePermission(PERMISSIONS.INSTANCES_MANAGE), (req: Request, res: Response) => {
    try {
      const id = param(req.params.id);
      const { name, playerHistoryPath } = req.body as { name?: string; playerHistoryPath?: string };
      const updated = coordinator.updateInstance(id, { name, playerHistoryPath });
      auditFromRequest(auditStore, req, {
        action: 'instances.update',
        details: { instanceId: updated.id, name: updated.name, playerHistoryPath: updated.playerHistoryPath },
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update instance' });
    }
  });

  router.delete('/instances/:id', auth, requirePermission(PERMISSIONS.INSTANCES_MANAGE), (req: Request, res: Response) => {
    try {
      const id = param(req.params.id);
      coordinator.removeInstance(id);
      auditFromRequest(auditStore, req, { action: 'instances.delete', details: { instanceId: id } });
      res.json({ ok: true, instanceId: id });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to delete instance' });
    }
  });

  return router;
}

export function resolveInstanceId(req: Request, coordinator: InstanceCoordinator): string {
  const raw = (req.headers['x-instance-id'] as string) || (req.query.instanceId as string);
  const id = (raw || coordinator.getDefaultInstanceId()).trim();
  if (!coordinator.has(id)) {
    throw new Error(`Unknown instanceId: ${id}`);
  }
  return id;
}
