import {
  fieldName,
  isHlcString,
  isWireValue,
  rowId,
  ROW_CLASSES,
  schemaHashValue,
  scopeId,
  tableName,
  txnId,
  type HlcString,
  type RowClass,
  type WireValue,
} from "weftdb/core";
import { sha256Hex } from "weftdb/shared";
import type { FieldRecord, RowRecord, Snapshot } from "./index.ts";

export type SnapshotLine =
  | {
      readonly type: "header";
      readonly serverSeq: number;
      readonly epoch: string;
      readonly tombstoneFloorSeq: number;
      readonly schemaHash: string | null;
    }
  | {
      readonly type: "field";
      readonly record: SerializedFieldRecord;
    }
  | {
      readonly type: "row";
      readonly record: SerializedRowRecord;
    };

export interface SerializedFieldRecord {
  readonly scopeId: string;
  readonly tableName: string;
  readonly rowId: string;
  readonly field: string;
  readonly value: WireValue;
  readonly hlc: string;
  readonly serverSeq: number;
  readonly txnId: string;
}

export interface SerializedRowRecord {
  readonly scopeId: string;
  readonly tableName: string;
  readonly rowId: string;
  readonly firstSeenAt: number;
  readonly class: "row" | "append";
  readonly deletedHlc: string | null;
  /** Carried so a snapshot captures the whole liveness register, including which write's HLC currently holds it. */
  readonly registerHlc: string | null;
  readonly serverSeq: number;
}

/**
 * A snapshot on the wire holds the bytes and the digest of exactly those bytes. The structured
 * snapshot is not sent alongside them, because it is the same records a second time and would
 * double the largest response the relay produces. The receiver reads it back out of the body.
 */
export interface SnapshotEnvelope {
  readonly digest: string;
  readonly body: string;
}

export interface ContentAddressedSnapshot extends SnapshotEnvelope {
  readonly snapshot: Snapshot;
}

export class SnapshotDigestError extends Error {
  constructor(expected: string, actual: string) {
    super(`snapshot digest mismatch: the relay said ${expected}, the bytes hash to ${actual}`);
    this.name = "SnapshotDigestError";
  }
}

/**
 * Reads an envelope back into a snapshot, checking the bytes are the ones the digest names. A
 * content address nobody verifies is a comment; this is the one place a device takes a whole
 * dataset on trust, so it is the one place worth checking.
 */
export function snapshotFromEnvelope(envelope: SnapshotEnvelope): Snapshot {
  const digest = sha256Hex(envelope.body);
  if (digest !== envelope.digest) throw new SnapshotDigestError(envelope.digest, digest);
  return snapshotFromNdjson(envelope.body);
}

/**
 * Reads a snapshot back, checking every line. This is the one place a device replaces its whole
 * dataset with something it was handed, and it runs after the client has fallen below the
 * tombstone floor, so anything not understood here is installed as the device's entire state
 * with nothing left to compare it against.
 */
export function snapshotFromNdjson(body: string): Snapshot {
  const fields: FieldRecord[] = [];
  const rows: RowRecord[] = [];
  let header: Extract<SnapshotLine, { readonly type: "header" }> | undefined;
  for (const line of body.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`a snapshot line is not a record: ${line.slice(0, 80)}`);
    }
    const entry = parsed as { readonly type?: unknown; readonly record?: unknown };
    switch (entry.type) {
      case "header":
        header = readHeader(entry);
        break;
      case "field":
        fields.push(readField(entry.record));
        break;
      case "row":
        rows.push(readRow(entry.record));
        break;
      default:
        throw new Error(`a snapshot line has an unknown type: ${JSON.stringify(entry.type)}`);
    }
  }
  if (header === undefined) throw new Error("a snapshot arrived with no header line");
  return {
    serverSeq: header.serverSeq,
    epoch: header.epoch,
    tombstoneFloorSeq: header.tombstoneFloorSeq,
    ...(typeof header.schemaHash === "string" ? { schemaHash: schemaHashValue(header.schemaHash) } : {}),
    fields,
    rows,
  };
}

function readHeader(entry: { readonly [key: string]: unknown }): Extract<SnapshotLine, { readonly type: "header" }> {
  const schemaHash = entry["schemaHash"];
  if (schemaHash !== null && typeof schemaHash !== "string")
    throw new Error("a snapshot header has an invalid schemaHash");
  const epoch = entry["epoch"];
  // Checked here with everything else the header carries. A snapshot replaces the device's whole
  // dataset, and an epoch that arrived as anything but a string would be stored beside the cursor
  // it qualifies and compared against the next one, so a bad value silently disables the check.
  if (typeof epoch !== "string" || epoch.length === 0) throw new Error("a snapshot header has an invalid epoch");
  return {
    type: "header",
    serverSeq: snapshotSeq(entry["serverSeq"], "serverSeq"),
    epoch,
    tombstoneFloorSeq: snapshotSeq(entry["tombstoneFloorSeq"], "tombstoneFloorSeq"),
    schemaHash,
  };
}

function readField(record: unknown): FieldRecord {
  const source = snapshotRecord(record, "field");
  const value = source["value"];
  if (!isWireValue(value)) throw new Error("a snapshot field record has a value the wire format cannot carry");
  return {
    scopeId: scopeId(snapshotText(source["scopeId"], "field.scopeId")),
    tableName: tableName(snapshotText(source["tableName"], "field.tableName")),
    rowId: rowId(snapshotText(source["rowId"], "field.rowId")),
    field: fieldName(snapshotText(source["field"], "field.field")),
    value,
    hlc: snapshotHlc(source["hlc"], "field.hlc"),
    serverSeq: snapshotSeq(source["serverSeq"], "field.serverSeq"),
    txnId: txnId(snapshotText(source["txnId"], "field.txnId")),
  };
}

function readRow(record: unknown): RowRecord {
  const source = snapshotRecord(record, "row");
  const rowClass = source["class"];
  if (!ROW_CLASSES.includes(rowClass as RowClass))
    throw new Error(`a snapshot row record has an unknown class: ${JSON.stringify(rowClass)}`);
  return {
    scopeId: scopeId(snapshotText(source["scopeId"], "row.scopeId")),
    tableName: tableName(snapshotText(source["tableName"], "row.tableName")),
    rowId: rowId(snapshotText(source["rowId"], "row.rowId")),
    firstSeenAt: snapshotSeq(source["firstSeenAt"], "row.firstSeenAt"),
    class: rowClass as RowClass,
    deletedHlc: snapshotNullableHlc(source["deletedHlc"], "row.deletedHlc"),
    registerHlc: snapshotNullableHlc(source["registerHlc"], "row.registerHlc"),
    serverSeq: snapshotSeq(source["serverSeq"], "row.serverSeq"),
  };
}

function snapshotRecord(record: unknown, kind: string): { readonly [key: string]: unknown } {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error(`a snapshot ${kind} line carries no record`);
  }
  return record as { readonly [key: string]: unknown };
}

function snapshotText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`a snapshot record has an invalid ${name}`);
  return value;
}

function snapshotSeq(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`a snapshot record has an invalid ${name}`);
  }
  return value;
}

function snapshotHlc(value: unknown, name: string): HlcString {
  if (typeof value !== "string" || !isHlcString(value)) throw new Error(`a snapshot record has an invalid ${name}`);
  return value;
}

function snapshotNullableHlc(value: unknown, name: string): HlcString | null {
  return value === null ? null : snapshotHlc(value, name);
}

export function snapshotToNdjson(snapshot: Snapshot): string {
  return `${snapshotLines(snapshot)
    .map((line) => JSON.stringify(line))
    .join("\n")}\n`;
}

export function snapshotDigest(snapshot: Snapshot): string {
  return sha256Hex(snapshotToNdjson(snapshot));
}

export function contentAddressSnapshot(snapshot: Snapshot): ContentAddressedSnapshot {
  // Serialized once and hashed, rather than serialized for the digest and again for the body,
  // because the two must be the same bytes and a snapshot is the largest thing this server
  // builds.
  const body = snapshotToNdjson(snapshot);
  return {
    digest: sha256Hex(body),
    body,
    snapshot,
  };
}

export function snapshotLines(snapshot: Snapshot): SnapshotLine[] {
  // Records are emitted in key order rather than storage order, because the digest is a
  // content address, so two servers holding the same state must produce the same bytes however
  // their rows were inserted. Order is by code unit for the same reason it is everywhere else in
  // the protocol. `localeCompare` weighs characters according to the machine's locale, so two
  // relays holding identical state would content-address it differently.
  const fields = [...snapshot.fields].sort((left, right) => compareKeys(fieldKeyOf(left), fieldKeyOf(right)));
  const rows = [...snapshot.rows].sort((left, right) => compareKeys(rowKeyOf(left), rowKeyOf(right)));
  return [
    {
      type: "header",
      serverSeq: snapshot.serverSeq,
      epoch: snapshot.epoch,
      tombstoneFloorSeq: snapshot.tombstoneFloorSeq,
      schemaHash: snapshot.schemaHash ?? null,
    },
    ...fields.map((record) => ({ type: "field", record: serializeField(record) }) satisfies SnapshotLine),
    ...rows.map((record) => ({ type: "row", record: serializeRow(record) }) satisfies SnapshotLine),
  ];
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fieldKeyOf(record: FieldRecord): string {
  return `${record.scopeId}\0${record.tableName}\0${record.rowId}\0${record.field}`;
}

function rowKeyOf(record: RowRecord): string {
  return `${record.scopeId}\0${record.tableName}\0${record.rowId}`;
}

function serializeField(record: FieldRecord): SerializedFieldRecord {
  return {
    scopeId: record.scopeId,
    tableName: record.tableName,
    rowId: record.rowId,
    field: record.field,
    value: record.value,
    hlc: record.hlc,
    serverSeq: record.serverSeq,
    txnId: record.txnId,
  };
}

function serializeRow(record: RowRecord): SerializedRowRecord {
  return {
    scopeId: record.scopeId,
    tableName: record.tableName,
    rowId: record.rowId,
    firstSeenAt: record.firstSeenAt,
    class: record.class,
    deletedHlc: record.deletedHlc,
    registerHlc: record.registerHlc,
    serverSeq: record.serverSeq,
  };
}
