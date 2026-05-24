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
  markMegaFailed,
  markMegaUploaded,
  markMegaUploading,
} from "./db";
import { MegaClient, loadMegaConfig } from "./mega";

const queue: string[] = [];
const queued = new Set<string>();
let activeWorkers = 0;

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
    for (const job of pending) enqueueMegaUpload(job.id);
  }
}

function spawnWorkers(): void {
  const max = getMaxParallel();
  while (activeWorkers < max && queue.length > 0) {
    void workerLoop(activeWorkers + 1);
  }
}

async function workerLoop(workerId: number): Promise<void> {
  // Note: this increment runs synchronously before the first await, so
  // spawnWorkers's `activeWorkers < max` check stays accurate as workers
  // are spawned in a tight loop.
  activeWorkers++;
  try {
    while (queue.length > 0) {
      const cfg = loadMegaConfig();
      if (!cfg.enabled) {
        console.log(`[mega/w${workerId}] disabled; pausing queue`);
        return;
      }
      // Honour live changes to mega_max_parallel — if the setting was
      // reduced, the extra worker gracefully exits at the top of the loop.
      if (activeWorkers > getMaxParallel()) {
        console.log(`[mega/w${workerId}] over limit; exiting`);
        return;
      }

      const client = new MegaClient();
      try {
        await client.connect(cfg.email, cfg.password);
        const folder = await client.ensureFolder(cfg.folder);
        // Drain as many items as we can with this connection.
        while (queue.length > 0) {
          if (activeWorkers > getMaxParallel()) break;
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
    activeWorkers--;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processOne(jobId: string, client: MegaClient, folder: any, workerId: number): Promise<void> {
  const job = getJob(jobId);
  if (!job || !job.file_path) {
    console.log(`[mega/w${workerId}] skipping ${jobId}: job or file_path missing`);
    return;
  }
  if (!fs.existsSync(job.file_path)) {
    markMegaFailed(jobId, "local file missing before upload");
    return;
  }
  try {
    markMegaUploading(jobId);
    console.log(`[mega/w${workerId}] uploading ${jobId} -> ${job.file_path}`);
    await client.uploadFile(job.file_path, folder);
    markMegaUploaded(jobId, Date.now());
    try {
      await fs.promises.unlink(job.file_path);
      console.log(`[mega/w${workerId}] uploaded ${jobId}; removed local ${job.file_path}`);
    } catch (e) {
      console.error(`[mega/w${workerId}] uploaded ${jobId} but local unlink failed:`, (e as Error).message);
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.error(`[mega/w${workerId}] upload failed ${jobId}:`, msg);
    markMegaFailed(jobId, msg);
  }
}

// Called when `mega_max_parallel` is bumped at runtime so any pending items
// get more workers immediately. Reducing the limit takes effect lazily —
// existing workers see the lower limit on their next loop iteration and
// exit if they're over.
export function notifyMaxParallelChanged(): void {
  spawnWorkers();
}
