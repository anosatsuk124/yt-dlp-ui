import { NextResponse } from "next/server";
import fs from "node:fs";
import { getJob, deleteJob } from "@/lib/db";
import { cleanupFragments } from "@/lib/cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const job = getJob(params.id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(job);
}

// Removes a finished/failed/canceled job from history. Also unlinks the
// local file if it still exists. Refuses to touch rows whose MEGA upload
// already finished — those are 'gone locally on purpose' and shouldn't
// look like the user can re-delete them from this UI.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const job = getJob(params.id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (job.mega_status === "uploaded") {
    return NextResponse.json(
      { error: "file is on MEGA; not deletable from here" },
      { status: 403 },
    );
  }

  // Don't yank a file out from under an in-flight upload.
  if (job.mega_status === "pending" || job.mega_status === "uploading") {
    return NextResponse.json(
      { error: `MEGA upload is ${job.mega_status}; try again after it finishes or fails` },
      { status: 409 },
    );
  }

  // Delete this row's own finished file (exact path — no bracket-wide sweep,
  // so a sibling format of the same source is never collaterally removed),
  // then sweep any leftover fragments in the same per-job subdir.
  if (job.file_path) {
    try { fs.unlinkSync(job.file_path); } catch { /* already gone — fine */ }
    cleanupFragments(job.file_path);
  }

  deleteJob(params.id);
  return new NextResponse(null, { status: 204 });
}
