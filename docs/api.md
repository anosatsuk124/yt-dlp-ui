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
  "selections": [
    { "format": "best",       "containers": ["mp4", "mkv"] },
    { "format": "audio-best", "containers": ["mp3", "flac"] }
  ],
  "compat": "auto",
  "extraArgs": "--write-subs --sub-lang \"en,en-US\"",
  "resolution": "append",
  "saveAsNames": { "https://…|best|mp4": "My custom name" },
  "auth": {
    "username": "me",
    "password": "secret",
    "twoFactor": "123456",
    "videoPassword": "…",
    "apMso": "DTV",
    "apUsername": "…",
    "apPassword": "…",
    "clientCertFile": "client.cert.pem",
    "clientCertKeyFile": "client.key.pem",
    "clientCertPassword": "…"
  }
}
```

- `urls` (required): non-empty array. Each must match `^https?://`. A playlist
  URL (YouTube playlist, AbemaTV series, …) is detected up front via the
  downloader's `POST /resolve` and expanded into one entry URL per video, so the
  request fans out to one job per `entry × format × container` rather than
  downloading only the first video. Each resulting job is tagged with the
  playlist title, which routes its MEGA upload to `playlists/<title>/` (see
  `POST /resolve`). If resolution fails (extractor error, downloader
  unreachable) the URL is enqueued as a single download.
- `selections` (required): non-empty array of `{ format, containers[] }`. The
  request expands to one job per `url × format × container`. `format` is one of
  `"best" | "1080p" | "720p" | "audio-best"`. For video formats `containers`
  are `"auto" | "mp4" | "mkv" | "webm" | "mov"`; for `audio-best` they are the
  output codecs `"mp3" | "wav" | "flac"`. A format with an empty `containers`
  list is skipped.
- `compat` (optional): `"auto" | "ios"`. Applies to video formats only; audio
  ignores it. `ios` forces MP4 + H.264/AAC.
- `extraArgs` (optional): free-form string, shell-split server-side and
  appended to the `yt-dlp` argv. Unterminated quotes are a 400.
- `resolution` (optional): how to resolve identity conflicts (same
  url+format+container already completed/uploaded) — `"append"` (download
  anyway; coexists via content hash), `"overwrite"` (delete the old entry
  locally + on MEGA + its DB row, then re-download), `"save-as"` (keep the old
  entry; the new download uses a custom name), `"cancel"` (skip the conflicting
  combos). When omitted and a conflict exists, the request returns **409**
  (see below) and creates nothing.
- `saveAsNames` (optional): map of `"<url>|<format>|<container>"` → custom name,
  used when `resolution` is `"save-as"`.
- `auth` (optional): per-job credentials forwarded as the corresponding
  yt-dlp flags (`--username`, `--password`, `--twofactor`,
  `--video-password`, `--ap-mso`, `--ap-username`, `--ap-password`,
  `--client-certificate`, `--client-certificate-key`,
  `--client-certificate-password`). Every field is optional. Per-job
  values override the per-domain binding stored at `/api/auth/:domain`
  field-by-field; empty/missing fields fall through to the binding.
  `clientCertFile` / `clientCertKeyFile` accept a basename of a file
  uploaded to `/api/certs` (e.g. `client.cert.pem`); the server resolves
  it to an absolute container path before forwarding. A reference to a
  missing cert is a 400.

Response (`201 Created`):

```json
{
  "jobs":    [ { "id": "f1a4…", "url": "https://…", "format": "best", "container": "mp4" } ],
  "skipped": [ { "url": "https://…", "format": "best", "container": "mkv" } ]
}
```

Conflict (`409 Conflict`, only when `resolution` is omitted and an identity
already exists):

```json
{
  "conflicts": [
    { "url": "https://…", "format": "best", "container": "mp4",
      "existingId": "old-job-id", "title": "Sample video" }
  ]
}
```

The client re-submits the same body with a `resolution` (and `saveAsNames`
when saving as) to proceed.

Errors:

- `400` — `no urls`, `no selections`, `invalid format: …`,
  `invalid container '…' for format '…'`, `invalid url: …`, `invalid json`, or
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

### `GET /api/auth` — list per-domain credential bindings

Source: `web/src/app/api/auth/route.ts`. Returns one row per saved
binding, **redacted**: secret fields are reported as `has*` booleans only;
plaintext values are never echoed.

```json
{
  "bindings": [
    {
      "domain": "example.com",
      "username": "me",
      "apMso": "DTV",
      "apUsername": "tv-user",
      "clientCertFile": "/certs/example.cert.pem",
      "clientCertKeyFile": "/certs/example.key.pem",
      "hasPassword": true,
      "hasVideoPassword": false,
      "hasApPassword": true,
      "hasClientCertPassword": true,
      "createdAt": 1716540000000,
      "updatedAt": 1716541000000
    }
  ]
}
```

### `GET /api/auth/:domain` — read one binding (redacted)

Same shape as a row above, wrapped in `{ "binding": … }`. `404 not found`
if no binding exists. `400 invalid domain` on bad input.

### `PUT /api/auth/:domain` — upsert a binding

```json
{
  "username": "me",
  "password": "secret",
  "videoPassword": "…",
  "apMso": "DTV",
  "apUsername": "…",
  "apPassword": "…",
  "clientCertFile": "example.cert.pem",
  "clientCertKeyFile": "example.key.pem",
  "clientCertPassword": "…"
}
```

All fields are optional. A missing or empty field keeps the previously
stored value (so the UI can re-save other fields without re-typing the
password). An explicit `null` clears the field. `clientCertFile` /
`clientCertKeyFile` accept basenames; the server resolves them to
absolute container paths and returns 400 if the file is not present
under `CERTS_DIR`. Response is the redacted binding (same shape as
`GET`).

### `DELETE /api/auth/:domain` — remove a binding

`204 No Content` on success, `404 not found` if no binding exists.

### `GET /api/certs` — list uploaded PEM files

Source: `web/src/app/api/certs/route.ts`. Lists `*.pem`, `*.crt`, `*.cer`,
`*.key` files under `CERTS_DIR`.

```json
{
  "certs": [
    {
      "name": "example.cert.pem",
      "size": 2048,
      "mtime": 1716530000000,
      "path": "/certs/example.cert.pem"
    }
  ]
}
```

### `POST /api/certs` — upload a PEM file

`multipart/form-data` with fields:

- `name`: filename. Must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and
  end in `.pem`, `.crt`, `.cer`, or `.key`. Path-traversal characters and
  `..` are rejected with 400.
- `file`: a PEM-encoded certificate or private key. The first 256 bytes
  must contain `-----BEGIN …-----`.

Response (`201 Created`):

```json
{ "ok": true, "name": "example.cert.pem", "path": "/certs/example.cert.pem" }
```

Errors: `400 invalid name (…)`, `400 missing file`, `400 not a PEM file
— first bytes must contain '-----BEGIN ...'`, `400 expected
multipart/form-data`.

### `DELETE /api/certs/:name` — remove a PEM file

`:name` is URL-encoded. Returns `204` on success, `404 not found`,
`400 invalid name` on bad input.

### `GET /api/settings` — read settings

```json
{
  "defaultFormat": "best",
  "maxParallel": 2,
  "mega": {
    "enabled": false,
    "email": "",
    "hasPassword": false,
    "folder": "/yt-dlp-ui",
    "audioSubdir": "audio",
    "maxParallel": 2
  }
}
```

`defaultFormat` is the preset key remembered for the Queue form; `maxParallel`
is the last value the web service proxied to the downloader. The `mega`
block reflects optional auto-upload settings — note that the password is
**never echoed back**; only a `hasPassword` boolean flags whether one is
stored.

### `PUT /api/settings` — update settings

```json
{
  "defaultFormat": "1080p",
  "maxParallel": 4,
  "mega": {
    "enabled": true,
    "email": "you@example.com",
    "password": "secret",
    "folder": "/yt-dlp-ui",
    "audioSubdir": "audio",
    "maxParallel": 2
  }
}
```

All top-level fields are optional. `maxParallel` must be an integer in
`[1, 32]`. When set, the new value is persisted in SQLite and `PATCH /config`
is forwarded to the downloader. `defaultContainer` accepts any video container
or audio codec key.

For `mega`: any subset of `enabled` / `email` / `password` / `folder` /
`audioSubdir` / `maxParallel` may be sent. A missing or empty `password` keeps
the previously stored value (so the UI can re-save other fields without
re-typing). The `folder` is forced to start with `/`; if blank, it falls back
to `/yt-dlp-ui`. `audioSubdir` is a relative path under `folder` (default
`audio`) where audio-only downloads are uploaded.

A downloader failure returns `502 downloader: <message>`; otherwise:

```json
{ "ok": true }
```

### Maintenance / Update tasks

Source: `web/src/app/api/maintenance/**`, `web/src/lib/maintenance/**`.

- `GET /api/maintenance` — `{ tasks: [{ id, title, description }], run | null }`.
- `POST /api/maintenance/:id/plan` — runs the task's `plan()` against live
  state and returns `{ task, steps: [{ id, description, jobId? }] }`. These are
  exactly the lines the confirm modal shows.
- `POST /api/maintenance/:id/run` — starts the task in the background
  (`202`, or `409` if one is already running). Re-plans at start time.
- `GET /api/maintenance/:id/status` — `{ run }` where `run` is
  `{ taskId, status: "running"|"done"|"error", total, done, current, log[], error }`.

Only one maintenance run executes at a time across all tasks.

### `WS /api/ws` — live progress fan-out

Source: `web/server.ts` and `web/src/lib/use-jobs-ws.ts`. The first frame a
client receives after connecting is always a `snapshot`. Four event types
are emitted thereafter:

```json
{ "type": "snapshot", "jobs": [ /* JobRow[], see /api/jobs */ ] }
{ "type": "progress", "id": "f1a4…", "progress": 42.5, "speed": "1.2MiB/s", "eta": "00:42", "downloaded": 1234567, "total": 9876543 }
{ "type": "status",   "id": "f1a4…", "status": "running" }
{ "type": "status",   "id": "f1a4…", "status": "completed", "filePath": "/downloads/best/mp4/Sample [dQw4w9WgXcQ].mp4" }
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
  "container": "mp4",
  "compat": "auto",
  "outputName": "My custom name",
  "extraArgs": ["--write-subs"],
  "cookiesFile": "/cookies/example.com.txt",
  "username": "me",
  "password": "secret",
  "twoFactor": "123456",
  "videoPassword": "…",
  "apMso": "DTV",
  "apUsername": "…",
  "apPassword": "…",
  "clientCertFile": "/certs/example.cert.pem",
  "clientCertKeyFile": "/certs/example.key.pem",
  "clientCertPassword": "…"
}
```

`id` and `url` are required. `format` is one of the preset keys
(`best | 1080p | 720p | audio-best`; the legacy `audio` is still accepted);
anything else is passed through verbatim to `yt-dlp -f`. For video formats
`container` maps to `--merge-output-format`; for audio formats it is the
`--audio-format` codec (`mp3 | wav | flac`, default `mp3`). `outputName`, when
set, replaces the title portion of the output filename (used by the "save as"
conflict resolution). Files are written to
`<downloads>/<format>/<container>/Title [id].ext` (the web side then appends a
`[#hash]` marker). The auth fields are flat on the `Job` struct (not nested);
each non-empty value is appended as the corresponding `yt-dlp` flag in
`buildArgs`. The downloader logs argv with the values of password-bearing flags
replaced by `"***"`, so service logs never contain plaintext secrets. Response:

```json
{ "id": "f1a4…", "status": "queued" }
```

`HTTP 202 Accepted`. `409 Conflict` if the ID already exists in the registry.

Every job runs with `--no-playlist`: each job is one concrete video (the web
side enumerates playlists via `POST /resolve` up front), so a stray
playlist/`&list=` URL can never fan out into many files under a single job and
break the one-file-per-job pipeline (title probe → FINAL_PROBE → hash → MEGA).

### `POST /resolve` — enumerate a (possibly playlist) URL

```json
{
  "url": "https://www.youtube.com/playlist?list=…",
  "cookiesFile": "/cookies/example.com.txt",
  "username": "me",
  "password": "secret"
}
```

Runs `yt-dlp --flat-playlist --dump-single-json` with the same cookies/auth
fields a job carries (all optional besides `url`). Used by the web side before
enqueueing to decide whether to fan a URL out into per-video jobs. Response:

```json
{
  "isPlaylist": true,
  "playlistTitle": "My Playlist",
  "entries": [
    { "url": "https://www.youtube.com/watch?v=…", "id": "…", "title": "Video 1" }
  ]
}
```

`isPlaylist` is `false` (with no `entries`) for a plain single-video URL. The
cookie jar is copied to a writable per-request temp (the `/cookies` mount is
read-only). `502 Bad Gateway` if `yt-dlp` errors or its output can't be parsed;
the caller treats that as "not a playlist" and enqueues the URL as-is.

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
