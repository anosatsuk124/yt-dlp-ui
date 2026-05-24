import { DOWNLOADER_URL } from "./env";

export interface EnqueuePayload {
  id: string;
  url: string;
  format: string;
  extraArgs?: string[];
  cookiesFile?: string;
}

export async function postJob(payload: EnqueuePayload): Promise<void> {
  const res = await fetch(`${DOWNLOADER_URL}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok && res.status !== 202) {
    const body = await res.text().catch(() => "");
    throw new Error(`downloader POST /jobs ${res.status}: ${body}`);
  }
}

export async function cancelJob(id: string): Promise<void> {
  const res = await fetch(`${DOWNLOADER_URL}/jobs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`downloader DELETE /jobs/${id} ${res.status}`);
  }
}

export async function patchConfig(maxParallel: number): Promise<void> {
  const res = await fetch(`${DOWNLOADER_URL}/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxParallel }),
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
  const res = await fetch(`${DOWNLOADER_URL}/jobs`);
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
