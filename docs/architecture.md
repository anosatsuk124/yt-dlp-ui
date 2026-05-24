# Architecture

## High-level diagram

```
┌──────────────────────────┐   WebSocket    ┌──────────────────────┐   HTTP + SSE   ┌────────────┐
│ Browser                  │ ◀────────────▶ │ Next.js              │ ◀────────────▶ │ Downloader │
│  React + Tailwind        │  (/api/ws)     │  custom server.ts    │  (/events,     │  (Go)      │
│  + shadcn/ui             │                │  + better-sqlite3    │   /jobs, …)    │  exec      │
└──────────────────────────┘                └──────────────────────┘                │  yt-dlp    │
                                                       │                            └────────────┘
                                                       ▼                                   │
                                                /data/app.db                               ▼
                                                                                  /downloads /cookies
```

Browsers hold a single WebSocket to the custom Next.js server. That server
runs Next.js for HTTP routes and serves the WebSocket endpoint at `/api/ws`
itself. It also keeps a long-lived consumer attached to the Go downloader's
`GET /events` Server-Sent Events stream, persisting the events to SQLite and
fanning them out to every connected WebSocket client.

## Components

### `web` (Next.js, port 3000)

Next.js 14 (App Router) with React, Tailwind, and shadcn/ui. The custom
server in `web/server.ts` wraps the Next.js HTTP handler so it can attach a
`ws` WebSocketServer on `/api/ws` and run the SSE consumer in the same
process. SQLite (`better-sqlite3`) is the source of truth for both queued and
finished jobs and for two persistent settings. All REST endpoints live under
`/api/*` (see [api.md](api.md)).

### `downloader` (Go, port 8080)

Single-file stdlib-only HTTP service in `downloader/cmd/downloader/main.go`.
Accepts jobs over JSON HTTP, runs `yt-dlp` from a worker pool with
configurable concurrency, and publishes progress on an in-process event bus
that is exposed as a Server-Sent Events stream at `GET /events`. Stays
internal: it has no auth and is not designed to be reached from outside the
compose network.

### `tailscale` (optional sidecar)

Official `tailscale/tailscale` image. Joins the host to a tailnet using
`TS_AUTHKEY` and serves the web UI inside the tailnet via `tailscale serve`
(config in `tailscale/serve.json`). The `web` container is moved into this
container's network namespace via `network_mode: service:tailscale`, and its
host port publish is reset so the UI is only reachable via the tailnet.
Funnel is disabled (`AllowFunnel: false`).

## Data flow for a job

1. User pastes one or more URLs and picks a preset in the Queue page. The
   browser `POST`s `/api/jobs` with `{ urls, format, extraArgs }`.
2. The web service generates a UUID for each URL, resolves a per-domain
   cookies file (if any), and inserts a `queued` row into `jobs` in SQLite.
3. The web service forwards each job to the downloader via
   `POST /jobs { id, url, format, extraArgs, cookiesFile }`.
4. The downloader enters the job in its in-memory registry, queues it on the
   worker pool, and immediately publishes a `status: queued` SSE event.
5. A worker picks the job up, publishes `status: running`, builds the
   `yt-dlp` argv (`--newline --no-color --progress --progress-template …`),
   and spawns the process in its own process group. Stdout is parsed for
   `PROGRESS` lines and destination paths; stderr is captured into a 4 KB
   rolling buffer.
6. Every parsed `PROGRESS` line becomes a `progress` SSE event. The Next.js
   SSE consumer forwards every event to all WebSocket clients in real time,
   but **throttles DB writes** to roughly one progress row update per job
   every two seconds.
7. When the process exits, the downloader publishes a terminal `status`
   event (`completed` / `failed` / `canceled`). Terminal status transitions
   are persisted to SQLite **immediately**, not throttled.
8. The browser sees the terminal `status` over WebSocket and drops the job
   from its active list; the History page picks it up on next load via
   `GET /api/history`. The finished file sits in `./downloads` and is
   streamed by `GET /api/files/:name`.

## Schema

The full SQLite schema (`web/schema.sql`), applied idempotently on every web
service start:

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  format       TEXT NOT NULL,
  extra_args   TEXT,
  cookies_file TEXT,
  status       TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','canceled')),
  progress     REAL NOT NULL DEFAULT 0,
  speed        TEXT,
  eta          TEXT,
  title        TEXT,
  file_path    TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`extra_args` is stored as JSON (the shell-split array). `cookies_file` is the
container-side absolute path that the downloader will pass to `yt-dlp
--cookies`. Timestamps are Unix-millisecond integers.

## State machine

```
queued ──► running ──► completed
   │           │
   │           └────► failed
   │
   └────► canceled        (cancel from queued skips running)
```

Cancellation from `queued` is observable: the worker that eventually picks
the job up sees `StatusCanceled` in the registry and returns without ever
spawning `yt-dlp`. Cancellation from `running` SIGINTs the process group,
waits up to 3 seconds, then SIGKILLs it.

## Recovery

If `web` restarts mid-download:

- The in-memory `Map<id, JobRow>` that backs the WebSocket fan-out is empty
  at startup. Each new WebSocket connection gets a fresh `snapshot` event
  built from `listActiveJobs()` (rows with status `queued` or `running` in
  SQLite).
- The downloader keeps running. `GET /jobs` on the downloader returns its
  in-memory snapshot, and any subsequent SSE events flow back through the
  reconnected web service into SQLite.
- Rows that were `running` in SQLite at shutdown but whose downloader job has
  since terminated (or whose downloader has itself restarted) end up
  **orphaned**. Today **no reconciliation logic is implemented**: a stuck
  `running` row will sit there forever unless cleaned up manually
  (e.g. `UPDATE jobs SET status = 'failed' WHERE …`). This is a known
  limitation and a candidate for a future startup hook.

## Volume layout

| Host path | Mounted at | In which service | Notes |
|---|---|---|---|
| `./downloads` | `/downloads` | web (rw), downloader (rw) | Finished files. Flat layout. |
| `./cookies` | `/cookies` | web (rw), downloader (**ro**) | Per-domain Netscape cookie files. |
| `./data` | `/data` | web (rw) | SQLite database (`app.db`) plus WAL files. |
| `./tailscale-state` | `/var/lib/tailscale` | tailscale | Tailscale node state. Only with the override. |

## Networking

Without the override, `docker compose up` creates the default bridge network.
The `web` service publishes `${WEB_PORT:-3000}:3000` on the host; the
`downloader` is reachable only as `http://downloader:8080` from inside the
network.

With the Tailscale override (`docker-compose.tailscale.yml`):

- `web` uses `network_mode: service:tailscale` — it joins the Tailscale
  container's network namespace, so its listening port is reachable via the
  tailnet (HTTPS termination is done by `tailscale serve` against
  `127.0.0.1:3000`).
- `web`'s `ports:` are reset (`ports: !reset []`), so nothing is published
  on the host.
- The `downloader` stays on the default bridge network. `web` still reaches
  it as `http://downloader:8080` because the Docker DNS resolves the service
  name even from inside the Tailscale container's netns.
