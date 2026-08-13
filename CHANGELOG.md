# Changelog

## 2.1.0 — Nimble Jackal

First public source release of Player History Server.

- Indexes Player History mod logs into SQLite
- Map replay API keeps action metadata so the client can name completed actions
- Authenticated REST + WebSocket API for the admin client
- JWT auth with roles and per-user permission overrides
- Optional CFTools Cloud enrichment (IDs, bans, GSM sessions)
- Configurable event retention and daily log cleanup
- Multi-instance support
- Portable Windows `.exe` via `build-server.bat` / `npm run pack`
- Clean shutdown on SIGINT and SIGTERM
