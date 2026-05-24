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
import type { JobRow } from "@/lib/db";
import { basename, statusBadgeClass, timeAgo } from "@/lib/format";

const PAGE_SIZE = 50;
const REFRESH_MS = 30_000;

export default function Page() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

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
                      <a
                        href={job.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate text-primary underline-offset-2 hover:underline"
                        title={job.title ? `${job.title}\n${job.url}` : job.url}
                      >
                        {job.title || job.url}
                      </a>
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
                      {file ? (
                        <a
                          href={`/api/files/${encodeURIComponent(file)}`}
                          className="text-sm text-primary underline-offset-2 hover:underline"
                        >
                          Download
                        </a>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
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
