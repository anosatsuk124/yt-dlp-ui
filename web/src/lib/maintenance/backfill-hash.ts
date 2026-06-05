// Backfill content hashes for downloads that predate the content-hash feature.
//
// For each completed/uploaded job with no content_hash:
//   - if its local file still exists: hash it in place and embed the marker;
//   - if it was already uploaded to MEGA (local gone): re-download it through
//     the normal pipeline (which hashes, renames and re-uploads it), then
//     delete the old MEGA copy and the old DB row.

import fs from "node:fs";
import { v4 as uuid } from "uuid";
import {
  getJob,
  insertJob,
  deleteJob,
  updateJobHash,
  updateJobStatus,
  listJobsMissingHash,
  type JobRow,
} from "../db";
import { sha256File, insertHashIntoName, SHORT_HASH_LEN } from "../hash";
import { formatKind } from "../formats";
import { loadMegaConfig } from "../mega";
import { deleteRemoteForJob } from "../mega-uploader";
import { resolveCookiesFile } from "../cookies";
import { resolveAuthBinding } from "../auth";
import { postJob } from "../downloader";
import { hasAny } from "../auth";
import type { MaintenanceTask, OperationStep } from "./types";

function localExists(job: JobRow): boolean {
  return !!job.file_path && fs.existsSync(job.file_path);
}

function shortLabel(job: JobRow): string {
  const name = job.title || job.url;
  return `"${name}" [${job.format}/${job.container ?? "auto"}]`;
}

// Re-enqueue a download for the same identity as `old`, returning the new
// job id. Goes through the standard pipeline so server.ts hashes, renames and
// (if enabled) uploads it to MEGA automatically.
async function reDownload(old: JobRow): Promise<string> {
  const id = uuid();
  const kind = formatKind(old.format);
  const cookiesFile = resolveCookiesFile(old.url);
  const auth = resolveAuthBinding(old.url);

  insertJob({
    id,
    url: old.url,
    format: old.format,
    container: old.container,
    compat: kind === "audio" ? null : old.compat,
    extra_args: old.extra_args,
    cookies_file: cookiesFile,
    status: "queued",
    created_at: Date.now(),
    save_as: old.save_as,
  });

  const dlContainer =
    kind === "audio"
      ? old.container ?? "mp3"
      : old.container && old.container !== "auto"
        ? old.container
        : undefined;
  const dlCompat = kind === "audio" ? undefined : old.compat && old.compat !== "auto" ? old.compat : undefined;

  try {
    await postJob({
      id,
      url: old.url,
      format: old.format,
      container: dlContainer ?? undefined,
      compat: dlCompat ?? undefined,
      outputName: old.save_as ?? undefined,
      extraArgs: old.extra_args ? (JSON.parse(old.extra_args) as string[]) : undefined,
      cookiesFile: cookiesFile ?? undefined,
      auth: auth && hasAny(auth) ? auth : undefined,
    });
  } catch (e) {
    updateJobStatus(id, "failed", { error: (e as Error).message, finished_at: Date.now() });
    throw e;
  }
  return id;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Wait until the re-downloaded job reaches its terminal "ready" state: uploaded
// (MEGA enabled) or completed-with-hash (MEGA disabled). Throws on failure or
// timeout.
async function waitReady(newId: string, timeoutMs: number): Promise<void> {
  const megaEnabled = loadMegaConfig().enabled;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = getJob(newId);
    if (j) {
      if (j.status === "failed" || j.status === "canceled") {
        throw new Error(`re-download ${j.status}: ${j.error ?? "unknown"}`);
      }
      if (megaEnabled) {
        if (j.mega_status === "uploaded") return;
        if (j.mega_status === "failed") throw new Error(`re-upload failed: ${j.mega_error ?? "unknown"}`);
      } else if (j.status === "completed" && j.content_hash) {
        return;
      }
    }
    await sleep(2000);
  }
  throw new Error("timed out waiting for re-download to finish");
}

async function rehashLocal(job: JobRow, log: (m: string) => void): Promise<void> {
  if (!job.file_path) throw new Error("no file_path");
  const hash = await sha256File(job.file_path);
  const renamed = insertHashIntoName(job.file_path, hash.slice(0, SHORT_HASH_LEN));
  let finalPath = job.file_path;
  if (renamed !== job.file_path && !fs.existsSync(renamed)) {
    fs.renameSync(job.file_path, renamed);
    finalPath = renamed;
  } else if (fs.existsSync(renamed)) {
    finalPath = renamed;
  }
  updateJobHash(job.id, hash, finalPath);
  log(`Hashed local file for ${job.id}: ${hash.slice(0, SHORT_HASH_LEN)}`);
}

async function rehashUploaded(job: JobRow, log: (m: string) => void): Promise<void> {
  log(`Re-downloading ${shortLabel(job)}…`);
  const newId = await reDownload(job);
  log(`Enqueued re-download ${newId}; waiting for hash + upload…`);
  await waitReady(newId, 60 * 60 * 1000);
  if (job.mega_status === "uploaded") {
    try {
      await deleteRemoteForJob(job);
      log(`Deleted old MEGA copy (${job.mega_remote_name ?? "?"})`);
    } catch (e) {
      log(`WARN: old MEGA delete failed: ${(e as Error).message}`);
    }
  }
  deleteJob(job.id);
  log(`Replaced old entry ${job.id} → ${newId}`);
}

export const backfillHashTask: MaintenanceTask = {
  id: "backfill-hash",
  title: "Backfill content hashes",
  description:
    "Compute and record the sha256 of every completed/uploaded download that " +
    "has none yet. Files still on disk are hashed in place; files already on " +
    "MEGA are re-downloaded, re-hashed and their MEGA copy is replaced.",

  async plan(): Promise<OperationStep[]> {
    const jobs = listJobsMissingHash();
    return jobs.map(j => ({
      id: j.id,
      jobId: j.id,
      description: localExists(j)
        ? `Hash existing local file for ${shortLabel(j)} and record sha256`
        : `Re-download ${shortLabel(j)}, hash it, replace the MEGA copy, update DB`,
    }));
  },

  async apply(step: OperationStep, log: (m: string) => void): Promise<void> {
    if (!step.jobId) return;
    const job = getJob(step.jobId);
    if (!job) {
      log(`Skipping ${step.jobId}: row no longer exists`);
      return;
    }
    if (job.content_hash) {
      log(`Skipping ${step.jobId}: already hashed`);
      return;
    }
    if (localExists(job)) {
      await rehashLocal(job, log);
    } else {
      await rehashUploaded(job, log);
    }
  },
};
