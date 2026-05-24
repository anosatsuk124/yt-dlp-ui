// Background queue that walks completed jobs and uploads each finished
// file to MEGA, then removes the local copy. Started once at server boot
// from server.ts; enqueueMegaUpload() is called from the SSE consumer
// when a job transitions to status='completed' and MEGA is enabled.

import fs from "node:fs";
import {
  getJob,
  listJobsPendingMegaUpload,
  markMegaFailed,
  markMegaUploaded,
  markMegaUploading,
} from "./db";
import { MegaClient, loadMegaConfig } from "./mega";

const queue: string[] = [];
const queued = new Set<string>();
let running = false;

export function enqueueMegaUpload(jobId: string): void {
  if (queued.has(jobId)) return;
  queued.add(jobId);
  queue.push(jobId);
  void tick();
}

export function startMegaUploader(): void {
  const pending = listJobsPendingMegaUpload();
  if (pending.length > 0) {
    console.log(`[mega] recovering ${pending.length} pending upload(s)`);
    for (const job of pending) enqueueMegaUpload(job.id);
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const id = queue[0];
      const cfg = loadMegaConfig();
      if (!cfg.enabled) {
        // Disabled or credentials missing — leave items in the queue marked
        // as pending so a future enable picks them up via the periodic poll.
        console.log("[mega] disabled; pausing queue");
        break;
      }
      const client = new MegaClient();
      try {
        await client.connect(cfg.email, cfg.password);
        const folder = await client.ensureFolder(cfg.folder);
        while (queue.length > 0) {
          const jobId = queue[0];
          await processOne(jobId, client, folder);
          queue.shift();
          queued.delete(jobId);
        }
      } catch (e) {
        const msg = (e as Error).message || String(e);
        console.error("[mega] worker error:", msg);
        // Mark the head job as failed so we don't busy-loop on a broken
        // connection, then drop it from the queue.
        markMegaFailed(id, `mega: ${msg}`);
        queue.shift();
        queued.delete(id);
      } finally {
        await client.disconnect();
      }
    }
  } finally {
    running = false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processOne(jobId: string, client: MegaClient, folder: any): Promise<void> {
  const job = getJob(jobId);
  if (!job || !job.file_path) {
    console.log(`[mega] skipping ${jobId}: job or file_path missing`);
    return;
  }
  if (!fs.existsSync(job.file_path)) {
    markMegaFailed(jobId, "local file missing before upload");
    return;
  }
  try {
    markMegaUploading(jobId);
    console.log(`[mega] uploading ${jobId} -> ${job.file_path}`);
    await client.uploadFile(job.file_path, folder);
    markMegaUploaded(jobId, Date.now());
    try {
      await fs.promises.unlink(job.file_path);
      console.log(`[mega] uploaded ${jobId}; removed local ${job.file_path}`);
    } catch (e) {
      console.error(`[mega] uploaded ${jobId} but local unlink failed:`, (e as Error).message);
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.error(`[mega] upload failed ${jobId}:`, msg);
    markMegaFailed(jobId, msg);
  }
}
