# Progress Log

Rolling notes on implementation status. Newest entries at the top.

## 2026-05-24

### Implementation pass

- Downloader service: implemented (`downloader/cmd/downloader/main.go`,
  stdlib-only, single file: worker pool, SSE bus, yt-dlp progress parser,
  signal-based cancellation).
- Web data layer + REST APIs: implemented (`web/src/lib/*`,
  `web/src/app/api/**`). SQLite via `better-sqlite3`, idempotent schema,
  per-domain cookie resolution, format presets, shell-split for advanced
  args.
- Custom Next.js server with WebSocket fan-out + SSE consumer: implemented
  (`web/server.ts`, `web/src/lib/ws-hub.ts`). Per-job 2 s progress write
  throttle; status transitions persisted immediately.
- UI pages — Queue / History / Cookies / Settings: implemented under
  `web/src/app/{queue,history,cookies,settings}/page.tsx`.
- Containerisation: `web/Dockerfile`, `downloader/Dockerfile`,
  `docker-compose.yml`, and `docker-compose.tailscale.yml` implemented. Both
  compose configs pass `docker compose config`.
- Documentation fill-out: `README.md`, `docs/architecture.md`,
  `docs/api.md`, `docs/design-progress-protocol.md` rewritten from
  skeletons.

### Local verification (no Docker)

Both services were run directly on the host (the host's Docker daemon
has a broken containerd shim — `docker run hello-world` fails with
`unsupported protocol: Yunix` — so the image build could not be
exercised on this machine; this is a host-environment problem, not a
project problem, and `docker compose config` already passes against
both compose files).

End-to-end smoke test confirmed working:

- `go run ./cmd/downloader` starts cleanly, `/healthz` returns `OK`,
  `/jobs` returns an empty list.
- `POST /jobs` on the downloader accepts a job, emits the expected SSE
  sequence `queued → running → failed` (failure is from yt-dlp's own
  DNS resolution against an invalid host).
- `npm start` brings up the Next.js custom server, creates the SQLite
  DB on first call, and `/api/jobs`, `/api/cookies`, `/api/settings`
  all return their initial state.
- `POST /api/jobs` round-trips through the SSE consumer: the job lands
  in the DB, transitions to `failed`, and shows up in `/api/history`
  with the captured stderr.
- `POST /api/cookies` (multipart) writes `cookies/<domain>.txt` with
  mode 0600, the GET lists it, and `DELETE /api/cookies/<domain>`
  removes it.

### Remaining

- A real successful download (skipped here — requires network and a
  known-good URL the user trusts; the failure path is fully exercised
  above and the success path uses the same plumbing).
- Building the images on a host with a working Docker runtime.
- Startup reconciliation for orphaned `running` rows (flagged as a
  known limitation in `architecture.md`).

### Initial planning

- Architecture confirmed with the user:
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
