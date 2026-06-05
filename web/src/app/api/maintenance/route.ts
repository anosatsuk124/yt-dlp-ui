import { NextResponse } from "next/server";
import { listTasks } from "@/lib/maintenance/registry";
import { getRunState } from "@/lib/maintenance/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// List available maintenance tasks plus the current run state (if any).
export async function GET() {
  return NextResponse.json({ tasks: listTasks(), run: getRunState() });
}
