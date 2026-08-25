import {
  decodeWireValue,
  encodeWireValue,
  fieldName,
  rowId,
  schemaHashValue,
  scopeId,
  tableName,
  txnId,
  type HlcString,
  type ScopeId,
  type SqlExecutor,
  type SqlRow,
  type WeftOp,
} from "weftdb/shared";
import { generateServerDdl } from "weftdb/codegen";
import { splitSql } from "../sql.ts";
import {
  fieldKey,
  rowKey,
  WeftServer,
  type DeviceRecord,
  type FieldRecord,
  type HandshakeRequest,
  type HandshakeResponse,
  type PullBatch,
  type PushOutcome,
  type RowRecord,
  type ScopeState,
  type Snapshot,
} from "./index.ts";

export class SqliteWeftServer extends WeftServer {
  readonly executor: SqlExecutor;
  /** Scopes already read out of storage; the rest are read the first time they are asked for. */
  private readonly loaded = new Set<ScopeId>();

  constructor(executor: SqlExecutor, now: () => number = Date.now, skewThresholdMs?: number) {
    super(now, skewThresholdMs);
    this.executor = executor;
    this.installSchema();
    this.load();
  }

  override handshake(request: HandshakeRequest): HandshakeResponse {
    const result = super.handshake(request);
    this.persistScope(request.scopeId);
    return result;
  }

  override push(scopeId: ScopeId, ops: WeftOp[]): PushOutcome {
    const result = super.push(scopeId, ops);
    // A rejected push can still have applied the transactions before the rejected one, and the
    // client is told they were acknowledged. Persisting only on success would leave those on
    // the floor at the next restart, having already promised them.
    if (result.acks.length > 0) this.persistScope(scopeId);
    return result;
  }

  override pull(scopeId: ScopeId, lastServerSeq: number): PullBatch {
    this.loadScope(scopeId);
    return super.pull(scopeId, lastServerSeq);
  }

  override snapshot(scopeId: ScopeId): Snapshot {
    this.loadScope(scopeId);
    return super.snapshot(scopeId);
  }

  snapshotInReadTransaction(scopeId: ScopeId): Snapshot {
    return this.executor.transaction(() => this.snapshot(scopeId));
  }

  override pruneTombstones(scopeId: ScopeId, olderThanMs?: number): number {
    const count = super.pruneTombstones(scopeId, olderThanMs);
    this.persistScope(scopeId);
    return count;
  }

  private installSchema(): void {
    for (const sql of splitSql(generateServerDdl())) {
      this.executor.run({ sql, parameters: [] });
    }
  }

  private load(): void {
    for (const scope of this.executor.all(scopeStatement())) {
      this.scopes.set(scope.scopeId, scope);
      this.loadScope(scope.scopeId);
    }
    for (const device of this.executor.all(devicesStatement())) {
      this.devices.set(deviceStoreKey(device.scopeId, device.deviceId), device);
    }
  }

  /**
   * Reads a scope in once. Memory is where the protocol runs and storage is written behind it,
   * so re-reading on every pull would cost the size of the scope to answer a question about
   * three records — and, worse, would overwrite anything memory holds that storage has not
   * caught up with, quietly undoing it.
   */
  private loadScope(scopeIdValue: ScopeId): void {
    if (this.loaded.has(scopeIdValue)) return;
    this.loaded.add(scopeIdValue);
    for (const field of this.executor.all(fieldsStatement(scopeIdValue))) {
      this.fields.set(fieldKey(field), field);
    }
    for (const row of this.executor.all(rowsStatement(scopeIdValue))) {
      this.rows.set(rowKey(row), row);
    }
  }

  /**
   * Writes what the last operation touched, and nothing else. Rewriting the scope would make
   * the cost of accepting one field the size of the scope — a relay holding ten thousand rows
   * would spend a tenth of a second storing a changed word.
   *
   * A touched key whose record is gone from memory was removed rather than written, which is
   * how a prune reaches storage without a separate path.
   */
  private persistScope(scopeIdValue: ScopeId): void {
    this.executor.transaction(() => {
      // Keys are dropped as they are written rather than cleared at the end: a key belonging to
      // another scope is another scope's still-pending write, and clearing it would lose it.
      for (const key of [...this.touchedFields]) {
        const field = this.fields.get(key);
        if (field === undefined) {
          const [scope, table, row, name] = key.split("\0");
          if (scope !== scopeIdValue) continue;
          this.touchedFields.delete(key);
          this.executor.run({
            sql: "DELETE FROM fields WHERE scope_id = ? AND table_name = ? AND row_id = ? AND field = ?",
            parameters: [scope, table ?? "", row ?? "", name ?? ""],
          });
          continue;
        }
        if (field.scopeId !== scopeIdValue) continue;
        this.touchedFields.delete(key);
        this.executor.run({
          sql: `INSERT INTO fields (scope_id, table_name, row_id, field, value, hlc, server_seq, txn_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(scope_id, table_name, row_id, field) DO UPDATE SET
  value = excluded.value,
  hlc = excluded.hlc,
  server_seq = excluded.server_seq,
  txn_id = excluded.txn_id`,
          parameters: [
            field.scopeId,
            field.tableName,
            field.rowId,
            field.field,
            encodeWireValue(field.value),
            field.hlc,
            field.serverSeq,
            field.txnId,
          ],
        });
      }
      for (const key of [...this.touchedRows]) {
        const row = this.rows.get(key);
        if (row === undefined) {
          const [scope, table, rowIdValue] = key.split("\0");
          if (scope !== scopeIdValue) continue;
          this.touchedRows.delete(key);
          this.executor.run({
            sql: "DELETE FROM rows WHERE scope_id = ? AND table_name = ? AND row_id = ?",
            parameters: [scope, table ?? "", rowIdValue ?? ""],
          });
          continue;
        }
        if (row.scopeId !== scopeIdValue) continue;
        this.touchedRows.delete(key);
        this.executor.run({
          sql: `INSERT INTO rows (scope_id, table_name, row_id, first_seen_at, class, deleted_hlc, register_hlc, server_seq)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(scope_id, table_name, row_id) DO UPDATE SET
  first_seen_at = excluded.first_seen_at,
  class = excluded.class,
  deleted_hlc = excluded.deleted_hlc,
  register_hlc = excluded.register_hlc,
  server_seq = excluded.server_seq`,
          parameters: [
            row.scopeId,
            row.tableName,
            row.rowId,
            row.firstSeenAt,
            row.class,
            row.deletedHlc,
            row.registerHlc,
            row.serverSeq,
          ],
        });
      }
      for (const key of [...this.touchedDevices]) {
        const device = this.devices.get(key);
        if (device === undefined || device.scopeId !== scopeIdValue) continue;
        this.touchedDevices.delete(key);
        this.executor.run({
          sql: `INSERT INTO devices (scope_id, device_id, last_seen)
VALUES (?, ?, ?)
ON CONFLICT(scope_id, device_id) DO UPDATE SET last_seen = excluded.last_seen`,
          parameters: [device.scopeId, device.deviceId, device.lastSeen],
        });
      }
      const scope = this.scopes.get(scopeIdValue);
      if (scope) {
        this.executor.run({
          sql: `INSERT INTO scope_state (scope_id, server_seq, tombstone_floor_seq, schema_hash, schema_version)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(scope_id) DO UPDATE SET
  server_seq = excluded.server_seq,
  tombstone_floor_seq = excluded.tombstone_floor_seq,
  schema_hash = excluded.schema_hash,
  schema_version = excluded.schema_version`,
          parameters: [
            scopeIdValue,
            scope.serverSeq,
            scope.tombstoneFloorSeq,
            scope.schemaHash ?? null,
            scope.schemaVersion ?? null,
          ],
        });
      }
    });
  }
}

function scopeStatement() {
  return {
    sql: "SELECT scope_id, server_seq, tombstone_floor_seq, schema_hash, schema_version FROM scope_state",
    parameters: [],
    decode: decodeScope,
  };
}

function fieldsStatement(scopeIdValue: ScopeId) {
  return {
    sql: "SELECT scope_id, table_name, row_id, field, value, hlc, server_seq, txn_id FROM fields WHERE scope_id = ?",
    parameters: [scopeIdValue],
    decode: decodeField,
  };
}

function rowsStatement(scopeIdValue: ScopeId) {
  return {
    sql: "SELECT scope_id, table_name, row_id, first_seen_at, class, deleted_hlc, register_hlc, server_seq FROM rows WHERE scope_id = ?",
    parameters: [scopeIdValue],
    decode: decodeRow,
  };
}

function devicesStatement() {
  return {
    sql: "SELECT scope_id, device_id, last_seen FROM devices",
    parameters: [],
    decode: decodeDevice,
  };
}

function decodeScope(row: SqlRow): ScopeState & { readonly scopeId: ScopeId } {
  const hash = nullableString(column(row, "schema_hash"));
  return {
    scopeId: scopeId(requiredString(column(row, "scope_id"))),
    serverSeq: requiredNumber(column(row, "server_seq")),
    tombstoneFloorSeq: requiredNumber(column(row, "tombstone_floor_seq")),
    ...(hash === null ? {} : { schemaHash: schemaHashValue(hash) }),
    ...(column(row, "schema_version") === null ? {} : { schemaVersion: requiredNumber(column(row, "schema_version")) }),
  };
}

function decodeField(row: SqlRow): FieldRecord {
  return {
    scopeId: scopeId(requiredString(column(row, "scope_id"))),
    tableName: tableName(requiredString(column(row, "table_name"))),
    rowId: rowId(requiredString(column(row, "row_id"))),
    field: fieldName(requiredString(column(row, "field"))),
    value: decodeWireValue(nullableString(column(row, "value"))),
    hlc: requiredString(column(row, "hlc")) as HlcString,
    serverSeq: requiredNumber(column(row, "server_seq")),
    txnId: txnId(requiredString(column(row, "txn_id"))),
  };
}

function decodeRow(row: SqlRow): RowRecord {
  const rowClass = requiredString(column(row, "class"));
  if (rowClass !== "row" && rowClass !== "append") throw new Error(`invalid row class: ${rowClass}`);
  return {
    scopeId: scopeId(requiredString(column(row, "scope_id"))),
    tableName: tableName(requiredString(column(row, "table_name"))),
    rowId: rowId(requiredString(column(row, "row_id"))),
    firstSeenAt: requiredNumber(column(row, "first_seen_at")),
    class: rowClass,
    deletedHlc: nullableString(column(row, "deleted_hlc")) as HlcString | null,
    registerHlc: nullableString(column(row, "register_hlc")) as HlcString | null,
    serverSeq: requiredNumber(column(row, "server_seq")),
  };
}

function decodeDevice(row: SqlRow): DeviceRecord {
  return {
    scopeId: scopeId(requiredString(column(row, "scope_id"))),
    deviceId: importDeviceId(requiredString(column(row, "device_id"))),
    lastSeen: requiredNumber(column(row, "last_seen")),
  };
}

function importDeviceId(value: string): import("weftdb/shared").DeviceId {
  return value as import("weftdb/shared").DeviceId;
}

function column(row: SqlRow, name: string): SqlRow[string] {
  const value = row[name];
  if (value === undefined) throw new Error(`missing SQL column: ${name}`);
  return value;
}

function requiredString(value: SqlRow[string]): string {
  if (typeof value !== "string") throw new Error("expected SQL string");
  return value;
}

function nullableString(value: SqlRow[string]): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function requiredNumber(value: SqlRow[string]): number {
  if (typeof value !== "number") throw new Error("expected SQL number");
  return value;
}

function deviceStoreKey(scopeIdValue: ScopeId, deviceIdValue: import("weftdb/shared").DeviceId): string {
  return `${scopeIdValue}\0${deviceIdValue}`;
}
