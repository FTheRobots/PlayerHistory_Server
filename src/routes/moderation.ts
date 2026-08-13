import { Router, type Request, type Response } from 'express';
import type { AuditStore } from '../services/AuditStore.js';
import type { InstanceCoordinator } from '../services/InstanceCoordinator.js';
import { resolveInstanceId } from './instances.js';
import type { WatchlistStore } from '../services/WatchlistStore.js';
import type { AlertStore } from '../services/AlertStore.js';
import type { PlayerRepository } from '../services/PlayerRepository.js';
import type { AuthService } from '../auth/AuthService.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { auditFromRequest } from '../utils/auditHelper.js';

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

export function createModerationRoutes(
  authService: AuthService,
  auditStore: AuditStore,
  coordinator: InstanceCoordinator,
  watchlistStore: WatchlistStore,
  alertStore: AlertStore,
  repo: PlayerRepository
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);

  router.use(auth);

  router.get('/audit', requirePermission(PERMISSIONS.AUDIT_VIEW), (req: Request, res: Response) => {
    try {
      const { limit, offset, action, userId, targetSteamId, from, to } = req.query;
      const result = auditStore.list({
        limit: limit ? parseInt(String(limit), 10) : undefined,
        offset: offset ? parseInt(String(offset), 10) : undefined,
        action: action ? String(action) : undefined,
        userId: userId ? parseInt(String(userId), 10) : undefined,
        targetSteamId: targetSteamId ? String(targetSteamId) : undefined,
        from: from ? String(from) : undefined,
        to: to ? String(to) : undefined,
      });
      res.json({
        data: result.data,
        total: result.total,
        limit: limit ? parseInt(String(limit), 10) : 50,
        offset: offset ? parseInt(String(offset), 10) : 0,
        actions: auditStore.listActions(),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/bans', requirePermission(PERMISSIONS.BANS_VIEW), (req: Request, res: Response) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const banService = coordinator.resolve(instanceId).banService;
      const bans = banService.listBans().map((ban) => {
        const stats = repo.getPlayerDbStats(instanceId, ban.steamId);
        return {
          ...ban,
          characterName: stats?.characterName ?? stats?.profile?.characterName,
        };
      });
      res.json(bans);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/bans', requirePermission(PERMISSIONS.BANS_MANAGE), (req: Request, res: Response) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const banService = coordinator.resolve(instanceId).banService;
      const { steamId, reason, banDurationMinutes } = req.body as {
        steamId?: string;
        reason?: string;
        banDurationMinutes?: number;
      };
      if (!steamId?.trim()) return res.status(400).json({ error: 'steamId is required' });

      const ban = banService.createBan(steamId.trim(), reason ?? '', banDurationMinutes ?? 0);
      auditFromRequest(auditStore, req, {
        action: 'ban.create',
        targetSteamId: ban.steamId,
        targetLabel: ban.steamId,
        details: { reason: ban.reason, banDurationMinutes: banDurationMinutes ?? 0 },
      });
      res.status(201).json(ban);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Ban failed' });
    }
  });

  router.delete('/bans/:steamId', requirePermission(PERMISSIONS.BANS_MANAGE), (req: Request, res: Response) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const banService = coordinator.resolve(instanceId).banService;
      const steamId = param(req.params.steamId);
      if (!banService.removeBan(steamId)) {
        return res.status(404).json({ error: 'Ban not found' });
      }
      auditFromRequest(auditStore, req, {
        action: 'ban.remove',
        targetSteamId: steamId,
        targetLabel: steamId,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/watchlist', requirePermission(PERMISSIONS.WATCHLIST_VIEW), (req: Request, res: Response) => {
    try {
      const instanceId = resolveInstanceId(req, coordinator);
      const userId = req.authUser!.id;
      const entries = watchlistStore.listForUser(userId).map((entry) => {
        const stats = repo.getPlayerDbStats(instanceId, entry.steamId);
        return {
          ...entry,
          characterName: stats?.characterName ?? stats?.profile?.characterName,
          isOnline: stats?.profile?.isOnline,
        };
      });
      res.json(entries);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/watchlist', requirePermission(PERMISSIONS.WATCHLIST_MANAGE), (req: Request, res: Response) => {
    try {
      const {
        steamId,
        scope,
        note,
        alertOnJoin,
        alertOnLeave,
        alertOnDeath,
        alertOnKill,
        alertOnBan,
      } = req.body as {
        steamId?: string;
        scope?: 'global' | 'personal';
        note?: string;
        alertOnJoin?: boolean;
        alertOnLeave?: boolean;
        alertOnDeath?: boolean;
        alertOnKill?: boolean;
        alertOnBan?: boolean;
      };

      if (!steamId?.trim()) return res.status(400).json({ error: 'steamId is required' });
      const entryScope = scope === 'personal' ? 'personal' : 'global';

      const entry = watchlistStore.create({
        steamId: steamId.trim(),
        scope: entryScope,
        userId: entryScope === 'personal' ? req.authUser!.id : null,
        note,
        alertOnJoin,
        alertOnLeave,
        alertOnDeath,
        alertOnKill,
        alertOnBan,
        createdByUserId: req.authUser!.id,
        createdByUsername: req.authUser!.username,
      });

      auditFromRequest(auditStore, req, {
        action: 'watchlist.add',
        targetSteamId: entry.steamId,
        targetLabel: entry.steamId,
        details: { scope: entry.scope, note: entry.note },
      });

      res.status(201).json(entry);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Create failed' });
    }
  });

  router.put('/watchlist/:id', requirePermission(PERMISSIONS.WATCHLIST_MANAGE), (req: Request, res: Response) => {
    try {
      const id = parseInt(param(req.params.id), 10);
      const existing = watchlistStore.findById(id);
      if (!existing) return res.status(404).json({ error: 'Entry not found' });

      if (existing.scope === 'personal' && existing.userId !== req.authUser!.id) {
        return res.status(403).json({ error: 'Cannot edit another user\'s personal watchlist entry' });
      }

      const { note, alertOnJoin, alertOnLeave, alertOnDeath, alertOnKill, alertOnBan } = req.body as {
        note?: string;
        alertOnJoin?: boolean;
        alertOnLeave?: boolean;
        alertOnDeath?: boolean;
        alertOnKill?: boolean;
        alertOnBan?: boolean;
      };

      const updated = watchlistStore.update(id, {
        note,
        alertOnJoin,
        alertOnLeave,
        alertOnDeath,
        alertOnKill,
        alertOnBan,
      });

      auditFromRequest(auditStore, req, {
        action: 'watchlist.update',
        targetSteamId: updated!.steamId,
        details: { id },
      });

      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' });
    }
  });

  router.delete('/watchlist/:id', requirePermission(PERMISSIONS.WATCHLIST_MANAGE), (req: Request, res: Response) => {
    try {
      const id = parseInt(param(req.params.id), 10);
      const existing = watchlistStore.findById(id);
      if (!existing) return res.status(404).json({ error: 'Entry not found' });

      if (existing.scope === 'personal' && existing.userId !== req.authUser!.id) {
        return res.status(403).json({ error: 'Cannot delete another user\'s personal watchlist entry' });
      }

      watchlistStore.delete(id);
      auditFromRequest(auditStore, req, {
        action: 'watchlist.remove',
        targetSteamId: existing.steamId,
        details: { id, scope: existing.scope },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Delete failed' });
    }
  });

  router.get('/alerts', requirePermission(PERMISSIONS.WATCHLIST_VIEW), (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
      const unreadOnly = req.query.unreadOnly === 'true';
      const result = alertStore.listForUser(req.authUser!.id, limit, offset, unreadOnly);
      res.json({
        ...result,
        unreadCount: alertStore.unreadCount(req.authUser!.id),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/alerts/:id/read', requirePermission(PERMISSIONS.WATCHLIST_VIEW), (req: Request, res: Response) => {
    const id = parseInt(param(req.params.id), 10);
    if (!alertStore.markRead(id, req.authUser!.id)) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    res.json({ ok: true, unreadCount: alertStore.unreadCount(req.authUser!.id) });
  });

  router.post('/alerts/read-all', requirePermission(PERMISSIONS.WATCHLIST_VIEW), (req: Request, res: Response) => {
    const count = alertStore.markAllRead(req.authUser!.id);
    res.json({ ok: true, marked: count, unreadCount: 0 });
  });

  return router;
}
