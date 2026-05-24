import { NextResponse } from "next/server";
import { deleteCookieFile, isValidDomain } from "@/lib/cookies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: { domain: string } }) {
  const domain = decodeURIComponent(params.domain).toLowerCase();
  if (!isValidDomain(domain)) {
    return NextResponse.json({ error: "invalid domain" }, { status: 400 });
  }
  const removed = deleteCookieFile(domain);
  if (!removed) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
