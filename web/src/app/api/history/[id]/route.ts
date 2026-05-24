import { NextResponse } from "next/server";
import { getJob, deleteJob } from "@/lib/db";
import { cleanupByIdBracket } from "@/lib/cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // Sweep the final file plus any leftover .part / .ytdl / *.part-Frag*
  // by matching the [id] bracket in the captured destination path.
  // Best-effort: missing files are fine, we still want the row gone.
  cleanupByIdBracket(job.file_path);

  deleteJob(params.id);
  return new NextResponse(null, { status: 204 });
}
