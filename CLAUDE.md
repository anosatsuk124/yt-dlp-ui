# CLAUDE.md

Working notes for this repo. See [docs/architecture.md](docs/architecture.md)
for the full picture.

## Web ↔ downloader calls: always use `downloaderFetch`

The same Go/Next.js code backs two deployments:

- **Docker** — the downloader listens on TCP (`DOWNLOADER_URL`,
  `http://downloader:8080`).
- **Native desktop (Tauri)** — the downloader listens on a **Unix domain socket**
  (Linux/macOS) or **Windows named pipe** (`DOWNLOADER_SOCKET`) and **opens no TCP
  port**. Behaviour is gated purely on `DOWNLOADER_SOCKET` / `WEB_SOCKET`.

Every call from the web layer to the Go downloader **must** go through
`downloaderFetch` (`web/src/lib/transport.ts`), never the global `fetch`.
`downloaderFetch` routes the request through an undici dispatcher bound to
`DOWNLOADER_SOCKET` when it is set, and falls back to plain TCP when it is not —
so it is correct in **both** modes.

A bare global `fetch` ignores the socket dispatcher: in the native build it tries
to reach `http://downloader:8080` over TCP/DNS, which does not exist, and fails
with the generic `fetch failed`. This once broke `POST /resolve` (and therefore
every download) in the desktop app while Docker stayed fine.

The downloader helpers all live in `web/src/lib/downloader.ts` — `postJob`,
`cancelJob`, `patchConfig`, `getJobs`, `resolvePlaylist`. When adding another,
copy the `downloaderFetch` pattern.

## Docs

Natural-language text in docs is written in English (even when the working
language of a session is not), to keep the project consistent for all readers.
