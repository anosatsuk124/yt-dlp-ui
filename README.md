# yt-dlp-ui

A small self-hosted web app that drives [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
from a browser. Paste URLs, pick a quality preset, and watch progress stream in
real time over a WebSocket. Finished files land in a plain directory on disk
and can be downloaded with one click. Run it on your laptop, or stand it up
behind a Tailscale sidecar so every device on your tailnet can use it.

## Features

- Queue URLs from any browser; jobs run with a configurable parallelism limit.
- **Format × container matrix.** Pick any number of containers under any number
  of formats in one shot — e.g. *Best → MP4, MKV* **and** *Audio → MP3, FLAC*
  enqueues four independent downloads. Video formats (**Best / 1080p / 720p**)
  remux into **MP4/MKV/WebM/MOV** (or Auto); audio extracts into **MP3/WAV/FLAC**.
  A free-form "advanced args" field is shell-split and forwarded to `yt-dlp`.
- **Content-hash identity.** Every finished file is sha256-hashed; the short
  hash is embedded in the filename (`Title [id] [#abc12345].mp4`) and the full
  hash is recorded in the database, so re-downloads never silently clobber a
  prior file.
- **Per-format/container directory layout.** Files are stored under
  `<downloads>/<format>/<container>/`, which isolates each job's yt-dlp
  fragments — downloading the same URL in several formats no longer deletes the
  earlier files during fragment cleanup.
- **Pre-download conflict prompt.** Re-requesting the same URL + format +
  container surfaces a modal: **Append** (keep both, distinguished by hash),
  **Overwrite** (delete the old entry locally and on MEGA, then re-download),
  **Save as…** (keep the old one, save the new under a custom name), or **Skip**.
- Per-domain `cookies.txt` upload, matched to a job's URL automatically
  (exact host first, then progressively shorter parent domains).
- Real-time progress (percent / speed / ETA) over WebSocket; reconnects with
  exponential backoff.
- History page with direct download links to the finished files.
- Optional MEGA auto-upload: finished files are pushed to your MEGA Cloud
  Drive, the local copy is deleted, and the History row flips to a "MEGA"
  badge. Audio downloads go to a configurable subfolder. A **Keep local copy**
  option (global default, or pinned per download in the queue form) uploads to
  MEGA *without* removing the on-disk file.
- **Maintenance / Update tasks.** A plugin-based migration system in *Settings*;
  each task previews the exact operations it will run (generated from the live
  database) in a modal before you confirm. Ships with a *Backfill content
  hashes* task that hashes pre-existing downloads (re-downloading MEGA-only ones).
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

## Desktop app (Tauri)

The same app also ships as a native desktop application (Linux/macOS/Windows)
built with **Tauri v2**, with **every external tool bundled** (yt-dlp, ffmpeg,
ffprobe and a node runtime) and **no TCP port opened**. The Rust core is a thin
supervisor + reverse proxy: it launches the existing Go downloader and Next.js
server as sidecars that talk over a **Unix domain socket** (Linux/macOS) or a
**named pipe** (Windows); the webview reaches the Next.js server through a custom
`app://` URI scheme that Rust proxies over that socket, and live job updates are
delivered as Tauri events (the SSE stream is bridged in Rust). The very same
Go/Next.js code backs both this and the Docker deployment — desktop behaviour is
gated purely on `DOWNLOADER_SOCKET` / `WEB_SOCKET`, so Docker is unaffected.

```
 ┌─────────┐  app:// (custom proto, no socket)  ┌───────────────────────────┐
 │ Webview │ ◀───────────────────────────────▶ │ Rust core (proxy + super- │
 └─────────┘   downloader-event (Tauri events)  │ visor + SSE→event bridge) │
                                                 └────────────┬──────────────┘
                              UDS / named pipe (no TCP)        │
                  ┌──────────────────────────────┬────────────┘
                  ▼                               ▼
            Next.js (node)                  Go downloader  ──exec──▶ yt-dlp
            SQLite/MEGA/API                                          ffmpeg / node
            (all bundled)                                           (all bundled)
```

Finished files land in `~/Downloads/yt-dlp-ui`; the DB, cookies and certs live
in the per-user app-data dir. A native notification fires on completion, and the
app checks for updates on launch.

### Building locally

Prerequisites: Rust, Go 1.22+, Node 20+, the Tauri CLI (`cargo install
tauri-cli --version "^2"`) and the platform webview libraries (on Linux:
`webkit2gtk-4.1`, `libsoup-3.0`, `gtk3`, `librsvg`).

```bash
# Fetches/pins yt-dlp+ffmpeg+node, builds the web app and the Go downloader,
# then runs `tauri build`. Produces installers under src-tauri/target/release/bundle/.
bash scripts/build-desktop.sh
```

On **Arch Linux**, `packaging/arch/PKGBUILD` builds a lean package
(`yt-dlp-ui-desktop-git`) that depends on the system `yt-dlp`/`ffmpeg`/`nodejs`
instead of bundling them, installs under `/usr/lib/yt-dlp-ui` and adds no extra
binaries to `/usr/bin`:

```bash
cd packaging/arch && makepkg -si
```

### Releases & auto-update

`.github/workflows/release.yml` builds, signs (updater) and publishes a draft
GitHub Release for all five targets when a `v*` tag is pushed. The in-app updater
requires its **own** signing key (independent of OS code signing, which is
currently disabled — artifacts are unsigned but updater-signed). One-time setup:

```bash
cargo tauri signer generate -w ~/.tauri/ytdlpui-updater.key   # keep the private key safe
```

Then in the GitHub repo, set secrets `TAURI_SIGNING_PRIVATE_KEY` (the private key
file's contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and put the matching
public key in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. To
enable OS code signing later, add the Apple/Windows secrets documented inline in
`release.yml`.

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
   - Optionally set the **Audio subfolder** (default `audio`): audio-only
     downloads upload to `<destination folder>/<audio subfolder>` instead of
     the main folder.
   - Optionally turn on **Keep local copy** to keep the on-disk file after a
     successful upload instead of deleting it (default: delete).
   - **Save**.
3. From now on, every job that reaches `completed` is queued for upload.
   The History page shows `MEGA queued` → `MEGA…` → `✓ MEGA`. Failures stay
   on local disk and surface as `MEGA failed` with the error in the tooltip.

The queue form has a per-download **Keep local copy after MEGA upload**
checkbox (shown when MEGA is enabled). It defaults to the global setting and
applies to every URL in that batch, so you can keep just one download on disk
while the rest are deleted after upload (or vice-versa).

When you **Overwrite** an existing download, the old MEGA file is deleted
(by name, permanently) before the replacement is re-uploaded. If that remote
delete fails it is logged and the upload still proceeds, so a stale duplicate
may remain — check the destination folder if in doubt.

Credentials are stored in the SQLite settings table at `${HOST_DATA_DIR}/app.db`
in plaintext, so treat that file like any other secret. No public share
link is generated — access the file by logging into MEGA.

## Maintenance / Update tasks

Schema and storage changes sometimes need a one-off backfill over existing
rows. The **Maintenance / Update** card in *Settings* hosts these as plugins.
Each task's **Review & run** button opens a modal that first calls the task's
`plan()` — which inspects the current database and returns the exact list of
operations it would perform — and renders those lines verbatim. Nothing runs
until you press **Run**; progress and a live log stream into the same modal.

Shipped task:

- **Backfill content hashes** — finds completed/uploaded downloads with no
  recorded sha256. Files still on disk are hashed in place. Files already on
  MEGA are downloaded just long enough to compute the hash, then their MEGA copy
  is **renamed in place** to embed the `[#hash]` marker (no bytes are
  re-uploaded). Only files missing from both disk and MEGA are re-downloaded
  from the source URL.

To add a migration, implement `MaintenanceTask` in `web/src/lib/maintenance/`
and register it in `registry.ts`; it then appears in the same modal.

## Storage

| Host path | Mounted at | Contents |
|---|---|---|
| `./downloads` | `/downloads` (both containers) | Finished media files, laid out as `<format>/<container>/Title [id] [#hash].ext`. |
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
