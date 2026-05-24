import fs from "node:fs";
import { NextResponse } from "next/server";
import { getJob, markMegaPending } from "@/lib/db";
import { cancelMegaUpload, enqueueMegaUpload } from "@/lib/mega-uploader";
import { loadMegaConfig } from "@/lib/mega";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manually enqueue a completed job for MEGA upload. Used for rows whose
// `completed` event fired before MEGA was enabled, and for retrying after
// a previous failure. New completed jobs trigger automatically via the
// SSE consumer in server.ts and don't need to hit this route.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const job = getJob(params.id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (job.status !== "completed") {
    return NextResponse.json(
      { error: `cannot upload a job in status '${job.status}'` },
      { status: 409 },
    );
  }
  if (!job.file_path) {
    return NextResponse.json({ error: "no file_path on row" }, { status: 409 });
  }
  if (!fs.existsSync(job.file_path)) {
    return NextResponse.json({ error: "local file missing" }, { status: 410 });
  }
  if (job.mega_status === "uploaded") {
    return NextResponse.json({ error: "already uploaded" }, { status: 409 });
  }
  if (job.mega_status === "pending" || job.mega_status === "uploading") {
    return NextResponse.json(
      { error: `MEGA upload already ${job.mega_status}` },
      { status: 409 },
    );
  }
  // 'failed' or 'canceled' both mean "ok to retry" — fall through.

  // MEGA can be disabled in settings — we still mark pending so it'll be
  // picked up the next time the uploader queue ticks (e.g. after enable +
  // server restart). But warn the caller so the UI can tell the user.
  const cfg = loadMegaConfig();
  markMegaPending(params.id);
  enqueueMegaUpload(params.id);

  return NextResponse.json(
    { ok: true, queued: true, mega_enabled: cfg.enabled },
    { status: 202 },
  );
}

// Cancel an in-flight or queued MEGA upload. Until the user retries via
// POST, the row stays at mega_status='canceled' and is NOT auto-picked
// up by startMegaUploader / completion events.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const job = getJob(params.id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (job.mega_status !== "pending" && job.mega_status !== "uploading") {
    return NextResponse.json(
      { error: `nothing to cancel (mega_status=${job.mega_status ?? "null"})` },
      { status: 409 },
    );
  }
  const state = cancelMegaUpload(params.id);
  return NextResponse.json({ ok: true, state }, { status: 202 });
}
