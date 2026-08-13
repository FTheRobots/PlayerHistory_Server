import http from 'http';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { DatabaseService } from './services/DatabaseService.js';
import { InstanceStore } from './services/InstanceStore.js';
import { InstanceCoordinator } from './services/InstanceCoordinator.js';
import { PlayerRepository } from './services/PlayerRepository.js';
import { ItemRepository } from './services/ItemRepository.js';
import { WebSocketHub } from './services/WebSocketHub.js';
import { createRoutes } from './routes/index.js';
import { createHealthHandler } from './routes/publicHealth.js';
import { createInstanceRoutes } from './routes/instances.js';
import { createAuthRoutes } from './routes/auth.js';
import { createSetupRoutes } from './routes/setup.js';
import { createUserRoutes } from './routes/users.js';
import { createRoleRoutes } from './routes/roles.js';
import { createModerationRoutes } from './routes/moderation.js';
import { createIntegrationsRoutes } from './routes/integrations.js';
import { createQueryRoutes } from './routes/query.js';
import { QueryService } from './services/QueryService.js';
import { SavedQueryStore } from './services/SavedQueryStore.js';
import { AuthService } from './auth/AuthService.js';
import { UserStore } from './auth/UserStore.js';
import { RoleStore } from './auth/RoleStore.js';
import { AuditStore } from './services/AuditStore.js';
import { WatchlistStore } from './services/WatchlistStore.js';
import { AlertStore } from './services/AlertStore.js';
import { AlertService } from './services/AlertService.js';
import { CFToolsStore } from './services/CFToolsStore.js';
import { CFToolsService } from './services/CFToolsService.js';
import { resolveRuntimeConfig } from './config.js';
import { createCorsOptions } from './cors.js';
import { runFirstRunSetup } from './setup/firstRunSetup.js';
import { APP_VERSION, RELEASE_CODENAME } from './appVersion.js';

async function main(): Promise<void> {
  const config = resolveRuntimeConfig();
  const {
    dbPath: DB_PATH,
    host: HOST,
    port: PORT,
    configPath,
    corsOrigins,
    corsAllowAll,
    trustProxy,
    publicBaseUrl,
    serverName,
    eventRetentionDays,
  } = config;

  console.log('[PlayerHistory Server] Starting...');
  console.log(
    `[PlayerHistory Server] Version:  ${APP_VERSION}${RELEASE_CODENAME ? ` (“${RELEASE_CODENAME}”)` : ''}`,
  );
  console.log(`[PlayerHistory Server] App root: ${config.projectRoot}`);
  console.log(`[PlayerHistory Server] Config:   ${configPath}${fs.existsSync(configPath) ? '' : ' (using defaults — copy config.example.json)'}`);

  const dbService = new DatabaseService(DB_PATH);
  const db = dbService.getDb();
  UserStore.ensureSchema(db);
  const roleStore = new RoleStore(db);
  const userStore = new UserStore(db, roleStore);
  const authService = new AuthService(config, userStore, roleStore);

  const setupResult = await runFirstRunSetup(authService, config);
  if (!setupResult.ok) {
    dbService.close();
    process.exit(1);
  }

  const DATA_ROOT = setupResult.playerHistoryPath || config.playerHistoryPath;
  if (!DATA_ROOT) {
    console.error('[PlayerHistory Server] playerHistoryPath is not configured.');
    dbService.close();
    process.exit(1);
  }

  const effectiveRetentionDays = setupResult.eventRetentionDays ?? eventRetentionDays;
  const effectivePort = setupResult.port ?? PORT;

  console.log(`[PlayerHistory Server] Primary data root: ${DATA_ROOT}`);
  console.log(`[PlayerHistory Server] Database:  ${DB_PATH}`);

  const instanceStore = new InstanceStore(db);
  const repo = new PlayerRepository(dbService);
  const itemRepo = new ItemRepository(dbService);
  const cftoolsStore = new CFToolsStore(dbService.getDb(), config.jwtSecret);
  const cftoolsService = new CFToolsService(cftoolsStore);
  const auditStore = new AuditStore(dbService.getDb());
  const watchlistStore = new WatchlistStore(dbService.getDb());
  const alertStore = new AlertStore(dbService.getDb());
  const queryService = new QueryService(dbService);
  const savedQueryStore = new SavedQueryStore(dbService.getDb());

  let wsHub: WebSocketHub | null = null;
  let alertService: AlertService | null = null;
  let dashboardBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let watchCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingWatchInstanceId: string | null = null;

  const scheduleDashboardBroadcast = (): void => {
    if (dashboardBroadcastTimer) return;
    dashboardBroadcastTimer = setTimeout(async () => {
      dashboardBroadcastTimer = null;
      if (!wsHub) return;
      try {
        for (const inst of coordinator.list()) {
          const runtime = coordinator.resolve(inst.id);
          // Fast path without CFTools — keeps WS ticks snappy.
          const data = await runtime.dashboard.getDashboard({ includeCftools: false });
          if (inst.id === coordinator.getDefaultInstanceId()) {
            alertService?.processDashboard(data);
          }
          wsHub.broadcastDashboard(inst.id, data);

          if (cftoolsService.isOperational()) {
            void runtime.dashboard
              .getDashboard({ includeCftools: true })
              .then((enriched) => wsHub?.broadcastDashboard(inst.id, enriched))
              .catch((err) => console.warn('[WebSocket] CFTools enrich broadcast failed:', err));
          }
        }
      } catch (err) {
        console.error('[WebSocket] Dashboard broadcast failed:', err);
      }
    }, 1000);
  };

  const scheduleWatchCheck = (instanceId: string): void => {
    pendingWatchInstanceId = instanceId;
    if (watchCheckTimer) return;
    watchCheckTimer = setTimeout(() => {
      watchCheckTimer = null;
      const id = pendingWatchInstanceId;
      pendingWatchInstanceId = null;
      if (!id) return;
      try {
        savedQueryStore.checkWatches(id, queryService);
      } catch (err) {
        console.error('[QueryWatch] Check failed:', err);
      }
    }, 5000);
  };

  let coordinator: InstanceCoordinator;
  coordinator = new InstanceCoordinator(
    dbService,
    instanceStore,
    repo,
    cftoolsService,
    effectiveRetentionDays,
    {
      onServerJsonChange: scheduleDashboardBroadcast,
      onEventsIndexed: (steamId, instanceId) => {
        scheduleDashboardBroadcast();
        alertService?.processIndexedEvents(instanceId, steamId);
        scheduleWatchCheck(instanceId);
      },
    }
  );

  coordinator.initialize(DATA_ROOT);
  console.log(`[PlayerHistory Server] Instances: ${coordinator.list().length}`);

  if (effectiveRetentionDays > 0) {
    console.log(`[PlayerHistory Server] Event retention: ${effectiveRetentionDays} days`);
    await coordinator.runRetentionPurge();
  }

  console.log('[PlayerHistory Server] Running initial index...');
  const initial = await coordinator.indexAll();
  console.log(
    `[PlayerHistory Server] Indexed ${initial.eventsIndexed} events from ${initial.filesProcessed} files`
  );

  coordinator.startWatchers();
  coordinator.startPeriodicSync(60000);

  if (effectiveRetentionDays > 0) {
    coordinator.startPeriodicRetention(24 * 60 * 60 * 1000);
  }

  const app = express();
  if (trustProxy) {
    app.set('trust proxy', 1);
  }
  app.use(cors(createCorsOptions(corsOrigins, corsAllowAll)));
  app.use(express.json());

  const serverPublicInfo = {
    publicBaseUrl,
    websocketPath: '/api/ws',
    serverName,
  };

  // Public routes — registered before any authenticated /api routers.
  app.get('/api/health', createHealthHandler(coordinator, authService, serverPublicInfo));

  app.use('/api/auth', createAuthRoutes(authService, auditStore));
  app.use('/api/setup', createSetupRoutes(authService));
  app.use('/api/users', createUserRoutes(authService, userStore, roleStore, auditStore));
  app.use('/api/roles', createRoleRoutes(authService, roleStore, auditStore));
  app.use('/api', createRoutes(coordinator, repo, itemRepo, authService, auditStore, serverPublicInfo));
  app.use('/api', createQueryRoutes(coordinator, queryService, savedQueryStore, authService));
  app.use('/api', createInstanceRoutes(coordinator, authService, auditStore));
  app.use(
    '/api',
    createModerationRoutes(authService, auditStore, coordinator, watchlistStore, alertStore, repo)
  );
  app.use(
    '/api',
    createIntegrationsRoutes(authService, auditStore, cftoolsStore, cftoolsService)
  );

  app.get('/', (_req, res) => {
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><title>Player History Server</title></head>
<body style="font-family:system-ui;background:#0f1117;color:#e6edf3;max-width:720px;margin:48px auto;padding:0 24px">
  <h1>Player History Server</h1>
  <p>API backend for the remote admin client. Clients connect here over HTTP(S) and WebSocket.</p>
  <p>Public URL: <code>${publicBaseUrl}</code></p>
  <p><a href="/api/health" style="color:#58a6ff">/api/health</a> — connection check for clients</p>
</body></html>`);
  });

  const server = http.createServer(app);
  wsHub = new WebSocketHub(
    authService,
    (instanceId, options) => coordinator.resolve(instanceId).dashboard.getDashboard(options),
    () => coordinator.getDefaultInstanceId(),
    (id) => coordinator.has(id)
  );
  alertService = new AlertService(watchlistStore, alertStore, repo, wsHub);

  wsHub.attach(server, '/api/ws');

  server.listen(effectivePort, HOST, () => {
    console.log(`[PlayerHistory Server] Listening on http://${HOST}:${effectivePort}`);
    console.log(`[PlayerHistory Server] Public URL: ${publicBaseUrl}`);
    if (corsAllowAll) {
      console.log('[PlayerHistory Server] CORS: all origins allowed (remote clients enabled)');
    } else {
      console.log(`[PlayerHistory Server] CORS origins: ${corsOrigins.join(', ')}`);
    }
    if (trustProxy) {
      console.log('[PlayerHistory Server] Trust proxy: enabled (reverse proxy / X-Forwarded-*)');
    }
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[PlayerHistory Server] ${signal} — shutting down`);
    coordinator.stopTimers();
    if (dashboardBroadcastTimer) clearTimeout(dashboardBroadcastTimer);
    if (watchCheckTimer) clearTimeout(watchCheckTimer);
    coordinator.stopWatchers();
    wsHub?.close();
    dbService.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(console.error);
