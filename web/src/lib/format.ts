// Small UI-side formatting helpers. Server-side equivalents live in db.ts /
// cookies.ts; these are intentionally separate so they can be imported into
// client components without dragging Node modules along.

// Type-only import — keeps the client bundle free of better-sqlite3.
import type { JobStatus } from "@/lib/db";

export function timeAgo(ms: number | null | undefined): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

// Tailwind classes for status badges. Active states (queued/running) appear
// on the Queue page; the terminal three appear on the History page.
export function statusBadgeClass(status: JobStatus): string {
  switch (status) {
    case "queued":
      return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
    case "running":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300";
    case "completed":
      return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300";
    case "failed":
      return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
    case "canceled":
      return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  }
}
