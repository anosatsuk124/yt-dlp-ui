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
  finished_at  INTEGER,
  mega_status      TEXT,
  mega_uploaded_at INTEGER,
  mega_error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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
);
