# Progress Protocol

How progress information flows from `yt-dlp` (CLI) to the browser.

```
yt-dlp stdout  ──parser──▶  Go event  ──SSE──▶  Next.js  ──WS──▶  Browser
```

## yt-dlp invocation

```
yt-dlp \
  --newline --no-color --progress \
  --progress-template "PROGRESS %(progress.downloaded_bytes)s/%(progress.total_bytes)s %(progress.speed)s %(progress.eta)s %(progress.status)s" \
  -f "<from preset>" \
  [--cookies /cookies/<domain>.txt] \
  -o "/downloads/%(title).200B [%(id)s].%(ext)s" \
  "<url>"
```

`--newline` ensures one line per progress event; `--progress-template`
fixes the format so the Go parser is unambiguous.

## Parser rules (Go side)

- Lines starting with `PROGRESS ` are split into 5 fields:
  `downloaded_bytes/total_bytes speed eta status`. Convert to numeric, build
  a progress event.
- Lines starting with `[download] Destination: <path>` or
  `[Merger] Merging formats into "<path>"` capture the final output path.
- All other stdout/stderr is buffered; on non-zero exit, the last 4 KB of
  stderr is included in a `failed` event.

## SSE event shape (downloader → web)

```json
{ "type": "progress", "id": "...", "progress": 42.5, "speed": "1.2MiB/s", "eta": "00:42" }
{ "type": "status",   "id": "...", "status": "running" }
{ "type": "status",   "id": "...", "status": "completed", "filePath": "..." }
{ "type": "status",   "id": "...", "status": "failed", "error": "..." }
```

## WebSocket frame shape (web → browser)

```json
{ "type": "snapshot", "jobs": [ … ] }
{ "type": "progress", "id": "...", "progress": 42.5, "speed": "1.2MiB/s", "eta": "00:42" }
{ "type": "status",   "id": "...", "status": "completed", "filePath": "..." }
```

Progress events are forwarded every tick; DB writes are throttled to ~2 s
per job (status transitions always persist immediately).
