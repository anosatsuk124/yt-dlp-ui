import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import { patchConfig } from "@/lib/downloader";
import { DEFAULT_MEGA_FOLDER } from "@/lib/mega";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Persistent settings:
//   default_format    — preset key shown selected in the queue form
//   max_parallel      — last value proxied to the downloader; the runtime
//                       value lives in the downloader itself
//   mega_enabled      — "true" to auto-upload completed downloads to MEGA
//   mega_email        — MEGA account email
//   mega_password     — MEGA account password (stored as-is — keep /data safe)
//   mega_folder       — destination folder on MEGA (default /yt-dlp-ui)

interface MegaResponse {
  enabled: boolean;
  email: string;
  hasPassword: boolean;
  folder: string;
}

export async function GET() {
  const megaPassword = getSetting("mega_password") ?? "";
  const mega: MegaResponse = {
    enabled: getSetting("mega_enabled") === "true",
    email: getSetting("mega_email") ?? "",
    hasPassword: megaPassword.length > 0,
    folder: getSetting("mega_folder") || DEFAULT_MEGA_FOLDER,
  };
  return NextResponse.json({
    defaultFormat: getSetting("default_format") ?? "best",
    maxParallel:   parseInt(getSetting("max_parallel") ?? "2", 10),
    mega,
  });
}

interface PutBody {
  defaultFormat?: string;
  maxParallel?: number;
  mega?: {
    enabled?: boolean;
    email?: string;
    password?: string;
    folder?: string;
  };
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => null) as PutBody | null;
  if (!body) return NextResponse.json({ error: "invalid json" }, { status: 400 });

  if (body.defaultFormat) {
    setSetting("default_format", body.defaultFormat);
  }
  if (typeof body.maxParallel === "number" && body.maxParallel >= 1 && body.maxParallel <= 32) {
    setSetting("max_parallel", String(body.maxParallel));
    try {
      await patchConfig(body.maxParallel);
    } catch (e) {
      return NextResponse.json({ error: `downloader: ${(e as Error).message}` }, { status: 502 });
    }
  }
  if (body.mega) {
    const m = body.mega;
    if (typeof m.enabled === "boolean") {
      setSetting("mega_enabled", m.enabled ? "true" : "false");
    }
    if (typeof m.email === "string") {
      setSetting("mega_email", m.email.trim());
    }
    // Empty string / missing means "keep existing password".
    if (typeof m.password === "string" && m.password.length > 0) {
      setSetting("mega_password", m.password);
    }
    if (typeof m.folder === "string") {
      const cleaned = m.folder.trim() || DEFAULT_MEGA_FOLDER;
      setSetting("mega_folder", cleaned.startsWith("/") ? cleaned : `/${cleaned}`);
    }
  }
  return NextResponse.json({ ok: true });
}
