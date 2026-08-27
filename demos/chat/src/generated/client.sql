-- weft schema 1 e67e32dc64c4f9388e4a5231290582fbe8a25676c655069d98b900c35d12c6cf
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
  PRIMARY KEY (scope_id, table_name, row_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  scope_id TEXT PRIMARY KEY,
  last_server_seq INTEGER NOT NULL DEFAULT 0,
  hlc_last TEXT,
  resync_required INTEGER NOT NULL DEFAULT 0,
  server_epoch TEXT
);

CREATE TABLE IF NOT EXISTS "messages" (
  "id" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL,
  "created" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "device" TEXT NOT NULL,
  "author" TEXT NOT NULL,
  "_weft_hlc_id" TEXT,
  "_weft_hlc_scope_id" TEXT,
  "_weft_hlc_created" TEXT,
  "_weft_hlc_body" TEXT,
  "_weft_hlc_device" TEXT,
  "_weft_hlc_author" TEXT,
  _weft_first_synced_at INTEGER,
  _weft_rev INTEGER NOT NULL DEFAULT 0,
  _weft_dirty INTEGER NOT NULL DEFAULT 0,
  _weft_null_fields TEXT,
  PRIMARY KEY (scope_id, id)
);

CREATE TABLE IF NOT EXISTS "devices" (
  "id" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL,
  "created" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "last_seen" INTEGER NOT NULL,
  "_weft_hlc_id" TEXT,
  "_weft_hlc_scope_id" TEXT,
  "_weft_hlc_created" TEXT,
  "_weft_hlc_label" TEXT,
  "_weft_hlc_last_seen" TEXT,
  _weft_first_synced_at INTEGER,
  _weft_rev INTEGER NOT NULL DEFAULT 0,
  _weft_dirty INTEGER NOT NULL DEFAULT 0,
  _weft_null_fields TEXT,
  PRIMARY KEY (scope_id, id)
);

CREATE INDEX IF NOT EXISTS "devices_label" ON "devices" (scope_id, "label");
