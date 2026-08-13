export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard.view',
  PLAYERS_VIEW: 'players.view',
  TIMELINE_VIEW: 'timeline.view',
  MAP_VIEW: 'map.view',
  CHAT_VIEW: 'chat.view',
  ITEMS_SEARCH: 'items.search',
  DEATHS_VIEW: 'deaths.view',
  DEATHS_VIEW_RESTORED: 'deaths.view_restored',
  DEATHS_RESTORE: 'deaths.restore',
  DEATHS_RERESTORE: 'deaths.rerestore',
  DEATHS_DELETE: 'deaths.delete',
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_VIEW_RESTORED: 'inventory.view_restored',
  INVENTORY_RESTORE: 'inventory.restore',
  INVENTORY_RERESTORE: 'inventory.rerestore',
  INVENTORY_DELETE: 'inventory.delete',
  ADMIN_HEAL: 'admin.heal',
  ADMIN_KILL: 'admin.kill',
  ADMIN_KICK: 'admin.kick',
  ADMIN_BAN: 'admin.ban',
  ADMIN_MESSAGE: 'admin.message',
  ADMIN_TELEPORT: 'admin.teleport',
  ADMIN_SPAWN: 'admin.spawn',
  ADMIN_DELETE_ITEM: 'admin.delete_item',
  ADMIN_CAPTURE_INVENTORY: 'admin.capture_inventory',
  SERVER_REINDEX: 'server.reindex',
  SERVER_CLEAR_INDEX: 'server.clear_index',
  INSTANCES_VIEW: 'instances.view',
  INSTANCES_MANAGE: 'instances.manage',
  PLAYERS_DELETE_DATA: 'players.delete_data',
  USERS_MANAGE: 'users.manage',
  AUDIT_VIEW: 'audit.view',
  BANS_VIEW: 'bans.view',
  BANS_MANAGE: 'bans.manage',
  WATCHLIST_VIEW: 'watchlist.view',
  WATCHLIST_MANAGE: 'watchlist.manage',
  CFTOOLS_VIEW: 'cftools.view',
  CFTOOLS_MANAGE: 'cftools.manage',
  QUERY_VIEW: 'query.view',
  QUERY_MANAGE: 'query.manage',
  ANALYTICS_VIEW: 'analytics.view',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/** Default role templates seeded into the database on first run. */
export const DEFAULT_ROLE_TEMPLATES: Array<{ name: string; slug: string; permissions: Permission[] }> = [
  {
    name: 'Owner',
    slug: 'owner',
    permissions: [...ALL_PERMISSIONS],
  },
];

export const PERMISSION_GROUPS: Array<{ label: string; permissions: Permission[] }> = [
  {
    label: 'View',
    permissions: [
      PERMISSIONS.DASHBOARD_VIEW,
      PERMISSIONS.PLAYERS_VIEW,
      PERMISSIONS.TIMELINE_VIEW,
      PERMISSIONS.MAP_VIEW,
      PERMISSIONS.CHAT_VIEW,
      PERMISSIONS.ITEMS_SEARCH,
      PERMISSIONS.QUERY_VIEW,
      PERMISSIONS.ANALYTICS_VIEW,
    ],
  },
  {
    label: 'Search & analytics',
    permissions: [PERMISSIONS.QUERY_MANAGE],
  },
  {
    label: 'Deaths & gear',
    permissions: [
      PERMISSIONS.DEATHS_VIEW,
      PERMISSIONS.DEATHS_VIEW_RESTORED,
      PERMISSIONS.DEATHS_RESTORE,
      PERMISSIONS.DEATHS_RERESTORE,
      PERMISSIONS.DEATHS_DELETE,
      PERMISSIONS.INVENTORY_VIEW,
      PERMISSIONS.INVENTORY_VIEW_RESTORED,
      PERMISSIONS.INVENTORY_RESTORE,
      PERMISSIONS.INVENTORY_RERESTORE,
      PERMISSIONS.INVENTORY_DELETE,
    ],
  },
  {
    label: 'Admin actions',
    permissions: [
      PERMISSIONS.ADMIN_HEAL,
      PERMISSIONS.ADMIN_KILL,
      PERMISSIONS.ADMIN_KICK,
      PERMISSIONS.ADMIN_BAN,
      PERMISSIONS.ADMIN_MESSAGE,
      PERMISSIONS.ADMIN_TELEPORT,
      PERMISSIONS.ADMIN_SPAWN,
      PERMISSIONS.ADMIN_DELETE_ITEM,
      PERMISSIONS.ADMIN_CAPTURE_INVENTORY,
    ],
  },
  {
    label: 'Server',
    permissions: [
      PERMISSIONS.SERVER_REINDEX,
      PERMISSIONS.SERVER_CLEAR_INDEX,
      PERMISSIONS.INSTANCES_VIEW,
      PERMISSIONS.INSTANCES_MANAGE,
      PERMISSIONS.PLAYERS_DELETE_DATA,
      PERMISSIONS.USERS_MANAGE,
    ],
  },
  {
    label: 'Moderation & audit',
    permissions: [
      PERMISSIONS.AUDIT_VIEW,
      PERMISSIONS.BANS_VIEW,
      PERMISSIONS.BANS_MANAGE,
      PERMISSIONS.WATCHLIST_VIEW,
      PERMISSIONS.WATCHLIST_MANAGE,
    ],
  },
  {
    label: 'Integrations',
    permissions: [PERMISSIONS.CFTOOLS_VIEW, PERMISSIONS.CFTOOLS_MANAGE],
  },
];

export function resolveUserPermissions(
  rolePermissions: Permission[],
  grants: string[] = [],
  denies: string[] = []
): Set<Permission> {
  const base = new Set<Permission>(rolePermissions);
  for (const g of grants) {
    if (ALL_PERMISSIONS.includes(g as Permission)) base.add(g as Permission);
  }
  for (const d of denies) {
    base.delete(d as Permission);
  }
  return base;
}

export function hasPermission(set: Set<Permission>, permission: Permission): boolean {
  return set.has(permission);
}
