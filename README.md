# yt-dlp-ui

A small self-hosted web app that drives [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
from a browser. Paste URLs, pick a quality preset, and watch progress stream in
real time over a WebSocket. Finished files land in a plain directory on disk
and can be downloaded with one click. Run it on your laptop, or stand it up
behind a Tailscale sidecar so every device on your tailnet can use it.

## Features

- Queue URLs from any browser; jobs run with a configurable parallelism limit.
- Quality presets: **Best**, **1080p**, **720p**, **Audio (mp3)**, plus a
  free-form "advanced args" field that's shell-split and forwarded to `yt-dlp`.
- Per-domain `cookies.txt` upload, matched to a job's URL automatically
  (exact host first, then progressively shorter parent domains).
- Real-time progress (percent / speed / ETA) over WebSocket; reconnects with
  exponential backoff.
- History page with direct download links to the finished files.
- Optional MEGA auto-upload: finished files are pushed to your MEGA Cloud
  Drive, the local copy is deleted, and the History row flips to a "MEGA"
  badge.
- Optional Tailscale sidecar: the UI is reachable only inside your tailnet
  (Tailscale Funnel is **explicitly disabled**).

## Architecture

The browser holds a single WebSocket to a custom Next.js server. That server
both serves the Next.js app and consumes a long-lived Server-Sent Events
stream from a separate Go service that wraps `yt-dlp`. The Go service is the
only thing that actually invokes the binary; the Next.js side owns SQLite, the
REST API, cookies, and file delivery.

```
                WebSocket                     HTTP + SSE
 ┌─────────┐  ◀──────────▶  ┌──────────────┐ ◀──────────▶ ┌────────────┐
 │ Browser │                │  Next.js     │              │ Downloader │
 │ React + │                │  + sqlite    │              │  (Go)      │
 │ Tailwind│                │  custom srv  │              │  exec      │
 └─────────┘                └──────────────┘              │  yt-dlp    │
                                  │                       └────────────┘
                                  ▼                              │
                            /data/app.db                         ▼
                                                          /downloads /cookies
```

## Quick start

```bash
cp .env.example .env
docker compose up -d --build
# UI on http://localhost:3000
```

Paste a URL, hit **Enqueue**, and watch the progress bar move. If the first
download finishes and the file appears in `./downloads`, everything is wired
up correctly.

## Configuration

Only user-tunable knobs live in `.env`. Container-internal paths (the
`yt-dlp` binary location, `/downloads`, `/cookies`, `/data`, and the
downloader's in-network URL) are baked into the images and the compose file
and are not exposed here.

| Variable | Default | Meaning |
|---|---|---|
| `DOWNLOADER_MAX_PARALLEL` | `2` | Maximum concurrent `yt-dlp` jobs. |
| `HOST_DOWNLOAD_DIR` | `./downloads` | Host directory bind-mounted to `/downloads`. |
| `HOST_COOKIES_DIR` | `./cookies` | Host directory bind-mounted to `/cookies`. |
| `HOST_DATA_DIR` | `./data` | Host directory bind-mounted to `/data` (SQLite). |
| `WEB_PORT` | `3000` | Host port the web UI is published on. Ignored under the Tailscale override (the UI is reachable only via the tailnet there). |
| `TS_AUTHKEY` | *(empty)* | Tailscale pre-auth key. Required only for the Tailscale override. |
| `TS_HOSTNAME` | `yt-dlp-ui` | Hostname the Tailscale sidecar registers in your tailnet. |

## Optional: Tailscale sidecar

Prerequisites:

- A Tailscale account and tailnet.
- A reusable, ephemeral pre-auth key from
  <https://login.tailscale.com/admin/settings/keys>, put into `.env` as
  `TS_AUTHKEY`.

What gets exposed: the web UI, served over HTTPS via `tailscale serve` at
`https://<TS_HOSTNAME>.<your-tailnet>.ts.net`. The host port from the base
compose file is **reset** so the UI is not reachable over the LAN; only the
tailnet sees it. Tailscale **Funnel** is explicitly disabled (`AllowFunnel:
false` in `tailscale/serve.json`) — there is no public-internet exposure.

```bash
docker compose -f docker-compose.yml -f docker-compose.tailscale.yml up -d --build
```

The `web` container joins the Tailscale container's network namespace; the
`downloader` stays on the bridge network and is reached via the `downloader`
service name.

## Cookies

Many sites refuse `yt-dlp` without an authenticated session. The flow is:

1. Sign into the site in your normal browser.
2. Export `cookies.txt` for that site using a browser extension —
   ["Get cookies.txt LOCALLY"](https://github.com/kairi003/Get-cookies.txt-LOCALLY)
   is one option; any extension that produces a Netscape-format `cookies.txt`
   works.
3. Open `/cookies` in the UI, enter the domain (e.g. `example.com`), select
   the file, upload.

The server validates that the file starts with the Netscape header
(`# Netscape HTTP Cookie File` or `# HTTP Cookie File`). When a job is
enqueued, the server resolves the URL's hostname to a cookies file by trying
the exact host first and then walking up to shorter parent domains, so
`m.youtube.com` will pick up `youtube.com.txt` if no `m.youtube.com.txt`
exists.

## Optional: MEGA upload

If you'd rather not let `./downloads` grow forever, point yt-dlp-ui at a
MEGA account and it will push every finished file to the cloud, delete the
local copy, and flip the History row to a "MEGA" badge.

1. Open `/settings` in the UI.
2. In the **MEGA upload** card:
   - Click the toggle to **Enabled**.
   - Fill in **Email**, **Password**, and **Destination folder** (default
     `/yt-dlp-ui`, created on first upload if missing).
   - **Save**.
3. From now on, every job that reaches `completed` is queued for upload.
   The History page shows `MEGA queued` → `MEGA…` → `✓ MEGA`. Failures stay
   on local disk and surface as `MEGA failed` with the error in the tooltip.

Credentials are stored in the SQLite settings table at `${HOST_DATA_DIR}/app.db`
in plaintext, so treat that file like any other secret. No public share
link is generated — access the file by logging into MEGA.

## Storage

| Host path | Mounted at | Contents |
|---|---|---|
| `./downloads` | `/downloads` (both containers) | Finished media files (flat layout). |
| `./cookies`   | `/cookies` (read-only in downloader) | Per-domain `<domain>.txt` files. |
| `./data`      | `/data` (web only) | `app.db` — the SQLite database. |
| `./tailscale-state` | `/var/lib/tailscale` (Tailscale only) | Tailscale node state. |

All three primary host paths are overridable via `HOST_DOWNLOAD_DIR`,
`HOST_COOKIES_DIR`, and `HOST_DATA_DIR`.

## Troubleshooting

- **"downloader unreachable" when enqueuing a job.** The web service couldn't
  reach the Go downloader. Check `docker compose logs downloader` for crash
  reasons or yt-dlp errors. Confirm the `downloader` container is `Up` in
  `docker compose ps`.
- **Tailscale container won't start / immediately exits.** Almost always a
  bad or missing `TS_AUTHKEY`. The compose file uses `${TS_AUTHKEY:?...}`, so
  an unset value will fail loudly. Generate a fresh pre-auth key and try
  again.
- **Downloads don't appear in `./downloads`.** Check that the bind-mounted
  directory actually exists on the host and isn't mounted read-only, and
  that the container user can write to it. `docker compose logs downloader`
  will show the `yt-dlp` exit status and any permission errors.

## Development

Run the two services directly, no Docker required:

```bash
# terminal 1 — downloader on :8080
cd downloader
go run ./cmd/downloader

# terminal 2 — Next.js dev server on :3000, talking to the downloader above
cd web
npm install
npm run dev
```

Static checks for the Go service:

```bash
cd downloader
go vet ./...
go build ./...
```

## Documentation

- [Architecture](docs/architecture.md)
- [HTTP / WebSocket API](docs/api.md)
- [Progress protocol (yt-dlp → SSE → WS)](docs/design-progress-protocol.md)
- [Progress log](docs/progress.md)
