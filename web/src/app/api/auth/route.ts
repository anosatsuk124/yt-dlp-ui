import { NextResponse } from "next/server";
import { listAuthBindings } from "@/lib/db";
import { redactBinding } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ bindings: listAuthBindings().map(redactBinding) });
}
