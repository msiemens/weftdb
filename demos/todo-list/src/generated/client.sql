-- weft schema 1 b8be970dfc1f4ffb1b03a7746848707c6ed709ef676f189db1ee7d5796cc3731
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
  kind TEXT NOT NULL CHECK (kind IN ('create','set','delete','restore','append'))
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
  rejected_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  server_value TEXT,
  row_identity INTEGER
);

CREATE TABLE IF NOT EXISTS tombstones (
  scope_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  diff3_base TEXT,
  PRIMARY KEY (scope_id, table_name, row_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  scope_id TEXT PRIMARY KEY,
  last_server_seq INTEGER NOT NULL DEFAULT 0,
  hlc_last TEXT,
  resync_required INTEGER NOT NULL DEFAULT 0,
  server_epoch TEXT
);

CREATE TABLE IF NOT EXISTS "todos" (
  "id" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL,
  "created" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "notes" TEXT NOT NULL,
  "done" INTEGER NOT NULL,
  "rank" TEXT NOT NULL,
  "due_at" INTEGER,
  "auto_delete_days" INTEGER,
  "_weft_hlc_id" TEXT,
  "_weft_hlc_scope_id" TEXT,
  "_weft_hlc_created" TEXT,
  "_weft_hlc_title" TEXT,
  "_weft_hlc_notes" TEXT,
  "_weft_base_notes" TEXT,
  "_weft_hlc_done" TEXT,
  "_weft_hlc_rank" TEXT,
  "_weft_hlc_due_at" TEXT,
  "_weft_hlc_auto_delete_days" TEXT,
  _weft_first_synced_at INTEGER,
  _weft_rev INTEGER NOT NULL DEFAULT 0,
  _weft_dirty INTEGER NOT NULL DEFAULT 0,
  _weft_null_fields TEXT,
  PRIMARY KEY (scope_id, id)
);

CREATE INDEX IF NOT EXISTS "todos_rank" ON "todos" (scope_id, "rank");

CREATE TABLE IF NOT EXISTS "todo_events" (
  "id" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL,
  "created" TEXT NOT NULL,
  "todo_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "_weft_hlc_id" TEXT,
  "_weft_hlc_scope_id" TEXT,
  "_weft_hlc_created" TEXT,
  "_weft_hlc_todo_id" TEXT,
  "_weft_hlc_kind" TEXT,
  "_weft_hlc_actor" TEXT,
  _weft_first_synced_at INTEGER,
  _weft_rev INTEGER NOT NULL DEFAULT 0,
  _weft_dirty INTEGER NOT NULL DEFAULT 0,
  _weft_null_fields TEXT,
  PRIMARY KEY (scope_id, id)
);

CREATE INDEX IF NOT EXISTS "todo_events_kind" ON "todo_events" (scope_id, "kind");
