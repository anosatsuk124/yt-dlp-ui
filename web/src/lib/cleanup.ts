import fs from "node:fs";
import path from "node:path";
import { DOWNLOAD_DIR } from "./env";

// Pull the trailing `[id]` block out of a yt-dlp-templated filename like
// "Title [v123456].mp4" or "Title [v123456].mp4.part-Frag42.part".
// We grab the LAST `[...]` because titles can in theory contain brackets.
function extractIdBracket(basename: string): string | null {
  const matches = basename.match(/\[[^\[\]]+\]/g);
  return matches && matches.length > 0 ? matches[matches.length - 1] : null;
}

// Remove every file in DOWNLOAD_DIR whose name contains the `[id]` block
// pulled from `filePath`. Returns the number of files unlinked.
//
// Used by:
//   - server.ts on terminal 'failed'/'canceled' events to scrub leftover
//     `.part`, `.ytdl`, and `*.part-Frag<N>.part` fragments.
//   - DELETE /api/history/[id] to ensure no fragments survive the row.
//
// Best-effort: missing files / unlink errors don't throw — the caller
// usually has no recourse anyway.
export function cleanupByIdBracket(filePath: string | null | undefined): number {
  if (!filePath) return 0;
  const base = path.basename(filePath);
  const id = extractIdBracket(base);
  if (!id) return 0;

  let entries: string[];
  try {
    entries = fs.readdirSync(DOWNLOAD_DIR);
  } catch {
    return 0;
  }

  let n = 0;
  for (const name of entries) {
    if (!name.includes(id)) continue;
    try {
      fs.unlinkSync(path.join(DOWNLOAD_DIR, name));
      n += 1;
    } catch {
      // ignore — file may have just been moved/merged by yt-dlp.
    }
  }
  return n;
}
