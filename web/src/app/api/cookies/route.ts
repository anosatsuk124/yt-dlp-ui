import { NextResponse } from "next/server";
import { listCookies, isNetscapeCookieFile, isValidDomain, writeCookieFile } from "@/lib/cookies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ cookies: listCookies() });
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });

  const domain = String(form.get("domain") ?? "").toLowerCase().trim();
  const file = form.get("file");

  if (!isValidDomain(domain)) {
    return NextResponse.json({ error: "invalid domain" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file" }, { status: 400 });
  }

  const text = await file.text();
  if (!isNetscapeCookieFile(text)) {
    return NextResponse.json(
      { error: "not a Netscape cookies.txt — must start with '# Netscape HTTP Cookie File' or '# HTTP Cookie File'" },
      { status: 400 },
    );
  }

  writeCookieFile(domain, text);
  return NextResponse.json({ ok: true, domain }, { status: 201 });
}
