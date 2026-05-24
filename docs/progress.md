# Progress Log

Rolling notes on implementation status. Newest entries at the top.

## 2026-05-24

- Initial planning complete. Architecture confirmed with the user:
  - Frontend + API: Next.js (App Router, React, Tailwind + shadcn/ui)
  - Downloader: Go microservice wrapping `yt-dlp`
  - Database: SQLite (better-sqlite3)
  - Realtime: WebSocket browser ⇄ Next.js; SSE Next.js ⇄ downloader
  - Cookies: per-domain `cookies.txt` upload
  - Storage: bind-mounted `./downloads` (flat layout)
  - Tailscale: optional sidecar override, tailnet only (no Funnel)
- Repo scaffolded (`.gitignore`, `.env.example`, `README.md`, `docs/` skeleton).

### Next up

1. Go downloader microservice (`downloader/`).
2. Next.js scaffold (`web/`).
3. Web DB + API routes.
4. Custom server + WebSocket hub.
5. UI pages.
6. Dockerfiles and compose files.
7. Documentation fill-out.
8. End-to-end verification.
