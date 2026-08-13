import { Router } from 'express';
import type { PlayerRepository } from '../services/PlayerRepository.js';
import type { ItemRepository } from '../services/ItemRepository.js';
import type { InstanceCoordinator } from '../services/InstanceCoordinator.js';
import { resolveInstanceId } from './instances.js';
import type { AuthService } from '../auth/AuthService.js';
import type { DashboardCommandRequest } from '../types/index.js';
import { MAX_COMPARE_PLAYERS } from '../types/index.js';
import type { AuditStore } from '../services/AuditStore.js';
import { PERMISSIONS, hasPermission } from '../auth/permissions.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { auditFromRequest } from '../utils/auditHelper.js';
import {
  canViewRestoredDeaths,
  canViewRestoredInventory,
  requireCommandPermission,
} from '../middleware/commandPermissions.js';
import type { ServerPublicInfo } from './publicHealth.js';
import { getServerVersionInfo } from '../appVersion.js';

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

export type { ServerPublicInfo } from './publicHealth.js';

export function createRoutes(
  coordinator: InstanceCoordinator,
  repo: PlayerRepository,
  itemRepo: ItemRepository,
  authService: AuthService,
  auditStore: AuditStore,
  serverInfo: ServerPublicInfo
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);

  router.get('/', (_req, res) => {
    const versionInfo = getServerVersionInfo();
    res.json({
      name: serverInfo.serverName,
      status: 'ok',
      ...versionInfo,
      endpoints: {
        health: 'GET /api/health',
        auth: 'POST /api/auth/login',
        dashboard: 'GET /api/dashboard',
        websocket: 'WSS /api/ws?token=...',
      },
    });
  });

  router.use(auth);

  router.get('/dashboard', requirePermission(PERMISSIONS.DASHBOARD_VIEW), async (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const runtime = coordinator.resolve(instanceId);
      const includeCftools = hasPermission(req.permissions!, PERMISSIONS.CFTOOLS_VIEW);
      res.json(await runtime.dashboard.getDashboard({ includeCftools }));
    } catch (err) {
      res.status(err instanceof Error && err.message.startsWith('Unknown instanceId') ? 400 : 500).json({
        error: String(err),
      });
    }
  });

  router.post(
    '/dashboard/commands',
    requirePermission(PERMISSIONS.DASHBOARD_VIEW),
    requireCommandPermission,
    (req, res) => {
      try {
        const body = req.body as DashboardCommandRequest;
        if (!body?.type || !body?.steamId) {
          return res.status(400).json({ error: 'type and steamId are required' });
        }
        const allowed = new Set([
          'heal',
          'kill',
          'teleport',
          'spawn',
          'restoredeath',
          'deletedeath',
          'restoreinventory',
          'deleteinventory',
          'captureinventory',
          'deleteitem',
          'kick',
          'ban',
          'message',
        ]);
        if (!allowed.has(body.type)) {
          return res.status(400).json({ error: 'Invalid command type' });
        }
        if (body.type === 'spawn' && !body.classname) {
          return res.status(400).json({ error: 'classname is required for spawn' });
        }
        if (body.type === 'deleteitem' && !body.itemPid?.trim()) {
          return res.status(400).json({ error: 'itemPid is required for deleteitem' });
        }
        if (body.type === 'teleport' && (body.x == null || body.z == null)) {
          return res.status(400).json({ error: 'x and z are required for teleport' });
        }
        if (
          (body.type === 'restoredeath' ||
            body.type === 'deletedeath' ||
            body.type === 'restoreinventory' ||
            body.type === 'deleteinventory') &&
          !body.deathEntryId
        ) {
          return res.status(400).json({ error: 'deathEntryId is required for snapshot commands' });
        }
        if (body.type === 'message' && !body.message?.trim()) {
          return res.status(400).json({ error: 'message is required for message command' });
        }
        const instanceId = resolveInstanceId(req, coordinator);
        const runtime = coordinator.resolve(instanceId);
        const command = runtime.dashboard.enqueueCommand(body);
        auditFromRequest(auditStore, req, {
          action: `command.${body.type}`,
          targetSteamId: body.steamId,
          details: {
            commandId: command.id,
            type: body.type,
            message: body.message,
            banDurationMinutes: body.banDurationMinutes,
            classname: body.classname,
            deathEntryId: body.deathEntryId,
            itemPid: body.itemPid,
          },
        });
        res.json({ ok: true, command });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    }
  );

  router.post('/index', requirePermission(PERMISSIONS.SERVER_REINDEX), async (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const result = await coordinator.resolve(instanceId).indexer.indexAll();
      auditFromRequest(auditStore, req, { action: 'server.reindex', details: result as unknown as Record<string, unknown> });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/clear', requirePermission(PERMISSIONS.SERVER_CLEAR_INDEX), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const result = coordinator.resolve(instanceId).indexer.clearIndex();
      auditFromRequest(auditStore, req, { action: 'server.clear_index', details: result as unknown as Record<string, unknown> });
      res.json({ ...result, message: 'Index cleared. POST /api/index to re-import from log files.' });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/players', requirePermission(PERMISSIONS.PLAYERS_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const search = req.query.search as string | undefined;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      res.json(repo.listPlayers(instanceId, search, limit, offset));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/player/:steamid', requirePermission(PERMISSIONS.PLAYERS_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const steamId = param(req.params.steamid);
      const player = repo.getPlayer(instanceId, steamId);
      if (!player) return res.status(404).json({ error: 'Player not found' });
      res.json(player);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.delete(
    '/player/:steamid',
    requirePermission(PERMISSIONS.PLAYERS_DELETE_DATA),
    (req, res) => {
      try {
        const instanceId = resolveInstanceId(req, coordinator);
        const steamId = param(req.params.steamid);
        const deleteFiles = req.query.deleteFiles === 'true';
        const result = coordinator.resolve(instanceId).indexer.deletePlayer(steamId, deleteFiles);
        if (result.eventsDeleted === 0 && result.playerDeleted === 0 && !result.logFilesDeleted) {
          return res.status(404).json({ error: 'Player not found' });
        }
        auditFromRequest(auditStore, req, {
          action: 'player.delete_data',
          targetSteamId: steamId,
          details: { deleteFiles, ...result },
        });
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    }
  );

  router.get('/timeline', requirePermission(PERMISSIONS.TIMELINE_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const raw = req.query.steamids as string | undefined;
      if (!raw?.trim()) {
        res.status(400).json({ error: 'steamids query parameter required' });
        return;
      }
      const steamids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
      if (steamids.length < 2) {
        res.status(400).json({ error: 'At least 2 steamids required for compare' });
        return;
      }
      if (steamids.length > MAX_COMPARE_PLAYERS) {
        res.status(400).json({ error: `Maximum ${MAX_COMPARE_PLAYERS} players allowed` });
        return;
      }
      const result = repo.getMultiTimeline(instanceId, {
        steamids,
        event: req.query.event as string | undefined,
        category: req.query.category as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        search: req.query.search as string | undefined,
        limit: parseInt(req.query.limit as string) || 100,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/timeline/:steamid', requirePermission(PERMISSIONS.TIMELINE_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const steamId = param(req.params.steamid);
      const result = repo.getTimeline(instanceId, {
        steamid: steamId,
        event: req.query.event as string | undefined,
        category: req.query.category as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        search: req.query.search as string | undefined,
        limit: parseInt(req.query.limit as string) || 100,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/statistics/:steamid', requirePermission(PERMISSIONS.TIMELINE_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      res.json(repo.getStatistics(instanceId, param(req.params.steamid)));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/vehicles/:steamid', requirePermission(PERMISSIONS.TIMELINE_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const limit = parseInt(req.query.limit as string) || 100;
      res.json(repo.getVehicleHistory(instanceId, param(req.params.steamid), limit));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/inventory/:steamid', requirePermission(PERMISSIONS.TIMELINE_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      res.json(repo.getInventoryEvents(instanceId, param(req.params.steamid), limit, offset));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/player/:steamid/deaths', requirePermission(PERMISSIONS.DEATHS_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const runtime = coordinator.resolve(instanceId);
      const includeRestored =
        req.query.includeRestored === 'true' && canViewRestoredDeaths(req);
      res.json(runtime.deaths.listDeaths(param(req.params.steamid), includeRestored));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get(
    '/player/:steamid/deaths/:entryId/items',
    requirePermission(PERMISSIONS.DEATHS_VIEW),
    (req, res) => {
      try {
        const runtime = coordinator.resolve(resolveInstanceId(req, coordinator));
        const items = runtime.deaths.getDeathItems(param(req.params.steamid), param(req.params.entryId));
        if (items.length === 0 && !runtime.deaths.getDeath(param(req.params.steamid), param(req.params.entryId))) {
          return res.status(404).json({ error: 'Death snapshot not found' });
        }
        res.json(items);
      } catch (err) {
        res.status(400).json({ error: String(err) });
      }
    }
  );

  router.get(
    '/player/:steamid/inventory-snapshots',
    requirePermission(PERMISSIONS.INVENTORY_VIEW),
    (req, res) => {
      try {
        const runtime = coordinator.resolve(resolveInstanceId(req, coordinator));
        const includeRestored =
          req.query.includeRestored === 'true' && canViewRestoredInventory(req);
        res.json(runtime.deaths.listInventorySnapshots(param(req.params.steamid), includeRestored));
      } catch (err) {
        res.status(400).json({ error: String(err) });
      }
    }
  );

  router.get(
    '/player/:steamid/inventory-snapshots/:entryId/items',
    requirePermission(PERMISSIONS.INVENTORY_VIEW),
    (req, res) => {
      try {
        const runtime = coordinator.resolve(resolveInstanceId(req, coordinator));
        const items = runtime.deaths.getInventorySnapshotItems(param(req.params.steamid), param(req.params.entryId));
        if (
          items.length === 0 &&
          !runtime.deaths.getInventorySnapshot(param(req.params.steamid), param(req.params.entryId))
        ) {
          return res.status(404).json({ error: 'Inventory snapshot not found' });
        }
        res.json(items);
      } catch (err) {
        res.status(400).json({ error: String(err) });
      }
    }
  );

  router.get(
    '/player/:steamid/inventory/live',
    requirePermission(PERMISSIONS.INVENTORY_VIEW),
    (req, res) => {
      try {
        const runtime = coordinator.resolve(resolveInstanceId(req, coordinator));
        res.json(runtime.deaths.getLiveInventory(param(req.params.steamid)));
      } catch (err) {
        res.status(400).json({ error: String(err) });
      }
    }
  );

  router.get('/kills/:steamid', requirePermission(PERMISSIONS.TIMELINE_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const limit = parseInt(req.query.limit as string) || 50;
      res.json(repo.getKillFeed(instanceId, param(req.params.steamid), limit));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/positions/:steamid', requirePermission(PERMISSIONS.MAP_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;
      const limit = parseInt(req.query.limit as string) || 1000;
      res.json(repo.getPositionHistory(instanceId, param(req.params.steamid), from, to, limit));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/map/heatmap', requirePermission(PERMISSIONS.MAP_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const mode = (req.query.mode as string) || 'all';
      if (mode !== 'all' && mode !== 'deaths' && mode !== 'combat' && mode !== 'activity') {
        return res.status(400).json({ error: 'mode must be all, deaths, combat, or activity' });
      }
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 25000, 25000);
      const result = repo.getHeatmapPoints(instanceId, mode, from, to, limit);
      res.json({
        ...result,
        mode,
        from,
        to,
      });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/chat', requirePermission(PERMISSIONS.CHAT_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const tab = req.query.tab as string | undefined;
      const since = req.query.since as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      const allowed = new Set(['global', 'team', 'admin', 'transport', 'all']);
      if (tab && !allowed.has(tab)) {
        return res.status(400).json({ error: 'tab must be all, global, team, admin, or transport' });
      }
      const filterTab = !tab || tab === 'all' ? undefined : tab;
      res.json(repo.listChatMessages(instanceId, { tab: filterTab, since, limit }));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/map/config', requirePermission(PERMISSIONS.MAP_VIEW), (req, res) => {
    try {
      const runtime = coordinator.resolve(resolveInstanceId(req, coordinator));
      res.json(runtime.dashboard.getMapConfig());
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/map/:steamid', requirePermission(PERMISSIONS.MAP_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 8000, 20000);
      const slim = req.query.slim === '1' || req.query.slim === 'true';
      res.json(repo.getMapEvents(instanceId, param(req.params.steamid), from, to, limit, slim));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/events/types', requirePermission(PERMISSIONS.TIMELINE_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const steamid = req.query.steamid as string | undefined;
      const rawIds = req.query.steamids as string | undefined;
      const steamids = rawIds
        ? [...new Set(rawIds.split(',').map((s) => s.trim()).filter(Boolean))]
        : undefined;
      res.json(repo.getEventTypes(instanceId, steamid, steamids));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/events/categories', requirePermission(PERMISSIONS.TIMELINE_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const steamid = req.query.steamid as string | undefined;
      const rawIds = req.query.steamids as string | undefined;
      const steamids = rawIds
        ? [...new Set(rawIds.split(',').map((s) => s.trim()).filter(Boolean))]
        : undefined;
      res.json(repo.getCategories(instanceId, steamid, steamids));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/items/search', requirePermission(PERMISSIONS.ITEMS_SEARCH), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const search = req.query.q as string | undefined;
      const steamid = req.query.steamid as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
      res.json(itemRepo.searchItems(instanceId, search, steamid, limit));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/items/at-container', requirePermission(PERMISSIONS.ITEMS_SEARCH), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const x = parseFloat(req.query.x as string);
      const z = parseFloat(req.query.z as string);
      if (Number.isNaN(x) || Number.isNaN(z)) {
        return res.status(400).json({ error: 'x and z query parameters are required numbers' });
      }

      const radiusRaw = req.query.radius as string | undefined;
      const radius = radiusRaw != null ? parseFloat(radiusRaw) : 0.5;
      if (Number.isNaN(radius) || radius <= 0) {
        return res.status(400).json({ error: 'radius must be a positive number' });
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      const offset = parseInt(req.query.offset as string) || 0;

      res.json(
        itemRepo.getEventsAtContainer(instanceId, {
          x,
          z,
          radius,
          containerPid: req.query.containerPid as string | undefined,
          from: req.query.from as string | undefined,
          to: req.query.to as string | undefined,
          limit,
          offset,
        })
      );
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/items/player/:steamid', requirePermission(PERMISSIONS.ITEMS_SEARCH), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const limit = parseInt(req.query.limit as string) || 50;
      res.json(itemRepo.listPlayerItems(instanceId, param(req.params.steamid), limit));
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/item/:pid', requirePermission(PERMISSIONS.ITEMS_SEARCH), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const summary = itemRepo.getItemSummary(instanceId, param(req.params.pid));
      if (!summary) return res.status(404).json({ error: 'Item not found' });
      res.json(summary);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/item/:pid/timeline', requirePermission(PERMISSIONS.ITEMS_SEARCH), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
      const offset = parseInt(req.query.offset as string) || 0;
      const result = itemRepo.getItemTimeline(instanceId, param(req.params.pid), limit, offset);
      if (result.total === 0 && result.data.length === 0) return res.status(404).json({ error: 'Item not found' });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/export/:steamid', requirePermission(PERMISSIONS.TIMELINE_VIEW), (req, res) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const format = (req.query.format as string) || 'json';
      const result = repo.getTimeline(instanceId, {
        steamid: param(req.params.steamid),
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        limit: parseInt(req.query.limit as string) || 100000,
        offset: 0,
      });

    if (format === 'csv') {
      const header = 'timestamp,steamid,event,category,position_x,position_y,position_z,metadata\n';
      const rows = result.data
        .map(
          (e) =>
            `${e.timestamp},${e.steamid},${e.event},${e.category ?? ''},${e.position?.[0] ?? ''},${e.position?.[1] ?? ''},${e.position?.[2] ?? ''},"${JSON.stringify(e.metadata ?? {}).replace(/"/g, '""')}"`
        )
        .join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${param(req.params.steamid)}-timeline.csv"`);
      return res.send(header + rows);
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${param(req.params.steamid)}-timeline.json"`);
    res.json(result.data);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  return router;
}
