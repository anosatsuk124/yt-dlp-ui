import { NextResponse } from "next/server";
import { getRunState } from "@/lib/maintenance/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Current run state for the maintenance UI to poll. `id` is accepted for URL
// symmetry; there is only ever one global run.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const run = getRunState();
  if (run && run.taskId !== params.id) {
    return NextResponse.json({ run: null, note: "another task is/was running" });
  }
  return NextResponse.json({ run });
}
