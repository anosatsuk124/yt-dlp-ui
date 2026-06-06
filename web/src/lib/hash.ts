// Content hashing for finished downloads. The sha256 becomes the stable
// identity of a downloaded file: it is recorded in the DB and a short prefix
// is embedded in the filename so two downloads of the same source with
// differing content (e.g. re-encodes, different formats) never collide.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Stream the file through sha256 so large media files don't load into memory.
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const rs = fs.createReadStream(filePath);
    rs.on("error", reject);
    rs.on("data", chunk => hash.update(chunk));
    rs.on("end", () => resolve(hash.digest("hex")));
  });
}

// Insert a short hash marker into a filename, right before the extension:
//   "Title [videoid].mp4" -> "Title [videoid] [#abc12345].mp4"
// Idempotent: a path that already ends with the same [#hash] marker is
// returned unchanged (re-download of identical content → identical name).
export function insertHashIntoName(filePath: string, shortHash: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const marker = `[#${shortHash}]`;
  if (base.endsWith(marker)) return filePath;
  // Strip any pre-existing (different) hash marker so we don't stack them.
  const stripped = base.replace(/\s*\[#[0-9a-f]{6,}\]$/i, "");
  return path.join(dir, `${stripped} ${marker}${ext}`);
}

export const SHORT_HASH_LEN = 8;
