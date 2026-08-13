# PlayerHistory Server

API-only backend for DayZ Player History. Runs on the **game server machine**, reads `profiles/PlayerHistory`, indexes events into SQLite, queues admin commands for the mod, and exposes authenticated REST + WebSocket endpoints for **remote admin clients** (browser, portable `.exe`, or any machine that can reach this port).

## Quick start (Windows)

### Portable `.exe` (game server)

1. Run `build-server.bat` — outputs `release/PlayerHistory-Server.{version}-{Codename}.exe` (e.g. `PlayerHistory-Server.2.1.0-NimbleJackal.exe`).
2. Copy to your DayZ server folder:
   - the versioned exe
   - `config.example.json`
   - `Start-Server.bat` (recommended launcher)
3. Run **`Start-Server.bat`** (recommended) or the versioned exe. Use the batch file so `config.json` and `data/` are created **beside the exe**, not in `%TEMP%`.
4. On first run you will be prompted for your `profiles/PlayerHistory` path, retention period (default 14 days), HTTP port (default 3847), and owner account details (saved to `config.json`).
5. Connect the admin client and sign in with that account.

Paths in `config.json` are relative to the exe directory unless absolute (e.g. `./data/player-history.db`).

**Portable path resolution:** The exe unpacks to `%TEMP%` at runtime. `Start-Server.bat` sets `PH_APP_ROOT` to the exe folder. If you must run the exe directly and paths land in Temp, set `PH_APP_ROOT` to your deploy folder before starting.

### Development (Node.js)

1. Copy `config.example.json` → `config.json` (or let first-run setup create it).
2. Run `start-server.bat` (installs deps and starts in dev mode).
3. On first run, enter your `profiles/PlayerHistory` path, event retention period, and owner account in the console.

## Configuration

| Field | Description |
|-------|-------------|
| `playerHistoryPath` | Path to `profiles/PlayerHistory` on the DayZ box (set during first-run setup, or edit `config.json`) |
| `dbPath` | SQLite index database (default `./data/player-history.db`) |
| `host` | Bind address (default `0.0.0.0` — required for port forwarding) |
| `port` | HTTP + WebSocket port (default `3847`) |
| `corsAllowAll` | Allow admin clients from any origin (default `true`; JWT still required) |
| `corsOrigins` | Allowed origins when `corsAllowAll` is `false` |
| `publicBaseUrl` | URL clients use to connect (public IP, domain, or `https://…` behind proxy) |
| `trustProxy` | Honor `X-Forwarded-*` from nginx/Caddy (default `true`) |
| `jwtSecret` | **Required in production** — long random string |
| `accessTokenMinutes` | JWT access token TTL (default 15) |
| `refreshTokenDays` | Refresh token TTL (default 7) |
| `eventRetentionDays` | Delete indexed events and daily `.jsonl` logs older than this many days (`0` = disabled; first-run setup defaults to **14**) |

### Environment overrides

- `PLAYER_HISTORY_PATH`, `DB_PATH`, `HOST`, `PORT`
- `CORS_ALLOW_ALL` — `true` / `false`
- `CORS_ORIGINS` — comma-separated list (when `corsAllowAll` is false)
- `TRUST_PROXY` — `true` / `false`
- `PUBLIC_BASE_URL`, `JWT_SECRET`
- `EVENT_RETENTION_DAYS` — overrides `eventRetentionDays` in config
- `PH_APP_ROOT` — folder containing `config.json` and `data/` when running the portable `.exe` (set automatically by `Start-Server.bat`)

### Event retention

When `eventRetentionDays` is greater than zero, the server automatically:

1. Deletes events from the SQLite index where `timestamp` is older than the cutoff
2. Deletes matching daily log files (`{steamId}/events/YYYY-MM-DD.jsonl`) from disk so they are not re-imported
3. Refreshes player event counts and runs `VACUUM` after large purges

Retention runs once at startup (before indexing) and again every 24 hours. Death snapshots, inventory snapshots, and admin data are not affected.

## Exposing for remote clients

Clients (portable `.exe` or browser) connect **to this server**. They enter your public URL on the login screen — no client-side port forward needed.

### Option A — Port forward (direct)

1. Server binds `0.0.0.0:3847` (default).
2. Forward **TCP 3847** on your router/firewall to the DayZ machine.
3. Allow the port in **Windows Firewall** on the game box.
4. Set `publicBaseUrl` in `config.json`, e.g. `http://203.0.113.10:3847`.
5. Clients connect with `203.0.113.10:3847` (or full URL) on the login screen.

`corsAllowAll: true` (default) lets the portable exe and browser clients work without listing every origin.

Use HTTPS only if you add TLS (Option B) or a VPN; plain HTTP over the public internet is not recommended.

### Option B — Reverse proxy (recommended for HTTPS)

Terminate TLS with **Caddy** or **nginx** on 443 and proxy to `127.0.0.1:3847`.

**Caddy example:**

```
dayz.example.com {
  reverse_proxy localhost:3847
}
```

**nginx example:**

```nginx
server {
  listen 443 ssl;
  server_name dayz.example.com;

  ssl_certificate     /path/fullchain.pem;
  ssl_certificate_key /path/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3847;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Set `publicBaseUrl` to `https://dayz.example.com`. Clients use that URL; WebSocket upgrades automatically (`wss://…/api/ws`).

Set `jwtSecret` to a strong value and back up `dbPath` (contains users + event index).

To lock down CORS (optional): set `corsAllowAll: false` and list specific client origins in `corsOrigins`.

## Auth & roles

Built-in role: **owner** (full access, cannot be deleted). Create additional roles under Admin → Roles.

Public endpoints:

- `GET /api/health` — connection check (returns version, `publicBaseUrl`, `websocketUrl`)
- `GET /api/setup/status`
- `POST /api/setup/owner` (first run only)
- `POST /api/auth/login`, `/refresh`, `/logout`

All other `/api/*` routes require `Authorization: Bearer <accessToken>`.

## WebSocket

Connect to `WSS /api/ws?token=<accessToken>` after login (or `ws://` for plain HTTP).

Subscribe to live dashboard:

```json
{ "type": "subscribe", "channel": "dashboard" }
```

Dashboard updates are pushed when `server.json` or new events are indexed (~1–2s).

## Production

```bash
npm run build
npm start
```

Run as a Windows Service or scheduled task so it starts with the DayZ server.

### Database

On first start the server creates `./data/player-history.db` (or the path in `config.json` → `dbPath`) with the full schema, including multi-instance support (`instance_id` on events and players).

If you see **`no such column: instance_id`**, the database file was created with an older broken build. Stop the server, delete the database file (and `-wal` / `-shm` siblings if present), and restart — first-run setup will recreate it. Re-indexing will repopulate events from your PlayerHistory log files.

## Scripts

| Script | Purpose |
|--------|---------|
| `build-server.bat` | Install deps, compile, pack portable `.exe` into `release/` |
| `start-server.bat` | Dev mode with hot reload |
| `npm run dev` | Development with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled server |
| `npm run pack` | Build + pack portable `.exe` |
| `npm run sync-version` | Sync `VERSION` to server/web/desktop `package.json` |
| `node scripts/promote-owner.mjs <username>` | Restore owner role if locked out (local DB only) |

## Versioning

Product version is defined in `VERSION` (currently aligned with web/desktop via `npm run sync-version`). Health endpoint returns `version`, `apiVersion`, and `minClientVersion` for client compatibility checks.

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Related projects

This server indexes logs from the **Player History** DayZ mod and is consumed by the **Player History Web** admin client. Those live in sibling folders (`PlayerHistory`, `PlayerHistory_Web`) if you keep the three projects together.

## License

MIT. See [LICENSE](LICENSE).
