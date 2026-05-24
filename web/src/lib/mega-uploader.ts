// Background uploader that walks completed jobs and uploads each finished
// file to MEGA, then removes the local copy. Started once at server boot
// from server.ts; enqueueMegaUpload() is called from the SSE consumer
// when a job transitions to status='completed' and MEGA is enabled.
//
// The pool size is governed by the `mega_max_parallel` setting (default 2).
// Each worker opens its own MegaClient connection; megajs's `Storage` is
// session-scoped, so independent uploads from independent sessions don't
// step on each other.

import fs from "node:fs";
import {
  getJob,
  getSetting,
  listJobsPendingMegaUpload,
  markMegaCanceled,
  markMegaFailed,
  markMegaPending,
  markMegaUploaded,
  markMegaUploading,
  updateMegaProgress,
} from "./db";
import { MegaClient, loadMegaConfig } from "./mega";

// Next.js's App Router and the custom server.ts load lib modules through
// separate module graphs in some configurations, so plain module-scoped
// state (queue, in-flight controllers, worker count) ends up duplicated:
// the API route's mega-uploader instance is not the same as the one the
// worker pool is using. Hang the state off globalThis so both views agree.
interface MegaUploaderState {
  queue: string[];
  queued: Set<string>;
  activeUploads: Map<string, AbortController>;
  activeWorkers: number;
}
const G = globalThis as unknown as { __megaUploaderState?: MegaUploaderState };
if (!G.__megaUploaderState) {
  G.__megaUploaderState = {
    queue: [],
    queued: new Set<string>(),
    activeUploads: new Map<string, AbortController>(),
    activeWorkers: 0,
  };
}
const state: MegaUploaderState = G.__megaUploaderState;
const queue = state.queue;
const queued = state.queued;
const activeUploads = state.activeUploads;
const getActiveWorkers = () => state.activeWorkers;
const incActiveWorkers = () => { state.activeWorkers += 1; };
const decActiveWorkers = () => { state.activeWorkers -= 1; };

const PROGRESS_THROTTLE_MS = 1500;

function formatBytesPerSec(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "";
  const units = ["B/s", "KiB/s", "MiB/s", "GiB/s", "TiB/s"];
  let v = bps;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (v >= 100) return `${v.toFixed(0)} ${units[i]}`;
  if (v >= 10)  return `${v.toFixed(1)} ${units[i]}`;
  return `${v.toFixed(2)} ${units[i]}`;
}

function getMaxParallel(): number {
  const raw = parseInt(getSetting("mega_max_parallel") ?? "2", 10);
  return Math.min(Math.max(Number.isFinite(raw) ? raw : 2, 1), 8);
}

export function enqueueMegaUpload(jobId: string): void {
  if (queued.has(jobId)) return;
  queued.add(jobId);
  queue.push(jobId);
  spawnWorkers();
}

export function startMegaUploader(): void {
  const pending = listJobsPendingMegaUpload();
  if (pending.length > 0) {
    console.log(`[mega] recovering ${pending.length} pending upload(s)`);
    // Any row still tagged 'uploading' is from a previous process — its
    // megajs stream is gone. Reset it to 'pending' so the UI doesn't show
    // a stale progress bar; the worker will flip it back to 'uploading'
    // (with progress=0) when it actually picks the job up.
    for (const job of pending) {
      if (job.mega_status === "uploading") markMegaPending(job.id);
    }
    for (const job of pending) enqueueMegaUpload(job.id);
  }
}

function spawnWorkers(): void {
  const max = getMaxParallel();
  while (getActiveWorkers() < max && queue.length > 0) {
    void workerLoop(getActiveWorkers() + 1);
  }
}

async function workerLoop(workerId: number): Promise<void> {
  // Note: this increment runs synchronously before the first await, so
  // spawnWorkers's `getActiveWorkers() < max` check stays accurate as
  // workers are spawned in a tight loop.
  incActiveWorkers();
  try {
    while (queue.length > 0) {
      const cfg = loadMegaConfig();
      if (!cfg.enabled) {
        console.log(`[mega/w${workerId}] disabled; pausing queue`);
        return;
      }
      // Honour live changes to mega_max_parallel — if the setting was
      // reduced, the extra worker gracefully exits at the top of the loop.
      if (getActiveWorkers() > getMaxParallel()) {
        console.log(`[mega/w${workerId}] over limit; exiting`);
        return;
      }

      const client = new MegaClient();
      try {
        await client.connect(cfg.email, cfg.password);
        const folder = await client.ensureFolder(cfg.folder);
        // Drain as many items as we can with this connection.
        while (queue.length > 0) {
          if (getActiveWorkers() > getMaxParallel()) break;
          const id = queue.shift();
          if (!id) break;
          queued.delete(id);
          await processOne(id, client, folder, workerId);
        }
      } catch (e) {
        // Connect / ensureFolder failures only. processOne owns its own
        // failure marking. The queue is untouched here, so the next loop
        // iteration (or the next worker) will retry.
        const msg = (e as Error).message || String(e);
        console.error(`[mega/w${workerId}] worker error:`, msg);
      } finally {
        try { await client.disconnect(); } catch { /* ignore */ }
      }
    }
  } finally {
    decActiveWorkers();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processOne(jobId: string, client: MegaClient, folder: any, workerId: number): Promise<void> {
  const job = getJob(jobId);
  if (!job || !job.file_path) {
    console.log(`[mega/w${workerId}] skipping ${jobId}: job or file_path missing`);
    return;
  }
  // The user may have canceled it between enqueue and now.
  if (job.mega_status === "canceled") {
    console.log(`[mega/w${workerId}] ${jobId} was canceled before pickup`);
    return;
  }
  if (!fs.existsSync(job.file_path)) {
    markMegaFailed(jobId, "local file missing before upload");
    return;
  }

  const controller = new AbortController();
  activeUploads.set(jobId, controller);
  try {
    markMegaUploading(jobId);
    console.log(`[mega/w${workerId}] uploading ${jobId} -> ${job.file_path}`);
    let lastWrite = 0;
    let lastBytes = 0;
    let lastTime = Date.now();
    let ewmaBps = 0;
    await client.uploadFile(
      job.file_path,
      folder,
      (uploaded, total) => {
        const now = Date.now();
        const dt = now - lastTime;
        if (dt >= 250) {
          const instBps = ((uploaded - lastBytes) * 1000) / dt;
          ewmaBps = ewmaBps === 0 ? instBps : 0.7 * ewmaBps + 0.3 * instBps;
          lastBytes = uploaded;
          lastTime = now;
        }
        if (now - lastWrite < PROGRESS_THROTTLE_MS) return;
        lastWrite = now;
        const pct = total > 0 ? (uploaded / total) * 100 : 0;
        updateMegaProgress(jobId, pct, ewmaBps > 0 ? formatBytesPerSec(ewmaBps) : null);
      },
      controller.signal,
    );
    markMegaUploaded(jobId, Date.now());
    try {
      await fs.promises.unlink(job.file_path);
      console.log(`[mega/w${workerId}] uploaded ${jobId}; removed local ${job.file_path}`);
    } catch (e) {
      console.error(`[mega/w${workerId}] uploaded ${jobId} but local unlink failed:`, (e as Error).message);
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (controller.signal.aborted) {
      console.log(`[mega/w${workerId}] canceled ${jobId}`);
      markMegaCanceled(jobId, "canceled by user");
    } else {
      console.error(`[mega/w${workerId}] upload failed ${jobId}:`, msg);
      markMegaFailed(jobId, msg);
    }
  } finally {
    activeUploads.delete(jobId);
  }
}

// Called when `mega_max_parallel` is bumped at runtime so any pending items
// get more workers immediately. Reducing the limit takes effect lazily —
// existing workers see the lower limit on their next loop iteration and
// exit if they're over.
export function notifyMaxParallelChanged(): void {
  spawnWorkers();
}

// Cancel an in-flight or queued MEGA upload. Returns the state we found
// the job in: "uploading" if a live stream was aborted, "queued" if it
// was sitting in the queue and we pulled it out before any worker
// picked it up, "not-found" otherwise. The DB row is left at
// mega_status='canceled' so the standard recovery / auto-pickup paths
// don't immediately re-enqueue it — the user has to explicitly retry.
export function cancelMegaUpload(jobId: string): "uploading" | "queued" | "not-found" {
  const ctrl = activeUploads.get(jobId);
  if (ctrl) {
    ctrl.abort();
    // The worker's catch block will markMegaCanceled and clear the map.
    return "uploading";
  }
  const idx = queue.indexOf(jobId);
  if (idx >= 0) {
    queue.splice(idx, 1);
    queued.delete(jobId);
    markMegaCanceled(jobId, "canceled before upload started");
    return "queued";
  }
  return "not-found";
}
