import {
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
  type TableName,
  type WeftOp,
  type WireValue,
} from "weftdb/core";
import {
  decodeFieldValue,
  decodeWireValue,
  encodeFieldValue,
  encodeWireValue,
  type AsyncSqlExecutor,
  type AsyncSqlTransaction,
  type SqlRow,
  type SqlValue,
} from "weftdb/shared";
import { generateClientAddMissingColumnDdl, generateClientDdl } from "weftdb/codegen";
import type { FieldDefinition, SchemaDefinition } from "weftdb/schema";
import { splitSql } from "../sql.ts";
import { WeftClient, type LocalRow, type LocalRowInternals, type QuarantinedOp, type Tombstone } from "./index.ts";

export class SqliteClientStore {
  readonly executor: AsyncSqlExecutor;
  readonly schema: SchemaDefinition;
  /** Whether this store has established that the database agrees with the client it writes. */
  private matched = false;
  private installed = false;
  private installing: Promise<void> | undefined;

  constructor(executor: AsyncSqlExecutor, schema: SchemaDefinition) {
    this.executor = executor;
    this.schema = schema;
  }

  async installSchema(): Promise<void> {
    await this.executor.transaction(async (tx) => {
      for (const sql of splitSql(generateClientDdl(this.schema))) {
        await tx.run({ sql, parameters: [] });
      }
      for (const [tableNameValue, collection] of Object.entries(this.schema.collections)) {
        for (const sql of generateClientAddMissingColumnDdl(
          tableNameValue,
          collection,
          await this.tableColumns(tx, tableNameValue),
        )) {
          await tx.run({ sql, parameters: [] });
        }
      }
    });
    this.installed = true;
  }

  /**
   * Makes this store the client's durable state: every change is written through, so a
   * process that dies between a local edit and its push loses nothing (§4.1, §10).
   */
  async attach(client: WeftClient): Promise<WeftClient> {
    await this.ensureSchema();
    client.persistence = this;
    await this.save(client);
    return client;
  }

  /**
   * The client for one scope, out of a database that may hold several. Every read is filtered by
   * it: one origin holds one database, a person can be signed into more than one scope from it,
   * and a hydrate that read the lot would load another scope's rows, another scope's unsent
   * outbox and another scope's tombstones into this client — and push them on the next flush.
   */
  async hydrate(scopeIdValue: ScopeId, deviceIdValue: import("weftdb/core").DeviceId): Promise<WeftClient> {
    await this.ensureSchema();
    const client = new WeftClient(scopeIdValue, deviceIdValue, this.schema);
    for (const [tableNameValue, collection] of Object.entries(this.schema.collections)) {
      for (const row of await this.loadRows(scopeIdValue, tableName(tableNameValue), collection.fields)) {
        client.rows.set(localKey(tableName(tableNameValue), row.id), row);
      }
    }
    client.outbox.push(...(await this.loadOutbox(scopeIdValue)));
    client.quarantine.push(...(await this.loadQuarantine(scopeIdValue)));
    for (const tombstone of await this.loadTombstones(scopeIdValue)) {
      client.tombstones.set(localKey(tombstone.tableName, tombstone.rowId), tombstone);
    }
    const syncState = await this.executor.get(syncStateStatement(scopeIdValue));
    if (syncState !== undefined) {
      client.lastServerSeq = syncState.lastServerSeq;
      client.resyncRequired = syncState.resyncRequired;
      client.serverEpoch = syncState.serverEpoch;
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
  async save(client: WeftClient): Promise<void> {
    await this.ensureSchema();
    // Taken before the transaction opens, because a statement that throws half way through rolls
    // the write back: keys drained inside it would name rows nothing had written and nothing would
    // write again. The catch below hands them back on the path where that happens.
    const matched = this.matched;
    const touched = matched ? client.drainTouchedRows() : [];
    try {
      await this.executor.transaction(async (tx) => {
        if (matched) await this.saveChangedRows(tx, client, touched);
        else await this.saveEveryRow(tx, client);
        await this.clearFrameworkTables(tx, client.scopeId);
        for (const op of client.outbox) await this.saveOutbox(tx, op);
        for (const op of client.quarantine) await this.saveQuarantine(tx, op);
        await tx.run({
          sql: `INSERT INTO sync_state (scope_id, last_server_seq, hlc_last, resync_required, server_epoch)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(scope_id) DO UPDATE SET
  last_server_seq = excluded.last_server_seq,
  hlc_last = excluded.hlc_last,
  resync_required = excluded.resync_required,
  server_epoch = excluded.server_epoch`,
          parameters: [
            client.scopeId,
            client.lastServerSeq,
            client.clock.highest(),
            // A required resync is a fact about this device's cursor, not about the session that
            // discovered it. Losing it on restart leaves the client pulling incrementally from a
            // point the relay has already purged, which is the state the flag exists to leave.
            client.resyncRequired ? 1 : 0,
            // Kept beside the cursor it qualifies. A cursor that comes back without its epoch is a
            // number this device cannot say the meaning of, and the first pull after a restart
            // would take it as counted in whatever history the server holds now.
            client.serverEpoch ?? null,
          ],
        });
      });
    } catch (error) {
      client.touchRows(touched);
      throw error;
    }
    // After the commit, so a database that rejected the write is one this store still knows it
    // disagrees with.
    if (!matched) client.drainTouchedRows();
    this.matched = true;
  }

  /** Only what the client says has moved since the last save. */
  private async saveChangedRows(tx: AsyncSqlTransaction, client: WeftClient, keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      const { tableName: tableNameValue, rowId: rowIdValue } = parseLocalKey(key);
      // A key is either a live row, a tombstone, or neither; clearing both first means one path
      // covers a write, a delete, a restore and a prune alike.
      await tx.run({
        sql: `DELETE FROM ${quoteIdent(tableNameValue)} WHERE scope_id = ? AND id = ?`,
        parameters: [client.scopeId, rowIdValue],
      });
      await tx.run({
        sql: "DELETE FROM tombstones WHERE scope_id = ? AND table_name = ? AND row_id = ?",
        parameters: [client.scopeId, tableNameValue, rowIdValue],
      });
      const row = client.rows.get(key);
      if (row !== undefined) await this.saveRow(tx, tableNameValue, row);
      const tombstone = client.tombstones.get(key);
      if (tombstone !== undefined) await this.saveTombstone(tx, tombstone);
    }
  }

  /** The first save against a database this store has not established agreement with. */
  private async saveEveryRow(tx: AsyncSqlTransaction, client: WeftClient): Promise<void> {
    await tx.run({ sql: "DELETE FROM tombstones WHERE scope_id = ?", parameters: [client.scopeId] });
    for (const tableNameValue of Object.keys(this.schema.collections).map(tableName)) {
      await tx.run({
        sql: `DELETE FROM ${quoteIdent(tableNameValue)} WHERE scope_id = ?`,
        parameters: [client.scopeId],
      });
    }
    for (const [key, row] of client.rows) {
      await this.saveRow(tx, parseLocalKey(key).tableName, row);
    }
    for (const tombstone of client.tombstones.values()) await this.saveTombstone(tx, tombstone);
  }

  private async loadRows(
    scopeIdValue: ScopeId,
    tableNameValue: TableName,
    fields: Readonly<Record<string, FieldDefinition>>,
  ): Promise<readonly LocalRow[]> {
    return this.executor.all({
      sql: `SELECT * FROM ${quoteIdent(tableNameValue)} WHERE scope_id = ?`,
      parameters: [scopeIdValue],
      decode: (row) => decodeLocalRow(row, tableNameValue, fields),
    });
  }

  private async saveRow(tx: AsyncSqlTransaction, tableNameValue: TableName, row: LocalRow): Promise<void> {
    const fields = this.schema.collections[tableNameValue]?.fields ?? {};
    const domainEntries: Array<[string, SqlValue]> = [
      // Base fields are columns in their own right and are stored raw. They also appear in
      // the field map once a row has been pulled, and encoding those copies here would
      // overwrite the raw columns with JSON — `id` would come back quoted.
      ["id", row.id],
      ["scope_id", row.scopeId],
      ["created", row.created],
      // Every other declared field goes in as what its column says it holds, so the table a
      // query is compiled against is the table the query runs on (§10).
      ...[...row.fields.entries()]
        .filter(([field]) => !BASE_FIELD_NAMES.has(field))
        .map(([field, value]) => [field, encodeFieldValue(fields[field], value)] satisfies [string, SqlValue]),
    ];
    const internalEntries: Array<[string, SqlValue]> = [
      ...[...row.internals.hlc.entries()].map(([field, hlc]) => [`_weft_hlc_${field}`, hlc] satisfies [string, string]),
      ...[...row.internals.diff3Base.entries()].map(
        ([field, value]) => [`_weft_base_${field}`, encodeWireValue(value)] satisfies [string, string],
      ),
      ["_weft_first_synced_at", row.internals._weft_first_synced_at],
      ["_weft_rev", row.internals._weft_rev],
      ["_weft_dirty", row.internals._weft_dirty],
      // A column holds one NULL for two different facts: a field written as null, and a field
      // never written at all. They are not the same — the first mirrors a field record the
      // scope holds and the second mirrors the absence of one — and losing the difference on
      // a hydrate makes a device disagree with the server about which fields exist. The
      // column keeps queries honest (`where x is null` means what it says) and this keeps
      // the difference, in a name no query written against the generated types can see.
      [NULL_FIELDS_COLUMN, encodeNullFields(row)],
    ];
    const entries = dedupeEntries([...domainEntries, ...internalEntries]);
    await tx.run({
      sql: `INSERT INTO ${quoteIdent(tableNameValue)} (${entries.map(([name]) => quoteIdent(name)).join(", ")})
VALUES (${entries.map(() => "?").join(", ")})`,
      parameters: entries.map(([, value]) => value),
    });
  }

  private async loadOutbox(scopeIdValue: ScopeId): Promise<readonly WeftOp[]> {
    return this.executor.all({
      sql: "SELECT * FROM outbox WHERE scope_id = ? ORDER BY seq",
      parameters: [scopeIdValue],
      decode: decodeOutboxOp,
    });
  }

  private async loadQuarantine(scopeIdValue: ScopeId): Promise<readonly QuarantinedOp[]> {
    return this.executor.all({
      sql: "SELECT * FROM outbox_quarantine WHERE scope_id = ? ORDER BY seq",
      parameters: [scopeIdValue],
      decode: decodeQuarantineOp,
    });
  }

  private async loadTombstones(scopeIdValue: ScopeId): Promise<readonly Tombstone[]> {
    return this.executor.all({
      sql: "SELECT scope_id, table_name, row_id, hlc, server_seq FROM tombstones WHERE scope_id = ?",
      parameters: [scopeIdValue],
      decode: decodeTombstone,
    });
  }

  private async clearFrameworkTables(tx: AsyncSqlTransaction, scopeIdValue: ScopeId): Promise<void> {
    for (const table of ["outbox", "outbox_quarantine", "sync_state"]) {
      await tx.run({ sql: `DELETE FROM ${table} WHERE scope_id = ?`, parameters: [scopeIdValue] });
    }
  }

  private async saveOutbox(tx: AsyncSqlTransaction, op: WeftOp): Promise<void> {
    await tx.run({
      sql: `INSERT INTO outbox (scope_id, table_name, row_id, field, value, hlc, base_hash, txn_id, kind)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      parameters: encodeOutboxParameters(op),
    });
  }

  private async saveQuarantine(tx: AsyncSqlTransaction, op: QuarantinedOp): Promise<void> {
    await tx.run({
      sql: `INSERT INTO outbox_quarantine (scope_id, table_name, row_id, field, value, hlc, base_hash, txn_id, kind, rejected_at, reason, server_value)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      parameters: [
        ...encodeOutboxParameters(op),
        op.rejectedAt,
        op.reason,
        op.serverValue === undefined ? null : encodeWireValue(op.serverValue),
      ],
    });
  }

  private async saveTombstone(tx: AsyncSqlTransaction, tombstone: Tombstone): Promise<void> {
    await tx.run({
      sql: `INSERT INTO tombstones (scope_id, table_name, row_id, hlc, server_seq)
VALUES (?, ?, ?, ?, ?)`,
      parameters: [tombstone.scopeId, tombstone.tableName, tombstone.rowId, tombstone.hlc, tombstone.serverSeq],
    });
  }

  /**
   * The schema, installed once.
   *
   * The latch holds the install in flight, because two callers can reach here before either has
   * finished: `generateClientAddMissingColumnDdl` emits an `ALTER TABLE ADD COLUMN` for a column
   * that is missing, and running it twice is an error.
   */
  private async ensureSchema(): Promise<void> {
    if (this.installed) return;
    this.installing ??= this.installSchema();
    await this.installing;
  }

  private async tableColumns(tx: AsyncSqlTransaction, tableNameValue: string): Promise<ReadonlySet<string>> {
    return new Set(
      await tx.all({
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
  readonly serverEpoch: string | undefined;
}

function syncStateStatement(scopeIdValue: ScopeId) {
  return {
    sql: "SELECT last_server_seq, hlc_last, resync_required, server_epoch FROM sync_state WHERE scope_id = ?",
    parameters: [scopeIdValue],
    decode: (row: SqlRow): SyncStateRow => {
      const hlcLast = column(row, "hlc_last");
      const serverEpoch = column(row, "server_epoch");
      return {
        lastServerSeq: requiredNumber(column(row, "last_server_seq")),
        hlcLast: typeof hlcLast === "string" && isHlcString(hlcLast) ? hlcLast : null,
        resyncRequired: requiredNumber(column(row, "resync_required")) !== 0,
        serverEpoch: typeof serverEpoch === "string" ? serverEpoch : undefined,
      };
    },
  };
}

function decodeLocalRow(
  row: SqlRow,
  tableNameValue: TableName,
  definitions: Readonly<Record<string, FieldDefinition>>,
): LocalRow {
  const fields = new Map<FieldName, WireValue>();
  const hlc = new Map<FieldName, HlcString>();
  const diff3Base = new Map<FieldName, WireValue>();
  const nulls = decodeNullFields(row[NULL_FIELDS_COLUMN]);
  for (const name of Object.keys(definitions)) {
    const field = fieldName(name);
    const raw = row[field];
    if (BASE_FIELD_NAMES.has(field)) {
      // A base field is stored raw in a column of its own, so it comes back as it is rather
      // than through the wire decoder. It belongs in the field map all the same: a decoder
      // generated from the schema reads every field from there, base fields included, and a
      // row hydrated without them is a row whose id reads as empty.
      if (typeof raw === "string") fields.set(field, raw);
    } else {
      // Read back by what the field declares, which is what the column was written as. A
      // blanket `JSON.parse` here would fail on the raw text a TEXT column now holds.
      if (raw !== undefined && raw !== null) fields.set(field, decodeFieldValue(definitions[name], raw));
      else if (nulls.has(field)) fields.set(field, null);
      // The diff3 ancestor is not a queryable column — nothing outside the merge reads it —
      // so it stays wire-encoded and comes back through the wire decoder.
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
        : { baseHash: nullableString(column(row, "base_hash")) as import("weftdb/core").SchemaHash }),
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
    reason: requiredString(column(row, "reason")) as import("weftdb/core").RejectReason,
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

function encodeOutboxParameters(op: WeftOp): readonly (string | number | null)[] {
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
  ];
}

/** The fields this row holds as null, or SQL NULL when it holds none. */
function encodeNullFields(row: LocalRow): string | null {
  const names = [...row.fields.entries()]
    .filter(([field, value]) => value === null && !BASE_FIELD_NAMES.has(field))
    .map(([field]) => field);
  return names.length === 0 ? null : JSON.stringify(names);
}

function decodeNullFields(raw: SqlValue | undefined): ReadonlySet<FieldName> {
  if (typeof raw !== "string") return new Set();
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return new Set();
  return new Set((parsed as readonly unknown[]).filter((name) => typeof name === "string").map(fieldName));
}

function dedupeEntries(entries: readonly (readonly [string, SqlValue])[]): readonly (readonly [string, SqlValue])[] {
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

/** Internal, like every other `_weft_` column: the generated `Database` does not carry it. */
const NULL_FIELDS_COLUMN = "_weft_null_fields";

const BASE_FIELD_NAMES: ReadonlySet<FieldName> = new Set([
  fieldName("id"),
  fieldName("scope_id"),
  fieldName("created"),
]);
