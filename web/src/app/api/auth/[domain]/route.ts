import { NextResponse } from "next/server";
import {
  deleteAuthBinding,
  getAuthBinding,
  upsertAuthBinding,
} from "@/lib/db";
import { isValidDomain } from "@/lib/cookies";
import {
  optionsToRowPatch,
  redactBinding,
  sanitizeAuthPatch,
} from "@/lib/auth";
import { resolveCertPath } from "@/lib/certs";
import path from "node:path";
import { CERTS_DIR } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function decodeDomain(raw: string): string {
  return decodeURIComponent(raw).toLowerCase();
}

export async function GET(_req: Request, { params }: { params: { domain: string } }) {
  const domain = decodeDomain(params.domain);
  if (!isValidDomain(domain)) {
    return NextResponse.json({ error: "invalid domain" }, { status: 400 });
  }
  const row = getAuthBinding(domain);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ binding: redactBinding(row) });
}

export async function PUT(req: Request, { params }: { params: { domain: string } }) {
  const domain = decodeDomain(params.domain);
  if (!isValidDomain(domain)) {
    return NextResponse.json({ error: "invalid domain" }, { status: 400 });
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }

  const patch = sanitizeAuthPatch(body);

  // Cert refs come in as basenames; resolve to absolute container paths and
  // reject anything that doesn't exist on disk.
  for (const k of ["clientCertFile", "clientCertKeyFile"] as const) {
    const v = patch[k];
    if (typeof v !== "string" || v === "") continue;
    const base = path.basename(v);
    const resolved = resolveCertPath(base);
    if (!resolved) {
      return NextResponse.json(
        { error: `${k}: '${base}' not found in ${CERTS_DIR}` },
        { status: 400 },
      );
    }
    patch[k] = resolved;
  }

  upsertAuthBinding(domain, optionsToRowPatch(patch));
  const row = getAuthBinding(domain)!;
  return NextResponse.json({ binding: redactBinding(row) }, { status: 200 });
}

export async function DELETE(_req: Request, { params }: { params: { domain: string } }) {
  const domain = decodeDomain(params.domain);
  if (!isValidDomain(domain)) {
    return NextResponse.json({ error: "invalid domain" }, { status: 400 });
  }
  const removed = deleteAuthBinding(domain);
  if (!removed) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
