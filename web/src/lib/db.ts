import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "./env";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export type MegaStatus = "pending" | "uploading" | "uploaded" | "failed" | "canceled";

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
  mega_status: MegaStatus | null;
  mega_uploaded_at: number | null;
  mega_error: string | null;
  mega_progress: number;
  mega_speed: string | null;
  container: string | null;
  compat: string | null;
  content_hash: string | null;
  save_as: string | null;
  mega_remote_name: string | null;
  // Per-job override for whether the local copy is kept after a successful MEGA
  // upload: 1 = keep, 0 = delete, NULL = defer to the `mega_keep_local` setting.
  mega_keep_local: number | null;
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

  migrate(conn);

  _db = conn;
  return conn;
}

function migrate(conn: Database.Database): void {
  const cols = new Set(
    (conn.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>)
      .map(c => c.name),
  );
  if (!cols.has("mega_status"))      conn.exec("ALTER TABLE jobs ADD COLUMN mega_status TEXT");
  if (!cols.has("mega_uploaded_at")) conn.exec("ALTER TABLE jobs ADD COLUMN mega_uploaded_at INTEGER");
  if (!cols.has("mega_error"))       conn.exec("ALTER TABLE jobs ADD COLUMN mega_error TEXT");
  if (!cols.has("mega_progress"))    conn.exec("ALTER TABLE jobs ADD COLUMN mega_progress REAL NOT NULL DEFAULT 0");
  if (!cols.has("mega_speed"))       conn.exec("ALTER TABLE jobs ADD COLUMN mega_speed TEXT");
  if (!cols.has("container"))        conn.exec("ALTER TABLE jobs ADD COLUMN container TEXT");
  if (!cols.has("compat"))           conn.exec("ALTER TABLE jobs ADD COLUMN compat TEXT");
  if (!cols.has("content_hash"))     conn.exec("ALTER TABLE jobs ADD COLUMN content_hash TEXT");
  if (!cols.has("save_as"))          conn.exec("ALTER TABLE jobs ADD COLUMN save_as TEXT");
  if (!cols.has("mega_remote_name")) conn.exec("ALTER TABLE jobs ADD COLUMN mega_remote_name TEXT");
  if (!cols.has("mega_keep_local"))  conn.exec("ALTER TABLE jobs ADD COLUMN mega_keep_local INTEGER");

  // Identity index for the pre-download conflict check (same url+format+container).
  conn.exec("CREATE INDEX IF NOT EXISTS idx_jobs_identity ON jobs(url, format, container)");

  // The auth_bindings table is declared in schema.sql so a fresh DB picks it
  // up via the idempotent CREATE TABLE pass. Re-state it here so a DB that
  // existed before this feature still gets it after pulling the new code,
  // without needing to delete app.db.
  conn.exec(`
    CREATE TABLE IF NOT EXISTS auth_bindings (
      domain               TEXT PRIMARY KEY,
      username             TEXT,
      password             TEXT,
      video_password       TEXT,
      ap_mso               TEXT,
      ap_username          TEXT,
      ap_password          TEXT,
      client_cert_file     TEXT,
      client_cert_key_file TEXT,
      client_cert_password TEXT,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    )
  `);
}

// --- helpers ---------------------------------------------------------------

export function insertJob(row: {
  id: string;
  url: string;
  format: string;
  container: string | null;
  compat: string | null;
  extra_args: string | null;
  cookies_file: string | null;
  status: JobStatus;
  created_at: number;
  save_as?: string | null;
  // 1/0 to pin the keep-local decision for this job; null/undefined defers to
  // the global `mega_keep_local` setting at upload time.
  mega_keep_local?: number | null;
}): void {
  db().prepare(`
    INSERT INTO jobs (id, url, format, container, compat, extra_args, cookies_file, status, created_at, save_as, mega_keep_local)
    VALUES (@id, @url, @format, @container, @compat, @extra_args, @cookies_file, @status, @created_at, @save_as, @mega_keep_local)
  `).run({ save_as: null, mega_keep_local: null, ...row });
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

export function updateJobTitle(id: string, title: string): void {
  // Don't overwrite an existing title — yt-dlp emits before_dl twice for
  // combo formats and the value should be identical, but in any case the
  // first one to arrive wins.
  db().prepare(`
    UPDATE jobs SET title = ? WHERE id = ? AND (title IS NULL OR title = '')
  `).run(title, id);
}

export function deleteJob(id: string): void {
  db().prepare("DELETE FROM jobs WHERE id = ?").run(id);
}

// Record the sha256 content hash and the (possibly renamed) final path of a
// completed download. Called from server.ts right after hashing the file.
export function updateJobHash(id: string, hash: string, filePath: string): void {
  db().prepare(
    "UPDATE jobs SET content_hash = ?, file_path = ? WHERE id = ?",
  ).run(hash, filePath, id);
}

// Find a prior completed-or-uploaded download with the exact same identity
// (url + format + container). Used for the pre-download conflict prompt and
// for overwrite resolution. The newest such row wins.
export function findExistingByIdentity(
  url: string,
  format: string,
  container: string | null,
): JobRow | undefined {
  return db().prepare(`
    SELECT * FROM jobs
    WHERE url = @url AND format = @format
      AND IFNULL(container, '') = IFNULL(@container, '')
      AND (status = 'completed' OR mega_status = 'uploaded')
    ORDER BY COALESCE(finished_at, created_at) DESC
    LIMIT 1
  `).get({ url, format, container: container ?? "" }) as JobRow | undefined;
}

// Completed/uploaded jobs that have no content hash yet — the backfill-hash
// maintenance task re-downloads each to compute it.
export function listJobsMissingHash(): JobRow[] {
  return db().prepare(`
    SELECT * FROM jobs
    WHERE (content_hash IS NULL OR content_hash = '')
      AND (status = 'completed' OR mega_status = 'uploaded')
    ORDER BY COALESCE(finished_at, created_at) DESC
  `).all() as JobRow[];
}

// Remember the basename we uploaded to MEGA so an overwrite/maintenance pass
// can delete the right remote node later.
export function setMegaRemoteName(id: string, name: string): void {
  db().prepare("UPDATE jobs SET mega_remote_name = ? WHERE id = ?").run(name, id);
}

// Mark any rows still tagged 'running' or 'queued' as 'failed'. Called on
// startup, after we've checked which ids the downloader is actually still
// tracking — anything not in `aliveIds` is an orphan from a previous run.
// Returns the captured file_path of each row that was marked, so the caller
// can sweep any leftover .part / .ytdl / fragment files.
export function reconcileOrphans(aliveIds: Set<string>): string[] {
  const stale = db().prepare(
    "SELECT id, file_path FROM jobs WHERE status IN ('queued','running')",
  ).all() as { id: string; file_path: string | null }[];
  if (stale.length === 0) return [];

  const now = Date.now();
  const stmt = db().prepare(`
    UPDATE jobs
       SET status = 'failed',
           error  = COALESCE(error, 'interrupted: web restarted before downloader reported completion'),
           finished_at = ?
     WHERE id = ?
  `);
  const cleanupPaths: string[] = [];
  for (const { id, file_path } of stale) {
    if (aliveIds.has(id)) continue;
    stmt.run(now, id);
    if (file_path) cleanupPaths.push(file_path);
  }
  return cleanupPaths;
}

export function markMegaPending(id: string): void {
  db().prepare(
    "UPDATE jobs SET mega_status = 'pending', mega_error = NULL WHERE id = ?",
  ).run(id);
}

export function markMegaUploading(id: string): void {
  db().prepare(
    "UPDATE jobs SET mega_status = 'uploading', mega_error = NULL, mega_progress = 0, mega_speed = NULL WHERE id = ?",
  ).run(id);
}

export function updateMegaProgress(id: string, progress: number, speed: string | null): void {
  db().prepare("UPDATE jobs SET mega_progress = ?, mega_speed = ? WHERE id = ?").run(progress, speed, id);
}

export function markMegaUploaded(id: string, uploadedAt: number): void {
  db().prepare(
    "UPDATE jobs SET mega_status = 'uploaded', mega_uploaded_at = ?, mega_error = NULL, mega_progress = 100, mega_speed = NULL WHERE id = ?",
  ).run(uploadedAt, id);
}

export function markMegaFailed(id: string, err: string): void {
  db().prepare(
    "UPDATE jobs SET mega_status = 'failed', mega_error = ? WHERE id = ?",
  ).run(err, id);
}

export function markMegaCanceled(id: string, reason: string): void {
  db().prepare(
    "UPDATE jobs SET mega_status = 'canceled', mega_error = ?, mega_speed = NULL WHERE id = ?",
  ).run(reason, id);
}

export function listJobsPendingMegaUpload(): JobRow[] {
  return db().prepare(`
    SELECT * FROM jobs
    WHERE mega_status IN ('pending','uploading')
      AND file_path IS NOT NULL
    ORDER BY finished_at ASC
  `).all() as JobRow[];
}

// --- auth bindings ---------------------------------------------------------

export interface AuthBindingRow {
  domain:               string;
  username:             string | null;
  password:             string | null;
  video_password:       string | null;
  ap_mso:               string | null;
  ap_username:          string | null;
  ap_password:          string | null;
  client_cert_file:     string | null;
  client_cert_key_file: string | null;
  client_cert_password: string | null;
  created_at:           number;
  updated_at:           number;
}

export function getAuthBinding(domain: string): AuthBindingRow | undefined {
  return db()
    .prepare("SELECT * FROM auth_bindings WHERE domain = ?")
    .get(domain) as AuthBindingRow | undefined;
}

export function listAuthBindings(): AuthBindingRow[] {
  return db()
    .prepare("SELECT * FROM auth_bindings ORDER BY domain ASC")
    .all() as AuthBindingRow[];
}

// upsertAuthBinding writes the row, treating `undefined` fields in `patch`
// as "leave the existing value alone" (so the UI can save a binding without
// re-typing every password). An explicit `null` clears the field.
export function upsertAuthBinding(
  domain: string,
  patch: Partial<Omit<AuthBindingRow, "domain" | "created_at" | "updated_at">>,
): void {
  const now = Date.now();
  const existing = getAuthBinding(domain);
  const merged: AuthBindingRow = {
    domain,
    username:             pick(patch.username,             existing?.username             ?? null),
    password:             pick(patch.password,             existing?.password             ?? null),
    video_password:       pick(patch.video_password,       existing?.video_password       ?? null),
    ap_mso:               pick(patch.ap_mso,               existing?.ap_mso               ?? null),
    ap_username:          pick(patch.ap_username,          existing?.ap_username          ?? null),
    ap_password:          pick(patch.ap_password,          existing?.ap_password          ?? null),
    client_cert_file:     pick(patch.client_cert_file,     existing?.client_cert_file     ?? null),
    client_cert_key_file: pick(patch.client_cert_key_file, existing?.client_cert_key_file ?? null),
    client_cert_password: pick(patch.client_cert_password, existing?.client_cert_password ?? null),
    created_at:           existing?.created_at ?? now,
    updated_at:           now,
  };
  db().prepare(`
    INSERT INTO auth_bindings (
      domain, username, password, video_password,
      ap_mso, ap_username, ap_password,
      client_cert_file, client_cert_key_file, client_cert_password,
      created_at, updated_at
    ) VALUES (
      @domain, @username, @password, @video_password,
      @ap_mso, @ap_username, @ap_password,
      @client_cert_file, @client_cert_key_file, @client_cert_password,
      @created_at, @updated_at
    )
    ON CONFLICT(domain) DO UPDATE SET
      username             = excluded.username,
      password             = excluded.password,
      video_password       = excluded.video_password,
      ap_mso               = excluded.ap_mso,
      ap_username          = excluded.ap_username,
      ap_password          = excluded.ap_password,
      client_cert_file     = excluded.client_cert_file,
      client_cert_key_file = excluded.client_cert_key_file,
      client_cert_password = excluded.client_cert_password,
      updated_at           = excluded.updated_at
  `).run(merged);
}

function pick<T>(patchVal: T | undefined, existing: T): T {
  return patchVal === undefined ? existing : patchVal;
}

export function deleteAuthBinding(domain: string): boolean {
  const r = db().prepare("DELETE FROM auth_bindings WHERE domain = ?").run(domain);
  return r.changes > 0;
}

// ---------------------------------------------------------------------------

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
