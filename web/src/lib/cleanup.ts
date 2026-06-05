import fs from "node:fs";
import path from "node:path";
import { sha256File } from "./hash";

// Pull the trailing `[id]` block out of a yt-dlp-templated filename like
// "Title [v123456].mp4" or "Title [v123456].mp4.part-Frag42.part".
// We grab the LAST `[...]` because titles can in theory contain brackets.
// A trailing `[#hash]` content marker is ignored so the source [id] still wins.
function extractIdBracket(basename: string): string | null {
  const matches = basename.match(/\[[^\[\]]+\]/g);
  if (!matches || matches.length === 0) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    if (!matches[i].startsWith("[#")) return matches[i];
  }
  return matches[matches.length - 1];
}

// A file is a leftover fragment / partial (safe to delete) if its name carries
// one of yt-dlp's in-progress suffixes. Finished media files never match.
function isFragmentName(name: string): boolean {
  return (
    name.endsWith(".part") ||
    name.endsWith(".ytdl") ||
    name.endsWith(".temp") ||
    /\.part-Frag\d+/.test(name) ||
    /\.f\d+\.(mp4|webm|m4a|m4v|mkv)\.part$/i.test(name)
  );
}

// Remove leftover fragment/partial files that belong to the same source [id]
// as `filePath`, **scoped to filePath's own directory** (the per-job
// <format>/<container> subdir). Finished files of other downloads — including
// a sibling format that shares the same source [id] but lives in a different
// subdir, or a completed file in the same subdir — are never touched, because
// (a) we only scan one directory and (b) we only delete fragment-suffixed names.
//
// Used by:
//   - server.ts on terminal 'failed'/'canceled' events.
//   - server.ts reconcileNow() for orphaned rows on restart.
//
// Best-effort: missing files / unlink errors don't throw.
export function cleanupFragments(filePath: string | null | undefined): number {
  if (!filePath) return 0;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const id = extractIdBracket(base);

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  let n = 0;
  for (const name of entries) {
    if (!isFragmentName(name)) continue;
    // If we could extract a source [id], only sweep fragments that share it,
    // so two concurrent jobs in the same dir don't clobber each other's parts.
    if (id && !name.includes(id)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      n += 1;
    } catch {
      // ignore — file may have just been moved/merged by yt-dlp.
    }
  }
  return n;
}

// Delete a *finished* download's file, but only after verifying it really is
// the file we think it is. Guards against deleting the wrong content when the
// same URL/format/container was re-downloaded with different bytes.
//
// Returns true if the file was deleted (or was already gone), false if a
// safety check failed and the file was left in place.
export async function deleteCompletedEntry(
  filePath: string | null | undefined,
  expectedHash: string | null | undefined,
): Promise<boolean> {
  if (!filePath) return true;
  if (!fs.existsSync(filePath)) return true; // already uploaded / removed
  // If we have a recorded hash, confirm it matches before unlinking.
  if (expectedHash) {
    try {
      const actual = await sha256File(filePath);
      if (actual !== expectedHash) {
        console.warn(`[overwrite] hash mismatch for ${filePath}; refusing to delete`);
        return false;
      }
    } catch {
      // If we can't hash it, fall through and delete by exact-path match —
      // the path came straight from the DB row, so it is the intended file.
    }
  }
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (e) {
    console.error(`[overwrite] failed to delete ${filePath}:`, (e as Error).message);
    return false;
  }
}
