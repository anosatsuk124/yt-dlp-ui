import { NextResponse } from "next/server";
import {
  isPemFile,
  isValidCertName,
  listCerts,
  writeCertFile,
} from "@/lib/certs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    certs: listCerts().map(c => ({
      name:  c.name,
      size:  c.size,
      mtime: c.mtime,
      path:  c.path,
    })),
  });
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });

  const name = String(form.get("name") ?? "").trim();
  const file = form.get("file");

  if (!isValidCertName(name)) {
    return NextResponse.json(
      { error: "invalid name (alphanumerics, '.', '_', '-' only; must end in .pem/.crt/.cer/.key)" },
      { status: 400 },
    );
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file" }, { status: 400 });
  }

  const text = await file.text();
  if (!isPemFile(text)) {
    return NextResponse.json(
      { error: "not a PEM file — first bytes must contain '-----BEGIN ...'" },
      { status: 400 },
    );
  }

  const path = writeCertFile(name, text);
  return NextResponse.json({ ok: true, name, path }, { status: 201 });
}
