import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "./env";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export interface JobRow {
  id: string;
  url: string;
  format: string;
  extra_args: string | null;
  cookies_file: string | null;
  status: JobStatus;
  progress: number;
  speed: string | null;
  eta: string | null;
  title: string | null;
  file_path: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });

  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("synchronous = NORMAL");
  conn.pragma("foreign_keys = ON");

  // Idempotent schema, no migration framework needed for two tables.
  const schemaPath = path.resolve(process.cwd(), "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  conn.exec(schema);

  _db = conn;
  return conn;
}

// --- helpers ---------------------------------------------------------------

export function insertJob(row: Omit<JobRow, "progress" | "speed" | "eta" | "title" | "file_path" | "error" | "started_at" | "finished_at">): void {
  db().prepare(`
    INSERT INTO jobs (id, url, format, extra_args, cookies_file, status, created_at)
    VALUES (@id, @url, @format, @extra_args, @cookies_file, @status, @created_at)
  `).run(row);
}

export function getJob(id: string): JobRow | undefined {
  return db().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

export function listActiveJobs(): JobRow[] {
  return db().prepare(
    "SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at ASC",
  ).all() as JobRow[];
}

export function listHistory(limit = 100, offset = 0): JobRow[] {
  return db().prepare(`
    SELECT * FROM jobs
    WHERE status IN ('completed','failed','canceled')
    ORDER BY COALESCE(finished_at, created_at) DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as JobRow[];
}

export function countHistory(): number {
  const r = db().prepare(`
    SELECT COUNT(*) AS n FROM jobs
    WHERE status IN ('completed','failed','canceled')
  `).get() as { n: number };
  return r.n;
}

export function updateJobStatus(id: string, status: JobStatus, extras: Partial<Pick<JobRow, "file_path" | "error" | "started_at" | "finished_at" | "title">> = {}): void {
  const fields: string[] = ["status = @status"];
  const params: Record<string, unknown> = { id, status };
  if (extras.file_path !== undefined) { fields.push("file_path = @file_path"); params.file_path = extras.file_path; }
  if (extras.error !== undefined)     { fields.push("error = @error");         params.error     = extras.error; }
  if (extras.started_at !== undefined){ fields.push("started_at = @started_at"); params.started_at = extras.started_at; }
  if (extras.finished_at !== undefined){fields.push("finished_at = @finished_at"); params.finished_at = extras.finished_at; }
  if (extras.title !== undefined)     { fields.push("title = @title");         params.title     = extras.title; }
  db().prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = @id`).run(params);
}

export function updateJobProgress(id: string, progress: number, speed: string | null, eta: string | null): void {
  db().prepare(`
    UPDATE jobs SET progress = ?, speed = ?, eta = ? WHERE id = ?
  `).run(progress, speed, eta, id);
}

export function getSetting(key: string): string | undefined {
  const r = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value;
}

export function setSetting(key: string, value: string): void {
  db().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
