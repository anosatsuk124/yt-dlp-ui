"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/use-toast";
import type { JobRow } from "@/lib/db";
import { basename, statusBadgeClass, timeAgo } from "@/lib/format";

const PAGE_SIZE = 50;
const IDLE_REFRESH_MS = 30_000;
const ACTIVE_REFRESH_MS = 2_000;

export default function Page() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const load = useCallback(() => {
    fetch(`/api/history?limit=${PAGE_SIZE}&offset=0`)
      .then(r => r.json())
      .then((data: { jobs: JobRow[]; total: number }) => {
        setJobs(data.jobs ?? []);
        setTotal(data.total ?? 0);
      })
      .catch(() => { /* leave whatever was there */ })
      .finally(() => setLoading(false));
  }, []);

  // Poll faster when any MEGA upload is in flight so the progress bar
  // moves visibly.
  const hasActiveUpload = jobs.some(
    j => j.mega_status === "uploading" || j.mega_status === "pending",
  );

  useEffect(() => {
    load();
    const t = setInterval(load, hasActiveUpload ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
    return () => clearInterval(t);
  }, [load, hasActiveUpload]);

  const onDelete = useCallback(
    async (job: JobRow) => {
      const label = job.title ?? job.url;
      if (!window.confirm(`Delete this entry and its local file?\n\n${label}`)) return;
      const res = await fetch(`/api/history/${encodeURIComponent(job.id)}`, {
        method: "DELETE",
      });
      if (res.status === 204) {
        toast({ title: "Deleted" });
        setJobs(curr => curr.filter(j => j.id !== job.id));
        setTotal(t => Math.max(0, t - 1));
      } else {
        const body = await res.json().catch(() => ({}));
        toast({
          title: "Delete failed",
          description: body?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
      }
    },
    [toast],
  );

  const onUpload = useCallback(
    async (job: JobRow) => {
      const res = await fetch(`/api/history/${encodeURIComponent(job.id)}/upload`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) {
        toast({
          title: body?.mega_enabled
            ? "Queued for MEGA upload"
            : "Queued — but MEGA is currently disabled in Settings",
        });
        // Optimistic: show 'pending' immediately so the user sees their click registered.
        setJobs(curr =>
          curr.map(j => (j.id === job.id ? { ...j, mega_status: "pending" } : j)),
        );
      } else {
        toast({
          title: "Upload failed",
          description: body?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
      }
    },
    [toast],
  );

  const onCancelUpload = useCallback(
    async (job: JobRow) => {
      const res = await fetch(`/api/history/${encodeURIComponent(job.id)}/upload`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) {
        toast({ title: "Upload canceled" });
        // Optimistic: flip to 'canceled' so the Retry button appears immediately.
        setJobs(curr =>
          curr.map(j => (j.id === job.id ? { ...j, mega_status: "canceled" } : j)),
        );
      } else {
        toast({
          title: "Cancel failed",
          description: body?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
      }
    },
    [toast],
  );

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">History</h1>

      {loading && jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No completed jobs yet.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title / URL</TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
                <TableHead className="w-[100px]">Format</TableHead>
                <TableHead className="w-[140px]">Finished</TableHead>
                <TableHead className="w-[120px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map(job => {
                const file = job.file_path ? basename(job.file_path) : null;
                return (
                  <TableRow key={job.id}>
                    <TableCell className="max-w-0">
                      <div className="min-w-0">
                        <a
                          href={job.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate text-primary underline-offset-2 hover:underline"
                          title={job.title ? `${job.title}\n${job.url}` : job.url}
                        >
                          {job.title || job.url}
                        </a>
                        {job.title && (
                          <div
                            className="truncate text-xs text-muted-foreground"
                            title={job.url}
                          >
                            {job.url}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(job.status)}`}
                        title={job.error ?? undefined}
                      >
                        {job.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{job.format}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {timeAgo(job.finished_at ?? job.created_at)}
                    </TableCell>
                    <TableCell>
                      <ActionCell
                        job={job}
                        file={file}
                        onDelete={() => onDelete(job)}
                        onUpload={() => onUpload(job)}
                        onCancelUpload={() => onCancelUpload(job)}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {total > PAGE_SIZE && (
            <p className="text-xs text-muted-foreground">
              Showing {jobs.length} of {total}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ActionCell({
  job,
  file,
  onDelete,
  onUpload,
  onCancelUpload,
}: {
  job: JobRow;
  file: string | null;
  onDelete: () => void;
  onUpload: () => void;
  onCancelUpload: () => void;
}) {
  // Mega upload finished — the local file is intentionally gone. Show
  // status only; deletion isn't applicable here.
  if (job.mega_status === "uploaded") {
    const when = job.mega_uploaded_at
      ? new Date(job.mega_uploaded_at).toLocaleString()
      : undefined;
    return (
      <span
        className="text-sm text-emerald-600"
        title={when ? `uploaded to MEGA at ${when}` : "uploaded to MEGA"}
      >
        ✓ MEGA
      </span>
    );
  }

  // For everything else, show a stack of available actions.
  const parts: React.ReactNode[] = [];

  if (file) {
    parts.push(
      <a
        key="dl"
        href={`/api/files/${encodeURIComponent(file)}`}
        className="text-primary underline-offset-2 hover:underline"
      >
        Download
      </a>,
    );
  }

  // MEGA status / actions.
  if (job.mega_status === "uploading") {
    const pct = Math.max(0, Math.min(100, job.mega_progress ?? 0));
    parts.push(
      <div key="mega" className="w-full min-w-[110px] space-y-0.5">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>MEGA {pct.toFixed(1)}%</span>
          {job.mega_speed && <span>{job.mega_speed}</span>}
        </div>
        <Progress value={pct} className="h-1.5" />
      </div>,
      <Button
        key="mega-cancel"
        variant="ghost"
        size="sm"
        className="h-auto px-1 py-0 text-destructive hover:text-destructive"
        onClick={onCancelUpload}
      >
        Cancel MEGA
      </Button>,
    );
  } else if (job.mega_status === "pending") {
    parts.push(
      <span key="mega" className="text-muted-foreground">MEGA queued</span>,
      <Button
        key="mega-cancel"
        variant="ghost"
        size="sm"
        className="h-auto px-1 py-0 text-destructive hover:text-destructive"
        onClick={onCancelUpload}
      >
        Cancel MEGA
      </Button>,
    );
  } else if (
    // Either never attempted (null), previously failed, or user canceled —
    // and we have a completed local file. Offer a manual upload button.
    (job.mega_status == null || job.mega_status === "failed" || job.mega_status === "canceled") &&
    job.status === "completed" &&
    file
  ) {
    const label =
      job.mega_status === "failed" ? "Retry MEGA"
      : job.mega_status === "canceled" ? "Retry MEGA"
      : "Upload";
    const tooltip =
      job.mega_status === "failed"   ? (job.mega_error ?? "previous upload failed — click to retry")
      : job.mega_status === "canceled" ? (job.mega_error ?? "upload canceled — click to retry")
      : "upload this file to MEGA";
    parts.push(
      <Button
        key="mega-upload"
        variant="ghost"
        size="sm"
        className="h-auto px-1 py-0 text-primary hover:text-primary"
        onClick={onUpload}
        title={tooltip}
      >
        {label}
      </Button>,
    );
  }

  // Delete is allowed unless MEGA is currently working on the file.
  const blockDelete = job.mega_status === "uploading" || job.mega_status === "pending";
  if (!blockDelete) {
    parts.push(
      <Button
        key="del"
        variant="ghost"
        size="sm"
        className="h-auto px-1 py-0 text-destructive hover:text-destructive"
        onClick={onDelete}
      >
        Delete
      </Button>,
    );
  }

  if (parts.length === 0) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {parts}
    </div>
  );
}
