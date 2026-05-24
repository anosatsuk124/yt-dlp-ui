import { NextResponse } from "next/server";
import { getJob } from "@/lib/db";
import { cancelJob } from "@/lib/downloader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const job = getJob(params.id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    await cancelJob(params.id);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
  return new NextResponse(null, { status: 204 });
}
