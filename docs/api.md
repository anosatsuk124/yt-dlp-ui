# API

> Skeleton — full request/response examples added during the API phase.

## Web service (Next.js)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/jobs` | Enqueue one or more URLs. |
| `GET` | `/api/jobs` | List active (`queued` + `running`) jobs. |
| `DELETE` | `/api/jobs/:id` | Cancel a job. |
| `GET` | `/api/history` | Paginated list of finished jobs. |
| `GET` | `/api/files/:name` | Stream a finished file from `DOWNLOAD_DIR`. |
| `GET` | `/api/cookies` | List uploaded cookie domains. |
| `POST` | `/api/cookies` | Upload a `cookies.txt` for a domain (multipart). |
| `DELETE` | `/api/cookies/:domain` | Remove an uploaded cookies file. |
| `GET` `PUT` | `/api/settings` | Runtime settings (default preset, max-parallel proxy). |
| `WS` | `/api/ws` | Progress fan-out (`snapshot`, `progress`, `status` frames). |

## Downloader service (Go)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/jobs` | Enqueue a job (called by the web service). |
| `DELETE` | `/jobs/:id` | Cancel a job. |
| `GET` | `/jobs` | In-memory snapshot of current jobs. |
| `GET` | `/events` | Server-Sent Events stream of progress + status updates. |
| `PATCH` | `/config` | Resize the worker pool at runtime. |
| `GET` | `/healthz` | Liveness probe. |
