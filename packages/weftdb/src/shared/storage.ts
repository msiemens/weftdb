// Type-only, so naming core from inside shared costs no runtime edge: core imports the wire-value
// guard from here, and a value import back would close the cycle.
import type { FieldName, HlcString, RowId, SchemaHash, ScopeId, TableName, TxnId, WireValue } from "../core.ts";

export type SqlValue = string | number | bigint | Uint8Array<ArrayBuffer> | null;
export type SqlParameters = readonly SqlValue[];
export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface SqlStatement<Decoded> {
  readonly sql: string;
  readonly parameters: SqlParameters;
  readonly decode: (row: SqlRow) => Decoded;
}

export interface SqlExecutor {
  all<Decoded>(statement: SqlStatement<Decoded>): readonly Decoded[];
  get<Decoded>(statement: SqlStatement<Decoded>): Decoded | undefined;
  run(statement: { readonly sql: string; readonly parameters: SqlParameters }): void;
  transaction<Result>(body: () => Result): Result;
}

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
 * so three distinct numbers and an actual null all reach storage as one value with one hash —
 * and a diff3 base check comparing a field that held `NaN` against one that held `null` sees no
 * change and lets a merge through as a fast-forward.
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
