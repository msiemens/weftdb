-- weft schema 1 f2c7fb5d248392d477eccb1b38edb4d76a3bbd30d60c809876c4842e94777163
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  field TEXT,
  value TEXT,
  hlc TEXT NOT NULL,
  base_hash TEXT,
  txn_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create','set','delete','restore','append')),
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outbox_quarantine (
  seq INTEGER,
  scope_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  field TEXT,
  value TEXT,
  hlc TEXT NOT NULL,
  base_hash TEXT,
  txn_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  rejected_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  server_value TEXT
);

CREATE TABLE IF NOT EXISTS tombstones (
  scope_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  PRIMARY KEY (scope_id, table_name, row_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  scope_id TEXT PRIMARY KEY,
  last_server_seq INTEGER NOT NULL DEFAULT 0,
  schema_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  hlc_last TEXT,
  resync_required INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "projects" (
  "id" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL,
  "created" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "rank" TEXT NOT NULL,
  "_weft_hlc_id" TEXT,
  "_weft_hlc_scope_id" TEXT,
  "_weft_hlc_created" TEXT,
  "_weft_hlc_name" TEXT,
  "_weft_hlc_rank" TEXT,
  _weft_first_synced_at INTEGER,
  _weft_rev INTEGER NOT NULL DEFAULT 0,
  _weft_dirty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, id)
);

CREATE TABLE IF NOT EXISTS "issues" (
  "id" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL,
  "created" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('open', 'started', 'closed', '"open"', '"started"', '"closed"')),
  "rank" TEXT NOT NULL,
  "_weft_hlc_id" TEXT,
  "_weft_hlc_scope_id" TEXT,
  "_weft_hlc_created" TEXT,
  "_weft_hlc_project_id" TEXT,
  "_weft_hlc_title" TEXT,
  "_weft_hlc_body" TEXT,
  "_weft_base_body" TEXT,
  "_weft_hlc_status" TEXT,
  "_weft_hlc_rank" TEXT,
  _weft_first_synced_at INTEGER,
  _weft_rev INTEGER NOT NULL DEFAULT 0,
  _weft_dirty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, id)
);

CREATE TABLE IF NOT EXISTS "comments" (
  "id" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL,
  "created" TEXT NOT NULL,
  "issue_id" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "rank" TEXT NOT NULL,
  "author__label" TEXT NOT NULL,
  "author__device" TEXT NOT NULL,
  "_weft_hlc_id" TEXT,
  "_weft_hlc_scope_id" TEXT,
  "_weft_hlc_created" TEXT,
  "_weft_hlc_issue_id" TEXT,
  "_weft_hlc_body" TEXT,
  "_weft_hlc_rank" TEXT,
  "_weft_hlc_author__label" TEXT,
  "_weft_hlc_author__device" TEXT,
  _weft_first_synced_at INTEGER,
  _weft_rev INTEGER NOT NULL DEFAULT 0,
  _weft_dirty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, id)
);
