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
import { useToast } from "@/components/ui/use-toast";
import type { JobRow } from "@/lib/db";
import { basename, statusBadgeClass, timeAgo } from "@/lib/format";

const PAGE_SIZE = 50;
const REFRESH_MS = 30_000;

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

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

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
                      <ActionCell job={job} file={file} onDelete={() => onDelete(job)} />
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
}: {
  job: JobRow;
  file: string | null;
  onDelete: () => void;
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

  // MEGA status badges — informational, no action attached.
  if (job.mega_status === "uploading") {
    parts.push(
      <span key="mega" className="text-muted-foreground">MEGA…</span>,
    );
  } else if (job.mega_status === "pending") {
    parts.push(
      <span key="mega" className="text-muted-foreground">MEGA queued</span>,
    );
  } else if (job.mega_status === "failed") {
    parts.push(
      <span
        key="mega"
        className="text-destructive"
        title={job.mega_error ?? "MEGA upload failed"}
      >
        MEGA failed
      </span>,
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
