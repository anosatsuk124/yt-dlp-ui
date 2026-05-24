CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  format       TEXT NOT NULL,
  extra_args   TEXT,
  cookies_file TEXT,
  status       TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','canceled')),
  progress     REAL NOT NULL DEFAULT 0,
  speed        TEXT,
  eta          TEXT,
  title        TEXT,
  file_path    TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
