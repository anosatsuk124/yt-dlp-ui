import { NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import {
  insertJob,
  listActiveJobs,
  getSetting,
  deleteJob,
  findExistingByIdentity,
  updateJobStatus,
  type JobRow,
} from "@/lib/db";
import { isFormatKey, formatKind, type FormatKey } from "@/lib/formats";
import { isContainerValidFor, type ContainerKey } from "@/lib/containers";
import { isCompatKey, type CompatKey } from "@/lib/compat";
import { resolveCookiesFile } from "@/lib/cookies";
import { postJob, shellSplit, resolvePlaylist, type ResolveResult } from "@/lib/downloader";
import { deleteCompletedEntry } from "@/lib/cleanup";
import { deleteRemoteForJob } from "@/lib/mega-uploader";
import {
  hasAny,
  mergeAuth,
  resolveAuthBinding,
  sanitizeAuthPatch,
  type AuthOptions,
} from "@/lib/auth";
import { resolveCertPath } from "@/lib/certs";
import path from "node:path";
import { CERTS_DIR } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Resolution = "append" | "overwrite" | "save-as" | "cancel";

interface Selection {
  format: FormatKey;
  containers: ContainerKey[];
}

interface EnqueueBody {
  urls: string[];
  selections: Selection[];
  compat?: CompatKey;
  extraArgs?: string;
  auth?: Partial<AuthOptions>;
  resolution?: Resolution;
  saveAsNames?: Record<string, string>;
}

// A single concrete (url, format, container) download target.
interface Combo {
  url: string;
  format: FormatKey;
  container: ContainerKey;
  kind: "video" | "audio";
  // Set when this target came from expanding a playlist URL.
  playlistTitle: string | null;
  // Pre-resolved title from the playlist entry (UI hint while queued).
  seedTitle: string | null;
}

function comboKey(url: string, format: string, container: string): string {
  return `${url}|${format}|${container}`;
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
  for (const url of urls) {
    if (!/^https?:\/\//.test(url)) {
      return NextResponse.json({ error: `invalid url: ${url}` }, { status: 400 });
    }
  }

  // Validate and flatten the format×container selection matrix.
  if (!Array.isArray(body.selections) || body.selections.length === 0) {
    return NextResponse.json({ error: "no selections" }, { status: 400 });
  }
  const pairs: { format: FormatKey; container: ContainerKey; kind: "video" | "audio" }[] = [];
  for (const sel of body.selections) {
    if (!isFormatKey(sel.format)) {
      return NextResponse.json({ error: `invalid format: ${String(sel.format)}` }, { status: 400 });
    }
    const kind = formatKind(sel.format);
    const containers = Array.isArray(sel.containers) ? sel.containers : [];
    if (containers.length === 0) continue; // format with no container chosen → skip
    for (const c of containers) {
      if (!isContainerValidFor(kind, c)) {
        return NextResponse.json(
          { error: `invalid container '${String(c)}' for format '${sel.format}'` },
          { status: 400 },
        );
      }
      pairs.push({ format: sel.format, container: c, kind });
    }
  }
  if (pairs.length === 0) {
    return NextResponse.json({ error: "no format/container combination selected" }, { status: 400 });
  }

  // Compat applies to video only; ios forces mp4 on the downloader side.
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

  // Per-job auth override (twoFactor allowed; cert refs resolved against /certs).
  const authOverride = sanitizeAuthPatch(body.auth, { allowTwoFactor: true });
  for (const k of ["clientCertFile", "clientCertKeyFile"] as const) {
    const v = authOverride[k];
    if (typeof v !== "string" || v === "") continue;
    const base = path.basename(v);
    const resolved = resolveCertPath(base);
    if (!resolved) {
      return NextResponse.json(
        { error: `auth.${k}: '${base}' not found in ${CERTS_DIR}` },
        { status: 400 },
      );
    }
    authOverride[k] = resolved;
  }

  // Expand any playlist URL into its individual video URLs up front — the
  // downloader has yt-dlp, the web container doesn't, so we ask it to
  // enumerate. Each entry becomes its own job tagged with the playlist title
  // (drives the MEGA destination playlists/<title>/).
  //
  // We only enqueue a raw URL as a single job when resolve *confirms* it is not
  // a playlist. If resolve fails we do NOT fall back to the URL as-is: yt-dlp's
  // --no-playlist only disambiguates a URL that points at both a video and a
  // playlist, so a pure playlist URL (e.g. .../playlist?list=…) would still
  // download every entry into one job and the one-file-per-job pipeline (single
  // path/hash/MEGA upload) would silently drop all but one file. Such URLs are
  // reported as failures instead.
  interface Target { url: string; playlistTitle: string | null; seedTitle: string | null }
  const targets: Target[] = [];
  const resolveFailures: { url: string; error: string }[] = [];
  for (const url of urls) {
    const cookiesFile = resolveCookiesFile(url);
    const binding = resolveAuthBinding(url);
    const auth = mergeAuth(binding, authOverride);
    let resolved: ResolveResult | null = null;
    let resolveError: string | null = null;
    try {
      resolved = await resolvePlaylist({
        url,
        cookiesFile: cookiesFile ?? undefined,
        // Honor list-limiting flags (e.g. --playlist-items) while enumerating;
        // applying them only to the per-video jobs would be too late since
        // those run with --no-playlist.
        extraArgs: extraArgs.length ? extraArgs : undefined,
        auth: auth && hasAny(auth) ? auth : undefined,
      });
    } catch (e) {
      resolveError = (e as Error).message;
      console.error(`[resolve] ${url}:`, resolveError);
    }
    if (resolved?.isPlaylist && resolved.entries && resolved.entries.length > 0) {
      const playlistTitle = resolved.playlistTitle?.trim() || "playlist";
      for (const entry of resolved.entries) {
        const entryUrl = entry.url?.trim();
        if (!entryUrl) continue;
        targets.push({ url: entryUrl, playlistTitle, seedTitle: entry.title?.trim() || null });
      }
    } else if (resolved && !resolved.isPlaylist) {
      // Confirmed single video → safe to enqueue the URL directly.
      targets.push({ url, playlistTitle: null, seedTitle: null });
    } else {
      // resolve threw (downloader/extractor error) — can't tell whether this is
      // a playlist, so don't risk a multi-file single job.
      resolveFailures.push({ url, error: resolveError ?? "could not resolve URL" });
    }
  }

  // Nothing resolved (every submitted URL failed) → surface the errors instead
  // of silently creating nothing.
  if (targets.length === 0 && resolveFailures.length > 0) {
    return NextResponse.json(
      { error: "could not resolve any URL", failed: resolveFailures },
      { status: 502 },
    );
  }

  // Build the full combo list across targets × pairs and look up existing
  // (completed/uploaded) downloads with the same identity.
  const combos: (Combo & { existing?: JobRow })[] = [];
  for (const t of targets) {
    for (const p of pairs) {
      const existing = findExistingByIdentity(t.url, p.format, p.container);
      combos.push({
        url: t.url,
        format: p.format,
        container: p.container,
        kind: p.kind,
        playlistTitle: t.playlistTitle,
        seedTitle: t.seedTitle,
        existing,
      });
    }
  }

  const resolution = body.resolution;
  const conflicts = combos.filter(c => c.existing);

  // No resolution chosen yet and at least one identity already exists → ask
  // the user how to proceed (append / overwrite / save-as / cancel). Nothing
  // is created on this round.
  if (conflicts.length > 0 && !resolution) {
    return NextResponse.json(
      {
        conflicts: conflicts.map(c => ({
          url: c.url,
          format: c.format,
          container: c.container,
          existingId: c.existing!.id,
          title: c.existing!.title ?? c.url,
        })),
        failed: resolveFailures,
      },
      { status: 409 },
    );
  }

  const saveAsNames = body.saveAsNames ?? {};
  const created: { id: string; url: string; format: string; container: string }[] = [];
  const skipped: { url: string; format: string; container: string }[] = [];
  const now = Date.now();

  for (const c of combos) {
    // Conflict resolution for combos whose identity already exists.
    let outputName: string | undefined;
    if (c.existing) {
      if (resolution === "cancel") {
        skipped.push({ url: c.url, format: c.format, container: c.container });
        continue;
      }
      if (resolution === "overwrite") {
        // Delete the prior copy everywhere before re-downloading.
        try {
          if (c.existing.mega_status === "uploaded") {
            await deleteRemoteForJob(c.existing).catch(e =>
              console.error("[overwrite] remote delete failed:", (e as Error).message));
          }
          await deleteCompletedEntry(c.existing.file_path, c.existing.content_hash);
        } catch (e) {
          console.error("[overwrite] cleanup error:", (e as Error).message);
        }
        deleteJob(c.existing.id);
      } else if (resolution === "save-as") {
        const name = saveAsNames[comboKey(c.url, c.format, c.container)]?.trim();
        if (name) outputName = name;
        // existing row is kept; the new one lands under a different name.
      }
      // "append": existing kept; new download distinguished by its content hash.
    }

    const id = uuid();
    const cookiesFile = resolveCookiesFile(c.url);
    const binding = resolveAuthBinding(c.url);
    const auth = mergeAuth(binding, authOverride);

    insertJob({
      id,
      url: c.url,
      format: c.format,
      container: c.container,
      compat: c.kind === "audio" ? null : compat,
      extra_args: extraArgs.length ? JSON.stringify(extraArgs) : null,
      cookies_file: cookiesFile,
      status: "queued",
      created_at: now,
      save_as: outputName ?? null,
      title: c.seedTitle,
      playlist_title: c.playlistTitle,
    });

    // What we hand the downloader: audio sends its codec as the container;
    // video sends a real container ("auto" → undefined so yt-dlp picks).
    const dlContainer =
      c.kind === "audio" ? c.container : c.container === "auto" ? undefined : c.container;
    const dlCompat = c.kind === "audio" ? undefined : compat === "auto" ? undefined : compat;

    try {
      await postJob({
        id,
        url: c.url,
        format: c.format,
        container: dlContainer,
        compat: dlCompat,
        outputName,
        extraArgs,
        cookiesFile: cookiesFile ?? undefined,
        auth: auth && hasAny(auth) ? auth : undefined,
      });
    } catch (e) {
      updateJobStatus(id, "failed", { error: (e as Error).message, finished_at: Date.now() });
      return NextResponse.json(
        { error: `downloader unreachable: ${(e as Error).message}`, created },
        { status: 502 },
      );
    }
    created.push({ id, url: c.url, format: c.format, container: c.container });
  }

  return NextResponse.json({ jobs: created, skipped, failed: resolveFailures }, { status: 201 });
}

export async function GET() {
  return NextResponse.json({ jobs: listActiveJobs() });
}
