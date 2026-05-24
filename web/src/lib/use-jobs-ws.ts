"use client";

// React hook that maintains a live view of active jobs by consuming
// /api/ws. Terminal-status jobs (completed/failed/canceled) are evicted
// from the in-memory map — the History page fetches those separately.
//
// Reconnects with exponential backoff capped at 10s.

import { useEffect, useRef, useState } from "react";
// Type-only import keeps the client bundle free of better-sqlite3.
import type { JobRow, JobStatus } from "@/lib/db";

type SnapshotEvent = { type: "snapshot"; jobs: JobRow[] };
type ProgressEvent = {
  type: "progress";
  id: string;
  // Optional because the downloader's Event struct uses `json:"...,omitempty"`,
  // so progress=0 (start of download, total bytes not yet known) yields
  // an event without the field at all.
  progress?: number;
  speed?: string | null;
  eta?: string | null;
  downloaded?: number;
  total?: number;
};
type StatusEvent = {
  type: "status";
  id: string;
  status: JobStatus;
  filePath?: string;
  error?: string;
};
type TitleEvent = { type: "title"; id: string; title: string };

type WsEvent = SnapshotEvent | ProgressEvent | StatusEvent | TitleEvent;

const TERMINAL: ReadonlySet<JobStatus> = new Set(["completed", "failed", "canceled"]);

export function useJobsWs(): { connected: boolean; jobs: JobRow[] } {
  const [connected, setConnected] = useState(false);
  // We keep the canonical state as a Map<id, JobRow> in a ref so events
  // can merge in place without thrashing; then mirror to a sorted array
  // in state for the consumer to re-render off of.
  const jobsRef = useRef<Map<string, JobRow>>(new Map());
  const [jobs, setJobs] = useState<JobRow[]>([]);

  const flush = () => {
    const next = Array.from(jobsRef.current.values()).sort(
      (a, b) => a.created_at - b.created_at,
    );
    setJobs(next);
  };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/ws`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };

      ws.onmessage = (msg) => {
        let ev: WsEvent;
        try {
          ev = JSON.parse(msg.data) as WsEvent;
        } catch {
          return;
        }

        const map = jobsRef.current;
        switch (ev.type) {
          case "snapshot": {
            map.clear();
            for (const j of ev.jobs) map.set(j.id, j);
            flush();
            break;
          }
          case "progress": {
            const existing = map.get(ev.id);
            if (!existing) return;
            // Go's encoding/json omits zero-valued fields (omitempty), so a
            // progress event with downloaded_bytes=0 has no `progress` field.
            // Treat any missing numeric as "keep current".
            map.set(ev.id, {
              ...existing,
              progress: typeof ev.progress === "number" ? ev.progress : existing.progress,
              speed: ev.speed ?? existing.speed,
              eta: ev.eta ?? existing.eta,
            });
            flush();
            break;
          }
          case "status": {
            if (TERMINAL.has(ev.status)) {
              if (map.delete(ev.id)) flush();
              return;
            }
            const existing = map.get(ev.id);
            if (existing) {
              map.set(ev.id, {
                ...existing,
                status: ev.status,
                error: ev.error ?? existing.error,
                file_path: ev.filePath ?? existing.file_path,
              });
            } else {
              // Status arriving for a job we don't yet have (e.g. raced
              // ahead of the initial snapshot). Synthesize a minimal row
              // so the UI doesn't drop it on the floor.
              map.set(ev.id, {
                id: ev.id,
                url: "",
                format: "",
                extra_args: null,
                cookies_file: null,
                status: ev.status,
                progress: 0,
                speed: null,
                eta: null,
                title: null,
                file_path: ev.filePath ?? null,
                error: ev.error ?? null,
                created_at: Date.now(),
                started_at: null,
                finished_at: null,
                mega_status: null,
                mega_uploaded_at: null,
                mega_error: null,
              });
            }
            flush();
            break;
          }
          case "title": {
            const existing = map.get(ev.id);
            if (!existing) return;
            map.set(ev.id, { ...existing, title: ev.title });
            flush();
            break;
          }
        }
      };

      ws.onclose = () => {
        setConnected(false);
        ws = null;
        if (closed) return;
        // Exponential backoff: 500ms, 1s, 2s, 4s, capped at 10s.
        const delay = Math.min(500 * 2 ** attempt, 10_000);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // Let onclose handle reconnection.
        try { ws?.close(); } catch { /* ignore */ }
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
      }
    };
  }, []);

  return { connected, jobs };
}
