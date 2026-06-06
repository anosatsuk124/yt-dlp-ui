import { NextResponse } from "next/server";
import { getTask } from "@/lib/maintenance/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Generate the concrete operation list for a task from live DB/FS state.
// The settings modal renders exactly these strings before the user confirms.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const task = getTask(params.id);
  if (!task) return NextResponse.json({ error: "unknown task" }, { status: 404 });
  try {
    const steps = await task.plan();
    return NextResponse.json({
      task: { id: task.id, title: task.title, description: task.description },
      steps,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
