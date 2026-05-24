import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { DOWNLOAD_DIR } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function contentType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case ".mp4":  return "video/mp4";
    case ".webm": return "video/webm";
    case ".mkv":  return "video/x-matroska";
    case ".mp3":  return "audio/mpeg";
    case ".m4a":  return "audio/mp4";
    case ".opus": return "audio/ogg";
    case ".wav":  return "audio/wav";
    case ".flac": return "audio/flac";
    case ".vtt":  return "text/vtt";
    case ".srt":  return "application/x-subrip";
    default:      return "application/octet-stream";
  }
}

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  // Basename-only check: reject any path traversal.
  const decoded = decodeURIComponent(params.name);
  if (decoded.includes("/") || decoded.includes("..") || decoded.includes("\\")) {
    return new Response("forbidden", { status: 403 });
  }
  const full = path.join(DOWNLOAD_DIR, decoded);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return new Response("not found", { status: 404 });
  }
  const stat = fs.statSync(full);
  const nodeStream = fs.createReadStream(full);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;
  return new Response(webStream, {
    status: 200,
    headers: {
      "content-type": contentType(decoded),
      "content-length": String(stat.size),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(decoded)}`,
    },
  });
}
