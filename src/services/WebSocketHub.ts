import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { AuthService } from '../auth/AuthService.js';
import type { Permission } from '../auth/permissions.js';
import { PERMISSIONS, hasPermission } from '../auth/permissions.js';
import type { DashboardData } from '../types/index.js';
import type { AlertRecord } from '../services/AlertStore.js';

interface WsClient {
  ws: WebSocket;
  userId: number;
  permissions: Set<Permission>;
  channels: Set<string>;
  instanceId: string;
}

function dashboardForClient(data: DashboardData, permissions: Set<Permission>): DashboardData {
  if (hasPermission(permissions, PERMISSIONS.CFTOOLS_VIEW)) {
    return data;
  }
  return {
    ...data,
    cftools: undefined,
    onlinePlayers: data.onlinePlayers.map(({ cftoolsBan: _ban, cftoolsId: _id, ...player }) => player),
  };
}

export class WebSocketHub {
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WsClient>();

  constructor(
    private readonly authService: AuthService,
    private readonly getDashboard: (
      instanceId: string,
      options?: { includeCftools?: boolean }
    ) => Promise<DashboardData>,
    private readonly resolveDefaultInstanceId: () => string,
    private readonly hasInstance: (id: string) => boolean
  ) {}

  attach(server: Server, wsPath = '/api/ws'): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== wsPath) return;

      const token = url.searchParams.get('token');
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      let user;
      try {
        user = this.authService.verifyAccessToken(token);
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const permissions = this.authService.getPermissions(user);

      let instanceId = url.searchParams.get('instanceId')?.trim() || this.resolveDefaultInstanceId();
      if (!this.hasInstance(instanceId)) {
        instanceId = this.resolveDefaultInstanceId();
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        const client: WsClient = {
          ws,
          userId: user.id,
          permissions,
          channels: new Set(),
          instanceId,
        };
        this.clients.add(client);
        ws.send(JSON.stringify({ type: 'connected', userId: user.id }));

        ws.on('message', (raw) => this.handleMessage(client, raw));
        ws.on('close', () => this.clients.delete(client));
        ws.on('error', () => this.clients.delete(client));
      });
    });

    console.log(`[WebSocket] Hub ready at ${wsPath}`);
  }

  private handleMessage(client: WsClient, raw: Buffer | ArrayBuffer | Buffer[]): void {
    try {
      const msg = JSON.parse(String(raw)) as { type?: string; channel?: string };
      if (msg.type === 'subscribe' && typeof msg.channel === 'string') {
        if (msg.channel === 'dashboard') {
          if (!hasPermission(client.permissions, PERMISSIONS.DASHBOARD_VIEW)) {
            client.ws.send(JSON.stringify({ type: 'error', error: 'Insufficient permissions' }));
            return;
          }
          client.channels.add('dashboard');
          void this.getDashboard(client.instanceId, { includeCftools: true }).then((data) => {
            const payload = dashboardForClient(data, client.permissions);
            client.ws.send(JSON.stringify({ type: 'update', channel: 'dashboard', data: payload }));
          });
          return;
        }
        if (msg.channel.startsWith('player:')) {
          if (!hasPermission(client.permissions, PERMISSIONS.TIMELINE_VIEW)) {
            client.ws.send(JSON.stringify({ type: 'error', error: 'Insufficient permissions' }));
            return;
          }
          client.channels.add(msg.channel);
          return;
        }
        if (msg.channel === 'alerts') {
          if (!hasPermission(client.permissions, PERMISSIONS.WATCHLIST_VIEW)) {
            client.ws.send(JSON.stringify({ type: 'error', error: 'Insufficient permissions' }));
            return;
          }
          client.channels.add('alerts');
        }
      }
      if (msg.type === 'unsubscribe' && typeof msg.channel === 'string') {
        client.channels.delete(msg.channel);
      }
    } catch {
      client.ws.send(JSON.stringify({ type: 'error', error: 'Invalid message' }));
    }
  }

  broadcastDashboard(instanceId: string, data: DashboardData): void {
    for (const client of this.clients) {
      if (client.instanceId !== instanceId) continue;
      if (
        client.channels.has('dashboard') &&
        hasPermission(client.permissions, PERMISSIONS.DASHBOARD_VIEW) &&
        client.ws.readyState === WebSocket.OPEN
      ) {
        const payload = dashboardForClient(data, client.permissions);
        client.ws.send(JSON.stringify({ type: 'update', channel: 'dashboard', data: payload }));
      }
    }
  }

  broadcastPlayerEvents(steamId: string, events: unknown[]): void {
    const channel = `player:${steamId}`;
    const payload = JSON.stringify({ type: 'events', channel, events });
    for (const client of this.clients) {
      if (
        client.channels.has(channel) &&
        hasPermission(client.permissions, PERMISSIONS.TIMELINE_VIEW) &&
        client.ws.readyState === WebSocket.OPEN
      ) {
        client.ws.send(payload);
      }
    }
  }

  broadcastAlert(alert: AlertRecord): void {
    const payload = JSON.stringify({ type: 'alert', data: alert });
    for (const client of this.clients) {
      if (!client.channels.has('alerts')) continue;
      if (!hasPermission(client.permissions, PERMISSIONS.WATCHLIST_VIEW)) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      if (alert.scope === 'global') {
        client.ws.send(payload);
        continue;
      }

      if (alert.scope === 'personal' && alert.userId === client.userId) {
        client.ws.send(payload);
      }
    }
  }

  close(): void {
    for (const client of this.clients) {
      try {
        client.ws.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }
}
