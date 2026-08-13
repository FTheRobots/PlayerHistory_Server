import { Router, type Request, type Response } from 'express';
import type { AuthService } from '../auth/AuthService.js';
import type { RoleStore } from '../auth/RoleStore.js';
import { slugifyRoleName } from '../auth/RoleStore.js';
import { ALL_PERMISSIONS, PERMISSION_GROUPS, PERMISSIONS } from '../auth/permissions.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import type { AuditStore } from '../services/AuditStore.js';
import { auditFromRequest } from '../utils/auditHelper.js';

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

export function createRoleRoutes(authService: AuthService, roleStore: RoleStore, auditStore: AuditStore): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);

  router.use(auth);
  router.use(requirePermission(PERMISSIONS.USERS_MANAGE));

  router.get('/', (_req: Request, res: Response) => {
    res.json(roleStore.listRoles());
  });

  router.get('/permissions', (_req: Request, res: Response) => {
    res.json({ permissions: ALL_PERMISSIONS, groups: PERMISSION_GROUPS });
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const { name, slug, permissions } = req.body as {
        name?: string;
        slug?: string;
        permissions?: string[];
      };
      if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

      const roleSlug = (slug?.trim() || slugifyRoleName(name)).toLowerCase();
      const role = roleStore.createRole(name, roleSlug, permissions ?? []);
      auditFromRequest(auditStore, req, {
        action: 'role.create',
        targetLabel: role.slug,
        details: { roleId: role.id, permissions: role.permissions },
      });
      res.status(201).json(roleStore.toPublic(role));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Create failed' });
    }
  });

  router.put('/:id', (req: Request, res: Response) => {
    try {
      const id = parseInt(param(req.params.id), 10);
      const { name, permissions } = req.body as { name?: string; permissions?: string[] };

      const updated = roleStore.updateRole(id, { name, permissions });
      if (!updated) return res.status(404).json({ error: 'Role not found' });
      auditFromRequest(auditStore, req, {
        action: 'role.update',
        targetLabel: updated.slug,
        details: { roleId: id, permissions: updated.permissions },
      });
      res.json(roleStore.toPublic(updated));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    try {
      const id = parseInt(param(req.params.id), 10);
      const existing = roleStore.findById(id);
      if (!existing) return res.status(404).json({ error: 'Role not found' });
      if (!roleStore.deleteRole(id)) return res.status(404).json({ error: 'Role not found' });
      auditFromRequest(auditStore, req, {
        action: 'role.delete',
        targetLabel: existing.slug,
        details: { roleId: id },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Delete failed' });
    }
  });

  return router;
}
