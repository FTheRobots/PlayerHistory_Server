import { Router } from 'express';
import type { InstanceCoordinator } from '../services/InstanceCoordinator.js';
import type { QueryService } from '../services/QueryService.js';
import type { SavedQueryStore } from '../services/SavedQueryStore.js';
import type { AuthService } from '../auth/AuthService.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { resolveInstanceId } from './instances.js';
import { getQueryFieldCatalog, getQueryPresets } from '../query/queryFields.js';
import type { EventQueryRequest } from '../types/query.js';

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

export function createQueryRoutes(
  coordinator: InstanceCoordinator,
  queryService: QueryService,
  savedQueryStore: SavedQueryStore,
  authService: AuthService
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);

  router.get('/query/fields', auth, requirePermission(PERMISSIONS.QUERY_VIEW), (_req, res) => {
    res.json({ fields: getQueryFieldCatalog(), presets: getQueryPresets() });
  });

  router.post('/query', auth, requirePermission(PERMISSIONS.QUERY_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const body = req.body as EventQueryRequest;
      const err = queryService.validateRequest(body);
      if (err) {
        res.status(400).json({ error: err });
        return;
      }
      res.json(queryService.execute(instanceId, body));
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.post('/query/export', auth, requirePermission(PERMISSIONS.QUERY_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const body = req.body as EventQueryRequest;
      const csv = queryService.exportCsv(instanceId, body);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="query-export.csv"');
      res.send(csv);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.get('/query/saved', auth, requirePermission(PERMISSIONS.QUERY_MANAGE), (req, res) => {
    const instanceId = resolveInstanceId(req, coordinator);
    const userId = req.authUser!.id;
    res.json({ queries: savedQueryStore.list(userId, instanceId) });
  });

  router.post('/query/saved', auth, requirePermission(PERMISSIONS.QUERY_MANAGE), (req, res) => {
    const instanceId = resolveInstanceId(req, coordinator);
    const userId = req.authUser!.id;
    const { name, description, query, isWatch } = req.body as {
      name: string;
      description?: string;
      query: EventQueryRequest;
      isWatch?: boolean;
    };
    if (!name?.trim() || !query) {
      res.status(400).json({ error: 'name and query required' });
      return;
    }
    const saved = savedQueryStore.create(userId, instanceId, name.trim(), query, description, isWatch ?? false);
    res.status(201).json(saved);
  });

  router.put('/query/saved/:id', auth, requirePermission(PERMISSIONS.QUERY_MANAGE), (req, res) => {
    const userId = req.authUser!.id;
    const id = parseInt(param(req.params.id), 10);
    const updated = savedQueryStore.update(userId, id, req.body);
    if (!updated) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(updated);
  });

  router.delete('/query/saved/:id', auth, requirePermission(PERMISSIONS.QUERY_MANAGE), (req, res) => {
    const userId = req.authUser!.id;
    const id = parseInt(param(req.params.id), 10);
    if (!savedQueryStore.delete(userId, id)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.get('/query/watch-alerts', auth, requirePermission(PERMISSIONS.QUERY_MANAGE), (req, res) => {
    const userId = req.authUser!.id;
    const unreadOnly = req.query.unread === 'true';
    res.json({ alerts: savedQueryStore.listWatchAlerts(userId, unreadOnly) });
  });

  router.post('/query/watch-alerts/:id/read', auth, requirePermission(PERMISSIONS.QUERY_MANAGE), (req, res) => {
    savedQueryStore.markAlertRead(req.authUser!.id, parseInt(param(req.params.id), 10));
    res.json({ ok: true });
  });

  router.post('/query/watch-alerts/read-all', auth, requirePermission(PERMISSIONS.QUERY_MANAGE), (req, res) => {
    savedQueryStore.markAllAlertsRead(req.authUser!.id);
    res.json({ ok: true });
  });

  return router;
}
