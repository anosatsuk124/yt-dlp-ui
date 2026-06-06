// Regroup already-uploaded playlist files into per-season subfolders.
//
// The season feature only tags NEW downloads. For files uploaded before it, this
// task resolves each one's season from the source and MOVES its MEGA copy from
// playlists/<title>/ into playlists/<title>/<season>/ — re-parenting the node
// only, no bytes re-uploaded. Files whose source exposes no season are left in
// place.

import {
  getJob,
  updateJobSeason,
  listUploadedPlaylistJobsWithoutSeason,
  type JobRow,
} from "../db";
import { loadMegaConfig, MegaClient } from "../mega";
import { targetFolderPath } from "../mega-uploader";
import { resolvePlaylist } from "../downloader";
import { resolveCookiesFile } from "../cookies";
import { resolveAuthBinding, hasAny } from "../auth";
import type { MaintenanceTask, OperationStep } from "./types";

function shortLabel(job: JobRow): string {
  return `"${job.title || job.url}" [${job.playlist_title ?? ""}]`;
}

// Resolve a job's season via the downloader's single-video /resolve. Returns
// null when the source exposes no season (or resolution fails).
async function fetchSeason(
  job: JobRow,
): Promise<{ season: string; seasonNumber: number | null } | null> {
  // Prefer the cookies the job actually downloaded with — a playlist entry may
  // have been enqueued with fallback cookies from the submitted URL, so
  // resolving from the entry URL alone can come back empty for an
  // authenticated source. Fall back to a fresh per-domain lookup.
  const cookiesFile = job.cookies_file ?? resolveCookiesFile(job.url);
  const auth = resolveAuthBinding(job.url);
  let res;
  try {
    res = await resolvePlaylist({
      url: job.url,
      cookiesFile: cookiesFile ?? undefined,
      auth: auth && hasAny(auth) ? auth : undefined,
    });
  } catch {
    return null;
  }
  const season = res.season?.trim();
  if (!season || season === "NA") return null;
  const n = res.seasonNumber ? parseInt(res.seasonNumber, 10) : NaN;
  return { season, seasonNumber: Number.isFinite(n) ? n : null };
}

export const regroupSeasonsTask: MaintenanceTask = {
  id: "regroup-seasons",
  title: "Regroup playlist uploads by season",
  description:
    "For every already-uploaded playlist file with no season recorded yet, " +
    "resolve its season from the source and move its MEGA copy into a " +
    "playlists/<title>/<season>/ subfolder (no re-upload). Files whose source " +
    "exposes no season are left where they are.",

  async plan(): Promise<OperationStep[]> {
    if (!loadMegaConfig().enabled) return [];
    const jobs = listUploadedPlaylistJobsWithoutSeason();
    return jobs.map(j => ({
      id: j.id,
      jobId: j.id,
      description:
        `Resolve the season for ${shortLabel(j)} and move its MEGA copy under ` +
        `playlists/${j.playlist_title}/<season>/ (skipped if the source has no season)`,
    }));
  },

  async apply(step: OperationStep, log: (m: string) => void): Promise<void> {
    if (!step.jobId) return;
    const job = getJob(step.jobId);
    if (!job) {
      log(`Skipping ${step.jobId}: row no longer exists`);
      return;
    }
    if (job.season && job.season.trim()) {
      log(`Skipping ${job.id}: season already set`);
      return;
    }
    if (job.mega_status !== "uploaded" || !job.mega_remote_name || !job.playlist_title) {
      log(`Skipping ${job.id}: not an uploaded playlist file`);
      return;
    }
    const cfg = loadMegaConfig();
    if (!cfg.enabled) {
      log("MEGA is disabled; nothing to do");
      return;
    }

    const resolved = await fetchSeason(job);
    if (!resolved) {
      log(`No season for ${shortLabel(job)}; leaving in place`);
      return;
    }
    const { season, seasonNumber } = resolved;

    // Reuse the exact upload path logic: current location has no season, the
    // target adds the /<season>/ level.
    const oldFolderPath = targetFolderPath(job);
    const newFolderPath = targetFolderPath({ ...job, season });
    const remoteName = job.mega_remote_name;

    if (oldFolderPath === newFolderPath) {
      updateJobSeason(job.id, season, seasonNumber);
      log(`Recorded season "${season}" for ${job.id} (no move needed)`);
      return;
    }

    const client = new MegaClient();
    try {
      await client.connect(cfg.email, cfg.password);
      const destFolder = await client.ensureFolder(newFolderPath);
      // Idempotency: if a previous run already moved it, just record the season.
      if (client.findFile(destFolder, remoteName)) {
        updateJobSeason(job.id, season, seasonNumber);
        log(`Already in season folder; recorded season "${season}" for ${job.id}`);
        return;
      }
      const oldFolder = await client.ensureFolder(oldFolderPath);
      const node = client.findFile(oldFolder, remoteName);
      if (!node) {
        log(`WARN: ${remoteName} not found under ${oldFolderPath}; leaving season unset for ${job.id}`);
        return;
      }
      await client.moveFile(node, destFolder);
      updateJobSeason(job.id, season, seasonNumber);
      log(`Moved ${remoteName} → ${newFolderPath} (season "${season}")`);
    } finally {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  },
};
