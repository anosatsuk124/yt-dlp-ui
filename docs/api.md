# API

Two services expose HTTP endpoints. Everything documented here is what the
code actually does — endpoint shapes were lifted from
`web/src/app/api/**/*.ts`, `web/server.ts`, and
`downloader/cmd/downloader/main.go`.

- The **web** service (Next.js, port `3000`) is the public surface, including
  the WebSocket at `/api/ws`.
- The **downloader** service (Go, port `8080`) is **internal**: only the web
  service should call it.

JSON request/response shapes use TypeScript-ish notation. Timestamps are
Unix-millisecond integers. Job IDs are UUIDv4 strings minted by the web
service.

---

## Web service (Next.js, port 3000)

### `POST /api/jobs` — enqueue one or more URLs

Source: `web/src/app/api/jobs/route.ts`.

Request:

```json
{
  "urls": ["https://www.youtube.com/watch?v=…"],
  "format": "best",
  "extraArgs": "--write-subs --sub-lang \"en,en-US\""
}
```

- `urls` (required): non-empty array. Each must match `^https?://`.
- `format` (required): one of `"best" | "1080p" | "720p" | "audio"`.
- `extraArgs` (optional): free-form string, shell-split server-side and
  appended to the `yt-dlp` argv. Unterminated quotes are a 400.

Response (`201 Created`):

```json
{ "jobs": [ { "id": "f1a4…-…-…", "url": "https://…" } ] }
```

Errors:

- `400` — `no urls`, `invalid format`, `invalid url: …`, `invalid json`, or
  a shell-split error message.
- `502` — `downloader unreachable: …`. The job row is inserted then marked
  `failed` before the response is returned.

### `GET /api/jobs` — list active jobs

Returns rows with `status IN ('queued','running')`, ordered by `created_at`
ascending. Used by the Queue page as the initial render and as a fallback
when the WebSocket isn't connected.

```json
{
  "jobs": [
    {
      "id": "f1a4…",
      "url": "https://…",
      "format": "1080p",
      "extra_args": null,
      "cookies_file": "/cookies/youtube.com.txt",
      "status": "running",
      "progress": 37.2,
      "speed": "1.5MiB/s",
      "eta": "00:42",
      "title": "Sample video",
      "file_path": null,
      "error": null,
      "created_at": 1716540000000,
      "started_at": 1716540001234,
      "finished_at": null
    }
  ]
}
```

### `DELETE /api/jobs/:id` — cancel

Source: `web/src/app/api/jobs/[id]/route.ts`. Returns `204 No Content` on
success, `404` if the row doesn't exist, `502` if the downloader call fails.

```
DELETE /api/jobs/f1a4… HTTP/1.1
→ 204 No Content
```

### `GET /api/history?limit=&offset=` — finished jobs

Source: `web/src/app/api/history/route.ts`. Pagination defaults: `limit=50`,
`offset=0`. `limit` is capped at `200`.

```json
{
  "jobs": [ { /* same row shape as /api/jobs, statuses in completed/failed/canceled */ } ],
  "total": 137
}
```

Example:

```
GET /api/history?limit=20&offset=40
```

### `GET /api/files/:name` — stream a finished file

Source: `web/src/app/api/files/[name]/route.ts`. `name` is the basename
(`path.basename`) of the file inside `DOWNLOAD_DIR`. Path-traversal
characters (`/`, `..`, `\`) return `403`. Content-Type is guessed from the
extension (`.mp4`, `.webm`, `.mkv`, `.mp3`, `.m4a`, `.opus`, `.wav`,
`.flac`, `.vtt`, `.srt`, else `application/octet-stream`). The response is
a streamed body with `Content-Disposition: attachment` and the original
filename.

```
GET /api/files/Sample%20video%20%5BdQw4w9WgXcQ%5D.mp4
→ 200 OK
  content-type: video/mp4
  content-length: 12345678
  content-disposition: attachment; filename*=UTF-8''Sample%20video%20%5BdQw4w9WgXcQ%5D.mp4
  <binary body>
```

### `GET /api/cookies` — list uploaded cookie domains

Source: `web/src/app/api/cookies/route.ts`.

```json
{
  "cookies": [
    { "domain": "example.com", "size": 1024, "mtime": 1716530000000 }
  ]
}
```

### `POST /api/cookies` — upload `cookies.txt` for a domain

`multipart/form-data` with fields:

- `domain`: lowercase DNS name (e.g. `example.com`). Validated against
  `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/`.
- `file`: a Netscape-format cookies file. The server rejects anything whose
  first 512 bytes don't match `# Netscape HTTP Cookie File` or
  `# HTTP Cookie File`.

Response (`201 Created`):

```json
{ "ok": true, "domain": "example.com" }
```

Errors: `400 invalid domain`, `400 missing file`, `400 not a Netscape
cookies.txt — must start with '# Netscape HTTP Cookie File' or '# HTTP Cookie File'`,
`400 expected multipart/form-data`.

Example with `curl`:

```bash
curl -X POST http://localhost:3000/api/cookies \
  -F domain=example.com \
  -F file=@cookies.txt
```

### `DELETE /api/cookies/:domain` — remove a cookies file

`:domain` is URL-encoded. Returns `204` on success, `404 not found` if no
such file, `400 invalid domain` on bad input.

```
DELETE /api/cookies/example.com
→ 204 No Content
```

### `GET /api/settings` — read settings

```json
{ "defaultFormat": "best", "maxParallel": 2 }
```

`defaultFormat` is the preset key remembered for the Queue form; `maxParallel`
is the last value the web service proxied to the downloader.

### `PUT /api/settings` — update settings

```json
{ "defaultFormat": "1080p", "maxParallel": 4 }
```

Both fields are optional. `maxParallel` must be an integer in `[1, 32]`. When
set, the new value is persisted in SQLite and `PATCH /config` is forwarded to
the downloader. A downloader failure returns `502 downloader: <message>`;
otherwise:

```json
{ "ok": true }
```

### `WS /api/ws` — live progress fan-out

Source: `web/server.ts` and `web/src/lib/use-jobs-ws.ts`. The first frame a
client receives after connecting is always a `snapshot`. Four event types
are emitted thereafter:

```json
{ "type": "snapshot", "jobs": [ /* JobRow[], see /api/jobs */ ] }
{ "type": "progress", "id": "f1a4…", "progress": 42.5, "speed": "1.2MiB/s", "eta": "00:42", "downloaded": 1234567, "total": 9876543 }
{ "type": "status",   "id": "f1a4…", "status": "running" }
{ "type": "status",   "id": "f1a4…", "status": "completed", "filePath": "/downloads/Sample [dQw4w9WgXcQ].mp4" }
{ "type": "status",   "id": "f1a4…", "status": "failed", "error": "HTTP Error 403: Forbidden" }
{ "type": "title",    "id": "f1a4…", "title": "Sample video" }
```

The browser hook drops a job from its active map as soon as it receives a
terminal `status` (`completed | failed | canceled`); those rows are
fetched from `/api/history` instead. Reconnects use exponential backoff
(500 ms → 1 s → 2 s → 4 s, capped at 10 s).

---

## Downloader service (Go, port 8080, internal only)

Source: `downloader/cmd/downloader/main.go`. The web service is the only
caller in normal operation.

### `POST /jobs` — enqueue

```json
{
  "id": "f1a4…",
  "url": "https://…",
  "format": "1080p",
  "extraArgs": ["--write-subs"],
  "cookiesFile": "/cookies/example.com.txt"
}
```

`id` and `url` are required. `format` is one of the preset keys; anything
else is passed through verbatim to `yt-dlp -f`. Response:

```json
{ "id": "f1a4…", "status": "queued" }
```

`HTTP 202 Accepted`. `409 Conflict` if the ID already exists in the registry.

### `DELETE /jobs/:id` — cancel

`204 No Content`. For a `queued` job, the registry is updated to `canceled`
immediately. For a `running` job, the process group is sent SIGINT (then
SIGKILL after 3 s).

### `GET /jobs` — in-memory snapshot

```json
{
  "jobs": [
    {
      "id": "f1a4…", "url": "https://…", "format": "1080p",
      "extraArgs": ["--write-subs"],
      "cookiesFile": "/cookies/example.com.txt",
      "status": "running", "progress": 42.5,
      "speed": "1.2MiB/s", "eta": "00:42",
      "filePath": "", "title": "",
      "startedAt": "2026-05-24T10:11:12Z", "endedAt": "0001-01-01T00:00:00Z"
    }
  ]
}
```

Only what the downloader currently has in memory (active jobs plus a ring
buffer of the last 50 finished). Use the web service's `/api/history` for
the durable record.

### `GET /events` — Server-Sent Events

Live progress and status stream. Each event is a JSON object on a single
`data: …` line. A `:\n\n` heartbeat is sent on connect and every 15 s.

```
data: {"type":"status","id":"f1a4…","status":"running"}

data: {"type":"progress","id":"f1a4…","progress":42.5,"speed":"1.2MiB/s","eta":"00:42","downloaded":1234567,"total":9876543}

data: {"type":"status","id":"f1a4…","status":"completed","filePath":"/downloads/Sample [dQw4w9WgXcQ].mp4"}
```

Slow consumers do not block the publisher: the per-subscriber buffer drops
the oldest event when full.

### `PATCH /config` — resize the worker pool

```json
{ "maxParallel": 4 }
```

`maxParallel` must be `>= 1`. The pool is drained and restarted at the new
size; in-flight jobs are **not** canceled — they finish naturally under
their own contexts. Response:

```json
{ "maxParallel": 4 }
```

### `GET /healthz` — liveness

```
GET /healthz
→ 200 OK
   content-type: text/plain; charset=utf-8

   OK
```

---

The downloader has no authentication and assumes a trusted caller on the
compose network. It must not be published to the host, exposed via Tailscale,
or otherwise reachable from outside the docker network — the web service is
the only sanctioned client.
