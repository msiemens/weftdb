-- weft schema 1 e8279556a58f7a355065bb4df2440d7e57397e43b6c7392efe33468e58eddd1a
CREATE TABLE IF NOT EXISTS fields (
  scope_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  hlc TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  txn_id TEXT NOT NULL,
  PRIMARY KEY (scope_id, table_name, row_id, field)
);
CREATE INDEX IF NOT EXISTS fields_scope_seq ON fields (scope_id, server_seq);

CREATE TABLE IF NOT EXISTS rows (
  scope_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('row','append')),
  deleted_hlc TEXT,
  register_hlc TEXT,
  server_seq INTEGER NOT NULL,
  PRIMARY KEY (scope_id, table_name, row_id)
);
CREATE INDEX IF NOT EXISTS rows_scope_seq ON rows (scope_id, server_seq);

CREATE TABLE IF NOT EXISTS scope_state (
  scope_id TEXT PRIMARY KEY,
  server_seq INTEGER NOT NULL,
  tombstone_floor_seq INTEGER NOT NULL,
  schema_hash TEXT,
  schema_version INTEGER,
  epoch TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  scope_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (scope_id, device_id)
);
