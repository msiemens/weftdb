import {
  decodeWireValue,
  encodeWireValue,
  fieldName,
  isHlcString,
  rowId,
  scopeId,
  tableName,
  txnId,
  type FieldName,
  type HlcString,
  type RowId,
  type ScopeId,
  type SqlExecutor,
  type SqlRow,
  type TableName,
  type WeftOp,
  type WireValue,
} from "weftdb/shared";
import { generateClientAddMissingColumnDdl, generateClientDdl } from "weftdb/codegen";
import type { SchemaDefinition } from "weftdb/schema";
import { splitSql } from "../sql.ts";
import { WeftClient, type LocalRow, type LocalRowInternals, type QuarantinedOp, type Tombstone } from "./index.ts";

export class SqliteClientStore {
  readonly executor: SqlExecutor;
  readonly schema: SchemaDefinition;
  /** Whether this store has established that the database agrees with the client it writes. */
  private matched = false;
  private installed = false;

  constructor(executor: SqlExecutor, schema: SchemaDefinition) {
    this.executor = executor;
    this.schema = schema;
  }

  installSchema(): void {
    this.executor.transaction(() => {
      for (const sql of splitSql(generateClientDdl(this.schema))) {
        this.executor.run({ sql, parameters: [] });
      }
      for (const [tableNameValue, collection] of Object.entries(this.schema.collections)) {
        for (const sql of generateClientAddMissingColumnDdl(
          tableNameValue,
          collection,
          this.tableColumns(tableNameValue),
        )) {
          this.executor.run({ sql, parameters: [] });
        }
      }
      this.installed = true;
    });
  }

  /**
   * Makes this store the client's durable state: every change is written through, so a
   * process that dies between a local edit and its push loses nothing (§4.1, §10).
   */
  attach(client: WeftClient): WeftClient {
    this.ensureSchema();
    client.persistence = this;
    this.save(client);
    return client;
  }

  /**
   * The client for one scope, out of a database that may hold several. Every read is filtered by
   * it: one origin holds one database, a person can be signed into more than one scope from it,
   * and a hydrate that read the lot would load another scope's rows, another scope's unsent
   * outbox and another scope's tombstones into this client — and push them on the next flush.
   */
  hydrate(scopeIdValue: ScopeId, deviceIdValue: import("weftdb/shared").DeviceId): WeftClient {
    this.ensureSchema();
    const client = new WeftClient(scopeIdValue, deviceIdValue, this.schema);
    for (const [tableNameValue, collection] of Object.entries(this.schema.collections)) {
      for (const row of this.loadRows(
        scopeIdValue,
        tableName(tableNameValue),
        Object.keys(collection.fields).map(fieldName),
      )) {
        client.rows.set(localKey(tableName(tableNameValue), row.id), row);
      }
    }
    client.outbox.push(...this.loadOutbox(scopeIdValue));
    client.quarantine.push(...this.loadQuarantine(scopeIdValue));
    for (const tombstone of this.loadTombstones(scopeIdValue)) {
      client.tombstones.set(localKey(tombstone.tableName, tombstone.rowId), tombstone);
    }
    const syncState = this.executor.get(syncStateStatement(scopeIdValue));
    if (syncState !== undefined) {
      client.lastServerSeq = syncState.lastServerSeq;
      client.resyncRequired = syncState.resyncRequired;
      // The clock has to come back above everything this device has already written, or the
      // first edit after a reload carries a stamp below work that is still in the outbox and
      // loses the comparison against it — an edit the person made and the field never took.
      if (syncState.hlcLast !== null) client.clock.acknowledge(syncState.hlcLast);
    }
    for (const op of client.outbox) client.clock.acknowledge(op.hlc);
    client.persistence = this;
    // Everything here was just read out of the database, so the two agree by construction and
    // the next save has only what happens after this to write.
    this.matched = true;
    client.drainTouchedRows();
    return client;
  }

  /**
   * Writes the client through. Rows and tombstones are written per row that changed, because
   * this runs on every keystroke and rewriting the dataset would make one edit cost the size of
   * the list. The outbox and quarantine are rewritten whole: they hold unsent work, so their
   * size is what a device has yet to push rather than what it has ever written.
   */
  save(client: WeftClient): void {
    this.ensureSchema();
    this.executor.transaction(() => {
      if (this.matched) this.saveChangedRows(client);
      else this.saveEveryRow(client);
      this.matched = true;
      this.clearFrameworkTables(client.scopeId);
      for (const op of client.outbox) this.saveOutbox(op);
      for (const op of client.quarantine) this.saveQuarantine(op);
      this.executor.run({
        sql: `INSERT INTO sync_state (scope_id, last_server_seq, schema_hash, schema_version, device_id, hlc_last, resync_required)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(scope_id) DO UPDATE SET
  last_server_seq = excluded.last_server_seq,
  schema_hash = excluded.schema_hash,
  schema_version = excluded.schema_version,
  device_id = excluded.device_id,
  hlc_last = excluded.hlc_last,
  resync_required = excluded.resync_required`,
        parameters: [
          client.scopeId,
          client.lastServerSeq,
          "",
          client.schema.schemaVersion,
          client.deviceId,
          client.clock.highest(),
          // A required resync is a fact about this device's cursor, not about the session that
          // discovered it. Losing it on restart leaves the client pulling incrementally from a
          // point the relay has already purged, which is the state the flag exists to leave.
          client.resyncRequired ? 1 : 0,
        ],
      });
    });
  }

  /** Only what the client says has moved since the last save. */
  private saveChangedRows(client: WeftClient): void {
    for (const key of client.drainTouchedRows()) {
      const { tableName: tableNameValue, rowId: rowIdValue } = parseLocalKey(key);
      // A key is either a live row, a tombstone, or neither; clearing both first means one path
      // covers a write, a delete, a restore and a prune alike.
      this.executor.run({
        sql: `DELETE FROM ${quoteIdent(tableNameValue)} WHERE scope_id = ? AND id = ?`,
        parameters: [client.scopeId, rowIdValue],
      });
      this.executor.run({
        sql: "DELETE FROM tombstones WHERE scope_id = ? AND table_name = ? AND row_id = ?",
        parameters: [client.scopeId, tableNameValue, rowIdValue],
      });
      const row = client.rows.get(key);
      if (row !== undefined) this.saveRow(tableNameValue, row);
      const tombstone = client.tombstones.get(key);
      if (tombstone !== undefined) this.saveTombstone(tombstone);
    }
  }

  /** The first save against a database this store has not established agreement with. */
  private saveEveryRow(client: WeftClient): void {
    this.executor.run({ sql: "DELETE FROM tombstones WHERE scope_id = ?", parameters: [client.scopeId] });
    for (const tableNameValue of Object.keys(this.schema.collections).map(tableName)) {
      this.executor.run({
        sql: `DELETE FROM ${quoteIdent(tableNameValue)} WHERE scope_id = ?`,
        parameters: [client.scopeId],
      });
    }
    for (const [key, row] of client.rows) {
      this.saveRow(parseLocalKey(key).tableName, row);
    }
    for (const tombstone of client.tombstones.values()) this.saveTombstone(tombstone);
    client.drainTouchedRows();
  }

  private loadRows(
    scopeIdValue: ScopeId,
    tableNameValue: TableName,
    fieldNames: readonly FieldName[],
  ): readonly LocalRow[] {
    return this.executor.all({
      sql: `SELECT * FROM ${quoteIdent(tableNameValue)} WHERE scope_id = ?`,
      parameters: [scopeIdValue],
      decode: (row) => decodeLocalRow(row, tableNameValue, fieldNames),
    });
  }

  private saveRow(tableNameValue: TableName, row: LocalRow): void {
    const domainEntries: Array<[string, string | number | null]> = [
      // Base fields are columns in their own right and are stored raw. They also appear in
      // the field map once a row has been pulled, and encoding those copies here would
      // overwrite the raw columns with JSON — `id` would come back quoted.
      ["id", row.id],
      ["scope_id", row.scopeId],
      ["created", row.created],
      ...[...row.fields.entries()]
        .filter(([field]) => !BASE_FIELD_NAMES.has(field))
        .map(([field, value]) => [field, encodeWireValue(value)] satisfies [string, string]),
    ];
    const internalEntries: Array<[string, string | number | null]> = [
      ...[...row.internals.hlc.entries()].map(([field, hlc]) => [`_weft_hlc_${field}`, hlc] satisfies [string, string]),
      ...[...row.internals.diff3Base.entries()].map(
        ([field, value]) => [`_weft_base_${field}`, encodeWireValue(value)] satisfies [string, string],
      ),
      ["_weft_first_synced_at", row.internals._weft_first_synced_at],
      ["_weft_rev", row.internals._weft_rev],
      ["_weft_dirty", row.internals._weft_dirty],
    ];
    const entries = dedupeEntries([...domainEntries, ...internalEntries]);
    this.executor.run({
      sql: `INSERT INTO ${quoteIdent(tableNameValue)} (${entries.map(([name]) => quoteIdent(name)).join(", ")})
VALUES (${entries.map(() => "?").join(", ")})`,
      parameters: entries.map(([, value]) => value),
    });
  }

  private loadOutbox(scopeIdValue: ScopeId): readonly WeftOp[] {
    return this.executor.all({
      sql: "SELECT * FROM outbox WHERE scope_id = ? ORDER BY seq",
      parameters: [scopeIdValue],
      decode: decodeOutboxOp,
    });
  }

  private loadQuarantine(scopeIdValue: ScopeId): readonly QuarantinedOp[] {
    return this.executor.all({
      sql: "SELECT * FROM outbox_quarantine WHERE scope_id = ? ORDER BY seq",
      parameters: [scopeIdValue],
      decode: decodeQuarantineOp,
    });
  }

  private loadTombstones(scopeIdValue: ScopeId): readonly Tombstone[] {
    return this.executor.all({
      sql: "SELECT scope_id, table_name, row_id, hlc, server_seq FROM tombstones WHERE scope_id = ?",
      parameters: [scopeIdValue],
      decode: decodeTombstone,
    });
  }

  private clearFrameworkTables(scopeIdValue: ScopeId): void {
    for (const table of ["outbox", "outbox_quarantine", "sync_state"]) {
      this.executor.run({ sql: `DELETE FROM ${table} WHERE scope_id = ?`, parameters: [scopeIdValue] });
    }
  }

  private saveOutbox(op: WeftOp): void {
    this.executor.run({
      sql: `INSERT INTO outbox (scope_id, table_name, row_id, field, value, hlc, base_hash, txn_id, kind, attempts)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      parameters: encodeOutboxParameters(op, 0),
    });
  }

  private saveQuarantine(op: QuarantinedOp): void {
    this.executor.run({
      sql: `INSERT INTO outbox_quarantine (scope_id, table_name, row_id, field, value, hlc, base_hash, txn_id, kind, attempts, rejected_at, reason, server_value)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      parameters: [
        ...encodeOutboxParameters(op, 0),
        op.rejectedAt,
        op.reason,
        op.serverValue === undefined ? null : encodeWireValue(op.serverValue),
      ],
    });
  }

  private saveTombstone(tombstone: Tombstone): void {
    this.executor.run({
      sql: `INSERT INTO tombstones (scope_id, table_name, row_id, hlc, server_seq)
VALUES (?, ?, ?, ?, ?)`,
      parameters: [tombstone.scopeId, tombstone.tableName, tombstone.rowId, tombstone.hlc, tombstone.serverSeq],
    });
  }

  private ensureSchema(): void {
    if (!this.installed) this.installSchema();
  }

  private tableColumns(tableNameValue: string): ReadonlySet<string> {
    return new Set(
      this.executor.all({
        sql: `PRAGMA table_info(${quoteIdent(tableNameValue)})`,
        parameters: [],
        decode: (row): string => requiredString(column(row, "name")),
      }),
    );
  }
}

interface SyncStateRow {
  readonly lastServerSeq: number;
  readonly hlcLast: HlcString | null;
  readonly resyncRequired: boolean;
}

function syncStateStatement(scopeIdValue: ScopeId) {
  return {
    sql: "SELECT last_server_seq, hlc_last, resync_required FROM sync_state WHERE scope_id = ?",
    parameters: [scopeIdValue],
    decode: (row: SqlRow): SyncStateRow => {
      const hlcLast = column(row, "hlc_last");
      return {
        lastServerSeq: requiredNumber(column(row, "last_server_seq")),
        hlcLast: typeof hlcLast === "string" && isHlcString(hlcLast) ? hlcLast : null,
        resyncRequired: requiredNumber(column(row, "resync_required")) !== 0,
      };
    },
  };
}

function decodeLocalRow(row: SqlRow, tableNameValue: TableName, fieldNames: readonly FieldName[]): LocalRow {
  const fields = new Map<FieldName, WireValue>();
  const hlc = new Map<FieldName, HlcString>();
  const diff3Base = new Map<FieldName, WireValue>();
  for (const field of fieldNames) {
    const raw = row[field];
    if (BASE_FIELD_NAMES.has(field)) {
      // A base field is stored raw in a column of its own, so it comes back as it is rather
      // than through the wire decoder. It belongs in the field map all the same: a decoder
      // generated from the schema reads every field from there, base fields included, and a
      // row hydrated without them is a row whose id reads as empty.
      if (typeof raw === "string") fields.set(field, raw);
    } else {
      if (raw !== undefined && raw !== null) fields.set(field, decodeWireValue(String(raw)));
      const rawBase = row[`_weft_base_${field}`];
      if (rawBase !== undefined && rawBase !== null) diff3Base.set(field, decodeWireValue(String(rawBase)));
    }
    const rawHlc = row[`_weft_hlc_${field}`];
    if (typeof rawHlc === "string") hlc.set(field, rawHlc as HlcString);
  }
  const internals: LocalRowInternals = {
    _weft_first_synced_at: nullableNumber(column(row, "_weft_first_synced_at")),
    _weft_rev: requiredNumber(column(row, "_weft_rev")),
    _weft_dirty: requiredNumber(column(row, "_weft_dirty")),
    hlc,
    diff3Base,
  };
  return {
    id: rowId(requiredString(column(row, "id"))),
    scopeId: scopeId(requiredString(column(row, "scope_id"))),
    tableName: tableNameValue,
    created: requiredString(column(row, "created")),
    fields,
    internals,
  };
}

function decodeOutboxOp(row: SqlRow): WeftOp {
  const kind = requiredString(column(row, "kind"));
  const common = {
    scopeId: scopeId(requiredString(column(row, "scope_id"))),
    tableName: tableName(requiredString(column(row, "table_name"))),
    rowId: rowId(requiredString(column(row, "row_id"))),
    hlc: requiredString(column(row, "hlc")) as HlcString,
    txnId: txnId(requiredString(column(row, "txn_id"))),
  };
  if (kind === "set") {
    return {
      ...common,
      kind,
      field: fieldName(requiredString(column(row, "field"))),
      value: decodeWireValue(nullableString(column(row, "value"))),
      ...(nullableString(column(row, "base_hash")) === null
        ? {}
        : { baseHash: nullableString(column(row, "base_hash")) as import("weftdb/shared").SchemaHash }),
    };
  }
  if (kind === "create" || kind === "delete" || kind === "restore" || kind === "append") return { ...common, kind };
  throw new Error(`invalid op kind: ${kind}`);
}

function decodeQuarantineOp(row: SqlRow): QuarantinedOp {
  const op = decodeOutboxOp(row);
  const serverValue = nullableString(column(row, "server_value"));
  return {
    ...op,
    rejectedAt: requiredNumber(column(row, "rejected_at")),
    reason: requiredString(column(row, "reason")) as import("weftdb/shared").RejectReason,
    ...(serverValue === null ? {} : { serverValue: decodeWireValue(serverValue) }),
  };
}

function decodeTombstone(row: SqlRow): Tombstone {
  return {
    scopeId: scopeId(requiredString(column(row, "scope_id"))),
    tableName: tableName(requiredString(column(row, "table_name"))),
    rowId: rowId(requiredString(column(row, "row_id"))),
    hlc: requiredString(column(row, "hlc")) as HlcString,
    serverSeq: requiredNumber(column(row, "server_seq")),
  };
}

function encodeOutboxParameters(op: WeftOp, attempts: number): readonly (string | number | null)[] {
  return [
    op.scopeId,
    op.tableName,
    op.rowId,
    op.kind === "set" ? op.field : null,
    op.kind === "set" ? encodeWireValue(op.value) : null,
    op.hlc,
    op.kind === "set" ? (op.baseHash ?? null) : null,
    op.txnId,
    op.kind,
    attempts,
  ];
}

function dedupeEntries(
  entries: readonly (readonly [string, string | number | null])[],
): readonly (readonly [string, string | number | null])[] {
  return [...new Map(entries).entries()];
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

function nullableNumber(value: SqlRow[string]): number | null {
  if (value === null) return null;
  return requiredNumber(value);
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function localKey(tableNameValue: TableName, rowIdValue: RowId): string {
  return `${tableNameValue}\0${rowIdValue}`;
}

function parseLocalKey(key: string): { readonly tableName: TableName; readonly rowId: RowId } {
  const [tableNamePart, rowIdPart] = key.split("\0");
  if (tableNamePart === undefined || rowIdPart === undefined) throw new Error(`invalid local row key: ${key}`);
  return { tableName: tableName(tableNamePart), rowId: rowId(rowIdPart) };
}

const BASE_FIELD_NAMES: ReadonlySet<FieldName> = new Set([
  fieldName("id"),
  fieldName("scope_id"),
  fieldName("created"),
]);
