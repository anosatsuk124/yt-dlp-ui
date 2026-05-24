import { NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import { insertJob, listActiveJobs, getSetting } from "@/lib/db";
import { isFormatKey, FormatKey } from "@/lib/formats";
import { isContainerKey, ContainerKey } from "@/lib/containers";
import { isCompatKey, CompatKey } from "@/lib/compat";
import { resolveCookiesFile } from "@/lib/cookies";
import { postJob, shellSplit } from "@/lib/downloader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EnqueueBody {
  urls: string[];
  format: FormatKey;
  container?: ContainerKey;
  compat?: CompatKey;
  extraArgs?: string;
}

export async function POST(req: Request) {
  let body: EnqueueBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const urls = (body.urls ?? []).map(s => s.trim()).filter(Boolean);
  if (urls.length === 0) return NextResponse.json({ error: "no urls" }, { status: 400 });
  if (!isFormatKey(body.format)) return NextResponse.json({ error: "invalid format" }, { status: 400 });

  // Container is optional; fall back to the saved default. Validate either way.
  let container: ContainerKey;
  if (body.container !== undefined) {
    if (!isContainerKey(body.container)) {
      return NextResponse.json({ error: "invalid container" }, { status: 400 });
    }
    container = body.container;
  } else {
    const fromSetting = getSetting("default_container") ?? "auto";
    container = isContainerKey(fromSetting) ? fromSetting : "auto";
  }

  let compat: CompatKey;
  if (body.compat !== undefined) {
    if (!isCompatKey(body.compat)) {
      return NextResponse.json({ error: "invalid compat" }, { status: 400 });
    }
    compat = body.compat;
  } else {
    const fromSetting = getSetting("default_compat") ?? "auto";
    compat = isCompatKey(fromSetting) ? fromSetting : "auto";
  }

  let extraArgs: string[] = [];
  if (body.extraArgs && body.extraArgs.trim().length > 0) {
    try { extraArgs = shellSplit(body.extraArgs); }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  }

  const created: { id: string; url: string }[] = [];
  const now = Date.now();

  for (const url of urls) {
    if (!/^https?:\/\//.test(url)) {
      return NextResponse.json({ error: `invalid url: ${url}` }, { status: 400 });
    }
    const id = uuid();
    const cookiesFile = resolveCookiesFile(url);

    insertJob({
      id, url, format: body.format,
      container,
      compat,
      extra_args: extraArgs.length ? JSON.stringify(extraArgs) : null,
      cookies_file: cookiesFile,
      status: "queued",
      created_at: now,
    });

    try {
      await postJob({
        id, url,
        format: body.format,
        container: container === "auto" ? undefined : container,
        compat: compat === "auto" ? undefined : compat,
        extraArgs,
        cookiesFile: cookiesFile ?? undefined,
      });
    } catch (e) {
      // Downloader unreachable — mark the row as failed so the user sees it.
      const { updateJobStatus } = await import("@/lib/db");
      updateJobStatus(id, "failed", { error: (e as Error).message, finished_at: Date.now() });
      return NextResponse.json({ error: `downloader unreachable: ${(e as Error).message}` }, { status: 502 });
    }
    created.push({ id, url });
  }

  return NextResponse.json({ jobs: created }, { status: 201 });
}

export async function GET() {
  return NextResponse.json({ jobs: listActiveJobs() });
}
