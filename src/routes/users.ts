import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import type { AuthService } from '../auth/AuthService.js';
import type { UserStore } from '../auth/UserStore.js';
import type { RoleStore } from '../auth/RoleStore.js';
import { ALL_PERMISSIONS, PERMISSIONS } from '../auth/permissions.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import type { AuditStore } from '../services/AuditStore.js';
import { auditFromRequest } from '../utils/auditHelper.js';

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

export function createUserRoutes(
  authService: AuthService,
  userStore: UserStore,
  roleStore: RoleStore,
  auditStore: AuditStore
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);

  router.use(auth);
  router.use(requirePermission(PERMISSIONS.USERS_MANAGE));

  router.get('/', (_req: Request, res: Response) => {
    res.json(userStore.listUsers());
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const { username, password, role, permissionGrants, permissionDenies } = req.body as {
        username?: string;
        password?: string;
        role?: string;
        permissionGrants?: string[];
        permissionDenies?: string[];
      };
      if (!username?.trim() || !password || password.length < 8) {
        return res.status(400).json({ error: 'username and password (min 8 chars) are required' });
      }
      if (!role?.trim()) {
        return res.status(400).json({ error: 'role is required' });
      }
      const roleSlug = role.trim();
      if (!roleStore.roleExists(roleSlug)) return res.status(400).json({ error: 'Invalid role' });

      const hash = await bcrypt.hash(password, 12);
      const user = userStore.createUser(username.trim(), hash, roleSlug);
      const updated = userStore.updateUser(user.id, {
        permissionGrants: permissionGrants ?? [],
        permissionDenies: permissionDenies ?? [],
      });
      auditFromRequest(auditStore, req, {
        action: 'user.create',
        targetLabel: updated!.username,
        details: { userId: updated!.id, role: updated!.role },
      });
      res.status(201).json(userStore.toPublic(updated!));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Create failed' });
    }
  });

  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(param(req.params.id), 10);
      const { password, role, permissionGrants, permissionDenies } = req.body as {
        password?: string;
        role?: string;
        permissionGrants?: string[];
        permissionDenies?: string[];
      };

      const existing = userStore.findById(id);
      if (!existing) return res.status(404).json({ error: 'User not found' });

      if (role && role !== existing.role && req.authUser?.id === id) {
        return res.status(400).json({ error: 'Cannot change your own role — ask another owner' });
      }

      if (role && role !== 'owner' && existing.role === 'owner') {
        const owners = userStore.listUsers().filter((u) => u.role === 'owner');
        if (owners.length <= 1) {
          return res.status(400).json({ error: 'Cannot demote the last owner account' });
        }
      }

      if (role && !roleStore.roleExists(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }

      if (password && password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      const passwordHash = password ? await bcrypt.hash(password, 12) : undefined;
      const updated = userStore.updateUser(id, {
        passwordHash,
        role,
        permissionGrants,
        permissionDenies,
      });
      if (password) userStore.revokeAllForUser(id);
      auditFromRequest(auditStore, req, {
        action: 'user.update',
        targetLabel: updated!.username,
        details: { userId: id, role: updated!.role },
      });
      res.json(userStore.toPublic(updated!));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const id = parseInt(param(req.params.id), 10);
    if (req.authUser?.id === id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const existing = userStore.findById(id);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (existing.role === 'owner') {
      const owners = userStore.listUsers().filter((u) => u.role === 'owner');
      if (owners.length <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last owner account' });
      }
    }
    userStore.deleteUser(id);
    auditFromRequest(auditStore, req, {
      action: 'user.delete',
      targetLabel: existing.username,
      details: { userId: id, role: existing.role },
    });
    res.json({ ok: true });
  });

  /** @deprecated use GET /api/roles/permissions */
  router.get('/permissions', (_req: Request, res: Response) => {
    res.json(ALL_PERMISSIONS);
  });

  return router;
}
