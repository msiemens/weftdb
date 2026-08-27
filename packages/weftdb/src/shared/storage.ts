// What a value becomes on its way into a column, and what the relay's own tables hold.
//
// Type-only, so naming core from inside shared costs no runtime edge, because core imports the
// wire-value guard from here, and a value import back would close the cycle. The same holds for
// the schema, because a field definition is read for its declared type, which is erased before
// anything runs.
import type { FieldName, HlcString, RowId, SchemaHash, ScopeId, TableName, TxnId, WireValue } from "../core.ts";
import type { FieldDefinition } from "../schema.ts";
import type { SqlRow, SqlValue } from "./executor.ts";

export interface EncodedFieldRecord extends SqlRow {
  readonly scope_id: ScopeId;
  readonly table_name: TableName;
  readonly row_id: RowId;
  readonly field: FieldName;
  readonly value: string | null;
  readonly hlc: HlcString;
  readonly server_seq: number;
  readonly txn_id: TxnId;
}

export interface EncodedScopeState extends SqlRow {
  readonly scope_id: ScopeId;
  readonly server_seq: number;
  readonly tombstone_floor_seq: number;
  readonly schema_hash: SchemaHash | null;
  readonly schema_version: number | null;
}

/**
 * Refuses what JSON cannot carry. `JSON.stringify` renders `NaN` and both infinities as `null`,
 * so three distinct numbers and an actual null all reach storage as one value with one hash.
 * A diff3 base check comparing a field that held `NaN` against one that held `null` then sees
 * no change and lets a merge through as a fast-forward.
 */
export function encodeWireValue(value: WireValue): string {
  assertWireValue(value);
  return JSON.stringify(value);
}

export function assertWireValue(value: WireValue): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`value is not representable on the wire: ${String(value)}`);
  }
  if (Array.isArray(value)) {
    for (const element of value as readonly WireValue[]) assertWireValue(element);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const element of Object.values(value as { readonly [key: string]: WireValue })) assertWireValue(element);
  }
}

export function decodeWireValue(value: string | null): WireValue {
  if (value === null) return null;
  return JSON.parse(value) as WireValue;
}

/**
 * How a declared field sits in the column of its own that the client table gives it. The DDL
 * generator declares the column from this and the client store writes it from this, so the two
 * cannot drift. A query compiled against the generated `Database` binds the type the column
 * actually holds.
 */
export type FieldStorage = "number" | "boolean" | "text" | "json";

export function fieldStorage(field: FieldDefinition): FieldStorage {
  if (field.type === "number") return "number";
  if (field.type === "boolean") return "boolean";
  if (field.type === "json") return "json";
  // `date` is ISO-8601 text and an enum is one of its literal strings; both sort and compare in
  // SQL as the text they are.
  return "text";
}

/**
 * A declared field's value as its own column holds it. JSON text in these columns made the
 * generated types describe a table nothing wrote: `where title = 'buy milk'` matched no row
 * because the column held `"buy milk"` quotes and all, and a boolean bound against an INTEGER
 * column holding the text `false` matched nothing either. Only a value SQLite has no column type
 * for stays JSON: an object, an array, or a value that disagrees with what the schema declares.
 * JSON is also the one form that can carry it back unchanged.
 */
export function encodeFieldValue(field: FieldDefinition | undefined, value: WireValue): SqlValue {
  // A non-finite number has no wire form, so it stays on the JSON path. Letting one into a raw
  // INTEGER column would put it back as null on the next hydrate, producing a value nobody wrote.
  assertWireValue(value);
  if (value === null) return null;
  switch (field === undefined ? "json" : fieldStorage(field)) {
    case "number":
      if (typeof value === "number") return value;
      break;
    case "boolean":
      if (typeof value === "boolean") return value ? 1 : 0;
      break;
    case "text":
      if (typeof value === "string") return value;
      break;
    case "json":
      break;
  }
  return encodeWireValue(value);
}

/** Reverses {@link encodeFieldValue} by the field's declared type. */
export function decodeFieldValue(field: FieldDefinition | undefined, raw: SqlValue): WireValue {
  if (raw === null) return null;
  switch (field === undefined ? "json" : fieldStorage(field)) {
    case "number":
      // A number column that came back as text holds a value the schema does not describe,
      // written by a device that declares the field as something else. It went in as JSON so it
      // could come back as what it was.
      return typeof raw === "string" ? decodeWireValue(raw) : sqlNumber(raw);
    case "boolean":
      return typeof raw === "string" ? decodeWireValue(raw) : sqlNumber(raw) !== 0;
    case "text":
      return sqlText(raw);
    case "json":
      return decodeWireValue(sqlText(raw));
  }
}

function sqlNumber(value: Exclude<SqlValue, null>): number {
  return typeof value === "number" ? value : Number(value);
}

function sqlText(value: Exclude<SqlValue, null>): string {
  return typeof value === "string" ? value : String(value);
}
