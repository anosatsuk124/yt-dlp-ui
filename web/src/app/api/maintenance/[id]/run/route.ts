import { NextResponse } from "next/server";
import { startRun, getRunState } from "@/lib/maintenance/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Start executing a maintenance task in the background. The run regenerates the
// plan at start time so it acts on current state. Poll /status for progress.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const res = startRun(params.id);
  if (!res.started) {
    return NextResponse.json({ error: res.error ?? "could not start" }, { status: 409 });
  }
  return NextResponse.json({ started: true, run: getRunState() }, { status: 202 });
}
