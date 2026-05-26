import Link from "next/link";
import { notFound } from "next/navigation";
import { getJob } from "@/lib/db";
import { basename, statusBadgeClass } from "@/lib/format";
import { CopyButton } from "./copy-button";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fmtTs(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : "—";
}

export default function Page({ params }: { params: { id: string } }) {
  const job = getJob(params.id);
  if (!job) notFound();

  const titleText = job.title || (job.file_path ? basename(job.file_path) : job.url);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <h1 className="break-all text-2xl font-semibold">{titleText}</h1>
        <Link
          href="/history"
          className="shrink-0 text-sm text-primary underline-offset-2 hover:underline"
        >
          ← Back to history
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(job.status)}`}
        >
          {job.status}
        </span>
        <a
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-primary underline-offset-2 hover:underline"
        >
          {job.url}
        </a>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Job</h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">ID</dt>
          <dd className="break-all font-mono text-xs">{job.id}</dd>
          <dt className="text-muted-foreground">Format</dt>
          <dd>{job.format}</dd>
          {job.container && (
            <>
              <dt className="text-muted-foreground">Container</dt>
              <dd>{job.container}</dd>
            </>
          )}
          {job.compat && (
            <>
              <dt className="text-muted-foreground">Compat</dt>
              <dd>{job.compat}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Created</dt>
          <dd>{fmtTs(job.created_at)}</dd>
          <dt className="text-muted-foreground">Started</dt>
          <dd>{fmtTs(job.started_at)}</dd>
          <dt className="text-muted-foreground">Finished</dt>
          <dd>{fmtTs(job.finished_at)}</dd>
          {job.file_path && (
            <>
              <dt className="text-muted-foreground">File</dt>
              <dd className="break-all">{job.file_path}</dd>
            </>
          )}
        </dl>
      </section>

      {job.error && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Error log</h2>
            <CopyButton text={job.error} />
          </div>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md border bg-zinc-950 p-3 text-xs text-zinc-100">
            {job.error}
          </pre>
          <p className="text-xs text-muted-foreground">
            Captured from yt-dlp stderr/stdout at job termination (last ~4&nbsp;KB).
          </p>
        </section>
      )}

      {(job.mega_status || job.mega_error) && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">MEGA</h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            {job.mega_status && (
              <>
                <dt className="text-muted-foreground">Status</dt>
                <dd>{job.mega_status}</dd>
              </>
            )}
            {job.mega_uploaded_at && (
              <>
                <dt className="text-muted-foreground">Uploaded</dt>
                <dd>{fmtTs(job.mega_uploaded_at)}</dd>
              </>
            )}
          </dl>
          {job.mega_error && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-muted-foreground">
                  MEGA error
                </h3>
                <CopyButton text={job.mega_error} />
              </div>
              <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-all rounded-md border bg-zinc-950 p-3 text-xs text-zinc-100">
                {job.mega_error}
              </pre>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
