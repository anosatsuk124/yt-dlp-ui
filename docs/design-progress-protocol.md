# Progress Protocol

How progress information flows from `yt-dlp` (CLI) to the browser:

```
yt-dlp stdout  ──parser──▶  Go event  ──SSE──▶  Next.js  ──WS──▶  Browser
```

Everything below is what `downloader/cmd/downloader/main.go` and
`web/server.ts` actually do — not aspirational design.

## `yt-dlp` invocation

`buildArgs` in `main.go` constructs the argv. For a job
`{ id, url, format, extraArgs, cookiesFile }` it builds:

```
yt-dlp \
  --newline --no-color --progress \
  --progress-template "PROGRESS %(progress.downloaded_bytes)s/%(progress.total_bytes)s %(progress.speed)s %(progress.eta)s %(progress.status)s" \
  <preset-flags> \
  [--cookies <cookiesFile>] \
  -o "<DOWNLOAD_DIR>/%(title).200B [%(id)s].%(ext)s" \
  [<extraArgs>...] \
  <url>
```

Preset → `-f` selector:

| Preset | `-f` argv |
|---|---|
| `best` (and empty) | `-f bv*+ba/b` |
| `1080p` | `-f bv*[height<=1080]+ba/b[height<=1080]` |
| `720p` | `-f bv*[height<=720]+ba/b[height<=720]` |
| `audio` | `-f ba/b -x --audio-format mp3` |
| anything else | passed through verbatim as the value of `-f` |

`--newline` guarantees one line per progress tick; `--no-color` strips ANSI
so the parser never has to deal with escape sequences; `--progress-template`
locks the format the parser depends on. The process is started in its own
process group (`Setpgid: true`) so cancellation can SIGINT/SIGKILL the whole
`yt-dlp` + `ffmpeg` tree.

## Parser rules

The downloader reads `stdout` line-by-line with a `bufio.Scanner` whose
buffer is grown to **1 MB** (`sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)`)
so an unusually long line — typically a long destination path — does not
silently truncate.

Five line shapes are recognised:

1. **`PROGRESS <down>/<total> <speed> <eta> <status>`** — five
   space-separated fields. The first is split on `/`. `NA` and empty values
   are coerced to `0`. `progress = down/total*100` if `total > 0`, else `0`.
   Emits a `progress` event with `downloaded`, `total`, `progress`, `speed`,
   `eta`.
2. **`[download] Destination: <path>`** — captures the (possibly
   intermediate) output path into an `atomic.Value`.
3. **`[Merger] Merging formats into "<path>"`** — replaces the captured
   path with the merged final path. Surrounding quotes are stripped.
4. **`[ExtractAudio] Destination: <path>`** — replaces the captured path
   with the final audio file (audio preset).
5. Anything else — appended to the rolling stderr buffer for error context.

`stderr` is read in parallel by a second goroutine with the same 1 MB
scanner buffer and appended to the same rolling buffer.

## Stderr buffer

`rollingBuf` keeps the **last 4 KB** (`errBufCap = 4096`) of combined
non-progress output, oldest bytes evicted first. On a non-zero `yt-dlp`
exit, the trimmed contents of this buffer become the `error` field of the
terminal `failed` event (and the `error` column in the database). If the
buffer is empty, the error defaults to `"yt-dlp exited with non-zero
status"`.

## SSE frame shape (downloader → web)

Each frame is a single `data: <json>\n\n` line, where `<json>` is one of:

```json
{ "type": "status", "id": "<id>", "status": "queued" }
{ "type": "status", "id": "<id>", "status": "running" }
{ "type": "progress", "id": "<id>", "progress": 42.5, "speed": "1.2MiB/s", "eta": "00:42", "downloaded": 1234567, "total": 9876543 }
{ "type": "status", "id": "<id>", "status": "completed", "filePath": "/downloads/Sample [dQw4w9WgXcQ].mp4" }
{ "type": "status", "id": "<id>", "status": "failed", "error": "HTTP Error 403: Forbidden" }
{ "type": "status", "id": "<id>", "status": "canceled" }
```

Heartbeats are sent as comment frames (`:\n\n`) on connect and every 15 s,
so reverse proxies that idle-out silent streams keep the connection open.

## WS frame shape (web → browser)

The custom server forwards every downloader SSE event verbatim to every
connected WebSocket client and adds one synthetic frame, `snapshot`, sent
once per client immediately after connect. The browser hook
(`use-jobs-ws.ts`) handles exactly four `type` values:

```json
{ "type": "snapshot", "jobs": [ /* listActiveJobs() output */ ] }
{ "type": "progress", "id": "<id>", "progress": 42.5, "speed": "1.2MiB/s", "eta": "00:42", "downloaded": 1234567, "total": 9876543 }
{ "type": "status",   "id": "<id>", "status": "running" }
{ "type": "title",    "id": "<id>", "title": "Sample video" }
```

`status: completed|failed|canceled` frames are still delivered; the browser
removes the job from its active map on receipt (history is fetched
separately).

## Throttling

- **WebSocket fan-out:** every event is forwarded immediately. No throttling
  client-side beyond what the browser's rendering loop coalesces.
- **DB writes for `progress` events:** throttled per-job to roughly one
  write every `DB_WRITE_THROTTLE_MS = 2000` (server.ts). Intermediate
  progress events are dropped from the DB but still reach all clients live.
- **DB writes for `status` events:** always persisted immediately, including
  setting `started_at` (on `running`), `finished_at` (on terminal states),
  `file_path` (on `completed`), and `error` (on `failed`). The
  per-job throttle bookkeeping for that ID is cleared at the same time.
