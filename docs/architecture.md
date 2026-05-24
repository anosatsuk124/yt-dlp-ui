# Architecture

> Skeleton — filled out in the documentation phase. The high-level picture is
> below; details (lifecycle, recovery, error paths) follow once the
> implementation lands.

## Components

```
┌──────────────────────────┐   WebSocket    ┌──────────────────────┐   HTTP+SSE   ┌────────────┐
│ Browser                  │ ◀────────────▶ │ Next.js              │ ◀──────────▶ │ Downloader │
│  React + Tailwind        │                │  App Router + API    │              │ (Go)       │
│  + shadcn/ui             │                │  + better-sqlite3    │              │  exec yt-dlp│
└──────────────────────────┘                └──────────────────────┘              └────────────┘
                                                     │                                  │
                                                     ▼                                  ▼
                                            /data/app.db                       /downloads, /cookies
```

- **web** (Next.js, port 3000) — UI, REST API, WebSocket fan-out, SQLite owner.
- **downloader** (Go, port 8080) — accepts jobs over HTTP, runs `yt-dlp`,
  streams progress over SSE.
- **tailscale** (optional sidecar) — joins the tailnet and exposes the web port
  via `tailscale serve` (tailnet-only, Funnel disabled).

Both app services bind-mount `./downloads` and `./cookies` from the host. The
web service additionally owns `./data` (the SQLite file).
