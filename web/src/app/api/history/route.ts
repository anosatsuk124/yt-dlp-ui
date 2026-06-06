import { NextResponse } from "next/server";
import fs from "node:fs";
import { listHistory, countHistory } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0);
  // Annotate each row with whether its file is still on local disk. file_path is
  // set for every completed job, but the file may be gone after a MEGA upload —
  // so the UI needs the real presence to decide which actions to offer (e.g. a
  // keep-local upload leaves the file behind and it stays downloadable/deletable).
  const jobs = listHistory(limit, offset).map(j => ({
    ...j,
    local_present: !!(j.file_path && fs.existsSync(j.file_path)),
  }));
  return NextResponse.json({
    jobs,
    total: countHistory(),
  });
}
