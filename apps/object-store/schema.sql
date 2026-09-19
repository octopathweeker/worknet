CREATE TABLE IF NOT EXISTS objects (
  hash TEXT PRIMARY KEY CHECK (length(hash) = 66),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 262144),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dashboard (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 262144),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_state (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 524288),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_commands (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) <= 16384),
  status TEXT NOT NULL CHECK (status IN ('queued','complete','failed')),
  result TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_queue ON workspace_commands(status, created_at);
