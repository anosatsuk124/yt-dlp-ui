import { NextResponse } from "next/server";
import { deleteCertFile, isValidCertName } from "@/lib/certs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: { name: string } }) {
  const name = decodeURIComponent(params.name);
  if (!isValidCertName(name)) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
  }
  const removed = deleteCertFile(name);
  if (!removed) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
