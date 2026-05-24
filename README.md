# yt-dlp-ui

A small self-hosted web app that drives [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
from a browser. Submit URLs from any device on your tailnet, watch progress in
real time, and pull the resulting files from a local directory.

> **Status:** work-in-progress. See `docs/progress.md`.

## Features

- Queue URLs from the browser; jobs run in order (configurable parallelism).
- Quality presets (Best / 1080p / 720p / Audio-only mp3) plus a free-form
  "advanced args" field.
- Per-domain `cookies.txt` upload, stored on the server and matched to URLs
  automatically.
- Real-time progress (speed, percent, ETA) over WebSocket.
- History list with direct file download links.
- Optional Tailscale sidecar — serves the UI inside your tailnet only
  (no Funnel / public exposure).

## Quick start

```bash
cp .env.example .env       # adjust if needed
docker compose up -d --build
# UI on http://localhost:3000
```

Files land in `./downloads/`. Cookies are kept in `./cookies/`. SQLite DB in `./data/`.

### Run on the tailnet (optional)

Add `TS_AUTHKEY` (pre-auth key from
<https://login.tailscale.com/admin/settings/keys>) to `.env`, then:

```bash
docker compose -f docker-compose.yml -f docker-compose.tailscale.yml up -d --build
```

The UI becomes reachable at `https://<TS_HOSTNAME>.<your-tailnet>.ts.net` from
any device on your tailnet. Tailscale Funnel is explicitly disabled.

## Documentation

- [Architecture](docs/architecture.md)
- [HTTP / WebSocket API](docs/api.md)
- [Progress protocol (yt-dlp → SSE → WS)](docs/design-progress-protocol.md)
- [Progress log](docs/progress.md)
