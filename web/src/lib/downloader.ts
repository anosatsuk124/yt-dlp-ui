import { DOWNLOADER_URL } from "./env";
import { downloaderFetch } from "./transport";
import type { AuthOptions } from "./auth";

export interface EnqueuePayload {
  id: string;
  url: string;
  format: string;
  container?: string;
  compat?: string;
  extraArgs?: string[];
  cookiesFile?: string;
  // Replaces the %(title)s portion of the output filename (save-as override).
  outputName?: string;
  // Auth fields are flattened onto the Job struct on the Go side. We send
  // them at the top level (rather than nested under an "auth" key) so the
  // downloader struct stays flat and back-compat: missing fields decode to
  // their zero value and the argv builder skips them.
  auth?: AuthOptions;
}

export async function postJob(payload: EnqueuePayload): Promise<void> {
  // Flatten the auth bag onto the top-level body — see the comment on
  // EnqueuePayload above.
  const { auth, ...rest } = payload;
  const body = { ...rest, ...(auth ?? {}) };
  const res = await downloaderFetch(`${DOWNLOADER_URL}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 202) {
    const txt = await res.text().catch(() => "");
    throw new Error(`downloader POST /jobs ${res.status}: ${txt}`);
  }
}

// One entry of an enumerated playlist (a concrete, single-video URL).
export interface ResolveEntry {
  url: string;
  id?: string;
  title?: string;
}

export interface ResolveResult {
  isPlaylist: boolean;
  playlistTitle?: string;
  entries?: ResolveEntry[];
  // For a single (non-playlist) URL: yt-dlp's resolved webpage_url, so the
  // caller can enqueue the canonical page instead of an opaque short link.
  canonicalUrl?: string;
  title?: string;
  // Season metadata for the single-video case (regroup-seasons maintenance).
  season?: string;
  seasonNumber?: string;
}

// Ask the downloader whether a URL is a playlist and, if so, enumerate its
// entries (it has yt-dlp; the web container does not). Carries the same
// cookies/auth a download would so private playlists resolve. Throws on a
// downloader/extractor error so the caller can fall back to a single job.
export async function resolvePlaylist(payload: {
  url: string;
  cookiesFile?: string;
  // Forwarded so list-limiting flags (--playlist-items, --playlist-start/end,
  // --match-filter, an explicit --no-playlist, …) apply during enumeration —
  // the per-entry jobs run with --no-playlist, so limiting must happen here.
  extraArgs?: string[];
  auth?: AuthOptions;
}): Promise<ResolveResult> {
  const { auth, ...rest } = payload;
  const body = { ...rest, ...(auth ?? {}) };
  const res = await fetch(`${DOWNLOADER_URL}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`downloader POST /resolve ${res.status}: ${txt}`);
  }
  return (await res.json()) as ResolveResult;
}

export async function cancelJob(id: string): Promise<void> {
  const res = await downloaderFetch(`${DOWNLOADER_URL}/jobs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`downloader DELETE /jobs/${id} ${res.status}`);
  }
}

export interface DownloaderConfig {
  maxParallel?: number;
  downloadDir?: string;
}

export async function patchConfig(config: DownloaderConfig): Promise<void> {
  const res = await downloaderFetch(`${DOWNLOADER_URL}/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    throw new Error(`downloader PATCH /config ${res.status}`);
  }
}

export interface DownloaderJobSnapshot {
  id: string;
  url: string;
  format: string;
  status: string;
  progress: number;
  speed?: string;
  eta?: string;
  filePath?: string;
  title?: string;
  error?: string;
}

export async function getJobs(): Promise<DownloaderJobSnapshot[]> {
  const res = await downloaderFetch(`${DOWNLOADER_URL}/jobs`);
  if (!res.ok) throw new Error(`downloader GET /jobs ${res.status}`);
  const body = await res.json() as { jobs?: DownloaderJobSnapshot[] };
  return body.jobs ?? [];
}

// Shell-split a free-form "advanced args" string the same way a POSIX shell
// would, so users can write something like: --write-subs --sub-lang "en,en-US"
// Borrowed: minimal shlex-style. Throws on unterminated quotes.
export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (escape) { cur += c; escape = false; continue; }
    if (c === "\\" && quote !== "'") { escape = true; continue; }
    if (quote) {
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else {
      if (c === '"' || c === "'") { quote = c; continue; }
      if (/\s/.test(c)) {
        if (cur.length) { out.push(cur); cur = ""; }
        continue;
      }
      cur += c;
    }
  }
  if (quote) throw new Error("unterminated quote in advanced args");
  if (cur.length) out.push(cur);
  return out;
}
