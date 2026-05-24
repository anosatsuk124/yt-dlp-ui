import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import { patchConfig } from "@/lib/downloader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Two persistent settings:
//   default_format    — preset key shown selected in the queue form
//   max_parallel      — last value proxied to the downloader; the runtime
//                       value lives in the downloader itself

export async function GET() {
  return NextResponse.json({
    defaultFormat: getSetting("default_format") ?? "best",
    maxParallel:   parseInt(getSetting("max_parallel") ?? "2", 10),
  });
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => null) as {
    defaultFormat?: string;
    maxParallel?: number;
  } | null;
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
  return NextResponse.json({ ok: true });
}
