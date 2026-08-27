import { assertWireValue, sha256Hex } from "./shared/index.ts";

export type MergeStrategy = "lww" | "diff3" | "fracIndex" | "immutable";
export type RowClass = "row" | "append";
export type OpKind = "create" | "set" | "delete" | "restore" | "append";
export type RejectReason =
  | "scope_mismatch"
  | "clock_skew"
  | "schema_mismatch"
  | "merge_required"
  | "base_field_violation"
  | "append_class_violation"
  | "row_absent"
  | "row_exists"
  | "rebase_exhausted"
  | "malformed_op";

export const MERGE_STRATEGIES = ["lww", "diff3", "fracIndex", "immutable"] as const satisfies readonly MergeStrategy[];
export const ROW_CLASSES = ["row", "append"] as const satisfies readonly RowClass[];
export const OP_KINDS = ["create", "set", "delete", "restore", "append"] as const satisfies readonly OpKind[];
export const REJECT_REASONS = [
  "scope_mismatch",
  "clock_skew",
  "schema_mismatch",
  "merge_required",
  "base_field_violation",
  "append_class_violation",
  "row_absent",
  "row_exists",
  "rebase_exhausted",
  "malformed_op",
] as const satisfies readonly RejectReason[];

declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };
export type ScopeId = Brand<string, "ScopeId">;
export type DeviceId = Brand<string, "DeviceId">;
export type TableName = Brand<string, "TableName">;
export type FieldName = Brand<string, "FieldName">;
export type RowId = Brand<string, "RowId">;
export type TxnId = Brand<string, "TxnId">;
export type SchemaHash = Brand<string, "SchemaHash">;
export type HlcString = Brand<string, "HlcString">;
export type RankString = Brand<string, "RankString">;
export type JsonScalar = string | number | boolean | null;
export type WireValue = JsonScalar | readonly WireValue[] | { readonly [key: string]: WireValue };

export function scopeId(value: string): ScopeId {
  return value as ScopeId;
}

export function deviceId(value: string): DeviceId {
  return value as DeviceId;
}

export function tableName(value: string): TableName {
  return value as TableName;
}

export function fieldName(value: string): FieldName {
  return value as FieldName;
}

export function rowId(value: string): RowId {
  return value as RowId;
}

export function txnId(value: string): TxnId {
  return value as TxnId;
}

export function schemaHashValue(value: string): SchemaHash {
  return value as SchemaHash;
}

/**
 * SQLite and JSON have no brands, so a rank read back from storage is a plain string that needs
 * the same constructor every other identifier has.
 */
export function rankString(value: string): RankString {
  return value as RankString;
}

export interface HlcState {
  wallMs: number;
  counter: number;
  deviceId: DeviceId;
}

export type ParsedHlc = HlcState;

export interface RowOp {
  scopeId: ScopeId;
  tableName: TableName;
  rowId: RowId;
  kind: "create" | "delete" | "restore" | "append";
  hlc: HlcString;
  txnId: TxnId;
}

export interface SetOp {
  scopeId: ScopeId;
  tableName: TableName;
  rowId: RowId;
  kind: "set";
  hlc: HlcString;
  txnId: TxnId;
  field: FieldName;
  value: WireValue;
  baseHash?: SchemaHash;
}

export type WeftOp = RowOp | SetOp;

export interface Rejection {
  reason: RejectReason;
  op: WeftOp;
  serverValue?: WireValue;
  /**
   * The stamp on the value the client is being asked to merge with. Without it the retry is
   * stamped by a clock that has never seen the write it lost to, so the merge can be accepted
   * by the push and then dropped by the field's last-writer-wins comparison, discarding an edit
   * the client was told had landed.
   */
  serverHlc?: HlcString;
}

const HLC_WALL_WIDTH = 15;
const HLC_COUNTER_WIDTH = 6;
export const HLC_MAX_WALL_MS = 36 ** HLC_WALL_WIDTH - 1;
export const HLC_MAX_COUNTER = 36 ** HLC_COUNTER_WIDTH - 1;

/**
 * Canonical form, and nothing else. The widths are what make string comparison equivalent to
 * tuple comparison, so a stamp of any other shape does not read as smaller or larger. It orders
 * against every other reading arbitrarily.
 *
 * Only the first two separators delimit anything. A device id may contain more of them, such as
 * `device-0` or `tab-2-a3f1`, so the rest of the string is the id, however many separators it
 * holds.
 */
const CANONICAL_HLC = new RegExp(`^[0-9a-z]{${HLC_WALL_WIDTH}}-[0-9a-z]{${HLC_COUNTER_WIDTH}}-.+$`, "u");

/**
 * Whether a string is a stamp this build would have written. Anything crossing a trust boundary
 * as an HLC goes through here first, because a reading that parses to `NaN` folds into a clock
 * through `Math.max` and makes every later stamp on that device `NaN` too, and no later valid
 * write recovers from that.
 */
export function isHlcString(value: string): value is HlcString {
  if (!CANONICAL_HLC.test(value)) return false;
  const { wallMs, counter } = splitHlc(value);
  return Number.isSafeInteger(wallMs) && Number.isSafeInteger(counter);
}

export function parseHlc(value: HlcString): ParsedHlc {
  const text: string = value;
  if (!isHlcString(text)) throw new Error(`invalid HLC: ${text}`);
  return splitHlc(text);
}

function splitHlc(value: string): ParsedHlc {
  const counterBreak = HLC_WALL_WIDTH + 1 + HLC_COUNTER_WIDTH;
  return {
    wallMs: Number.parseInt(value.slice(0, HLC_WALL_WIDTH), 36),
    counter: Number.parseInt(value.slice(HLC_WALL_WIDTH + 1, counterBreak), 36),
    deviceId: deviceId(value.slice(counterBreak + 1)),
  };
}

/**
 * Whether a value decoded from a request is an operation this protocol defines. Every surface
 * validates before handing anything to the server, because the server's own checks assume an op
 * has the fields it is typed as having, and a batch of half-shaped objects would violate that
 * assumption.
 */
export function isWeftOp(value: unknown): value is WeftOp {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const op = value as Record<string, unknown>;
  for (const name of ["scopeId", "tableName", "rowId", "txnId"]) {
    const field = op[name];
    if (typeof field !== "string" || field.length === 0) return false;
  }
  if (typeof op["hlc"] !== "string" || !isHlcString(op["hlc"])) return false;
  if (!OP_KINDS.includes(op["kind"] as OpKind)) return false;
  if (op["kind"] !== "set") return true;
  if (typeof op["field"] !== "string" || op["field"].length === 0) return false;
  if (!isWireValue(op["value"])) return false;
  return op["baseHash"] === undefined || typeof op["baseHash"] === "string";
}

export function isWireValue(value: unknown): value is WireValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isWireValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isWireValue);
}

export function encodeHlc(input: HlcState): HlcString {
  // Fixed-width base36 segments make string comparison equivalent to tuple ordering, which holds
  // only while both segments fit. A seven-digit counter shifts every column after it and sorts
  // below six-digit counters a tenth its size, so a reading that does not fit is a caller error.
  if (!Number.isSafeInteger(input.wallMs) || input.wallMs < 0 || input.wallMs > HLC_MAX_WALL_MS) {
    throw new Error(`HLC wall clock out of range: ${input.wallMs}`);
  }
  if (!Number.isSafeInteger(input.counter) || input.counter < 0 || input.counter > HLC_MAX_COUNTER) {
    throw new Error(`HLC counter out of range: ${input.counter}`);
  }
  if (input.deviceId.length === 0) throw new Error("HLC device id is empty");
  return [
    input.wallMs.toString(36).padStart(HLC_WALL_WIDTH, "0"),
    input.counter.toString(36).padStart(HLC_COUNTER_WIDTH, "0"),
    input.deviceId,
  ].join("-") as HlcString;
}

/**
 * A reading in range. A counter that has run out of digits carries into the wall clock, the way
 * a decimal column does. The stamp stays strictly above the one it came from, still fits its
 * columns, and the clock keeps running instead of throwing at whoever happened to be typing.
 */
function carry(wallMs: number, counter: number, device: DeviceId): HlcState {
  if (counter <= HLC_MAX_COUNTER) return { wallMs, counter, deviceId: device };
  return {
    wallMs: wallMs + Math.floor(counter / (HLC_MAX_COUNTER + 1)),
    counter: counter % (HLC_MAX_COUNTER + 1),
    deviceId: device,
  };
}

export function compareHlc(left: HlcString | null | undefined, right: HlcString | null | undefined): number {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export class HlcClock {
  #state: HlcState;
  #now: () => number;
  /** Highest HLC seen from anyone else, or from this device's own accepted writes. */
  #observed: HlcString | undefined;

  constructor(deviceId: DeviceId, now: () => number = Date.now) {
    this.#state = { wallMs: 0, counter: 0, deviceId };
    this.#now = now;
  }

  next(observed?: HlcString): HlcString {
    const localNow = this.#now();
    // The comparison includes every stamp the clock has been told was accepted, whether from
    // this call or from an earlier acknowledgement. After a reload the emitted state starts at
    // zero while the outbox still holds writes this device made, and a stamp below one of those
    // loses the comparison against it.
    const highest =
      observed === undefined || (this.#observed !== undefined && compareHlc(this.#observed, observed) > 0)
        ? this.#observed
        : observed;
    const observedState = highest ? parseHlc(highest) : undefined;
    const maxWall = Math.max(localNow, this.#state.wallMs, observedState?.wallMs ?? 0);
    // HLC counters advance whenever physical time cannot prove a strictly later event.
    const counter =
      maxWall === this.#state.wallMs && maxWall === observedState?.wallMs
        ? Math.max(this.#state.counter, observedState.counter) + 1
        : maxWall === this.#state.wallMs
          ? this.#state.counter + 1
          : maxWall === observedState?.wallMs
            ? observedState.counter + 1
            : 0;
    this.#state = carry(maxWall, counter, this.#state.deviceId);
    return encodeHlc(this.#state);
  }

  observe(hlc: HlcString): void {
    this.acknowledge(hlc);
    this.next(hlc);
  }

  /**
   * Records a stamp the clock must stay above without emitting anything. This device's own
   * accepted writes belong here. A later skew correction may drop the inflated wall clock it
   * was rejected for, but never land under something the server has already taken. This method
   * does not advance the clock, so it never manufactures a write that did not happen.
   */
  acknowledge(hlc: HlcString): void {
    if (this.#observed === undefined || compareHlc(hlc, this.#observed) > 0) this.#observed = hlc;
  }

  snapshot(): HlcState {
    return { ...this.#state };
  }

  /**
   * The highest stamp this clock has emitted or been told was accepted. A store writes this one
   * value and hands it back on the next open, which is what stops a reload from re-issuing
   * stamps the device has already used.
   */
  highest(): HlcString {
    const emitted = encodeHlc(this.#state);
    return this.#observed !== undefined && compareHlc(this.#observed, emitted) > 0 ? this.#observed : emitted;
  }

  restampAfterSkew(serverWallMs: number): HlcString {
    // Skew-rejected ops were not accepted anywhere, so the client may drop the rejected
    // future wall clock and re-stamp against server time. It may not drop to or below
    // anything it has already seen accepted, though, including its own earlier writes at
    // the same millisecond, or the correction loses the field-wise comparison and silently
    // discards the newer edit.
    const observed = this.#observed === undefined ? undefined : parseHlc(this.#observed);
    const wallMs = Math.max(serverWallMs, observed?.wallMs ?? 0);
    this.#state = carry(
      wallMs,
      observed !== undefined && observed.wallMs === wallMs ? observed.counter + 1 : 0,
      this.#state.deviceId,
    );
    return encodeHlc(this.#state);
  }
}

export function stableHash(value: WireValue): SchemaHash {
  return sha256Hex(stableStringify(value)) as SchemaHash;
}

/**
 * Text for a value that arrived as a `WireValue`. The places that want one, such as a diff3
 * merge, an `orderBy` comparison, or a rendered cell, are declared as string fields in the
 * schema, but nothing at this level enforces that, and a plain `String(...)` would turn a
 * collection or an array field into `[object Object]` and then compare or merge that. Scalars
 * stringify exactly as `String` would; anything else keeps the shape it arrived in.
 */
export function wireText(value: WireValue): string {
  return typeof value === "string" ? value : stableStringify(value);
}

export function stableStringify(value: WireValue): string {
  if (value === null || typeof value !== "object") {
    // A hash is what a diff3 base check compares, so it has to distinguish everything storage
    // distinguishes. `JSON.stringify` collapses every non-finite number to `null`.
    assertWireValue(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const object = value as { readonly [key: string]: WireValue };
  // Hash inputs must be stable across runtimes; object key order is not trusted.
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key] ?? null)}`)
    .join(",")}}`;
}

export interface Diff3Result {
  value: string;
  conflicted: boolean;
}

export function diff3(base: string, local: string, remote: string): Diff3Result {
  if (local === remote) return { value: local, conflicted: false };
  if (base === local) return { value: remote, conflicted: false };
  if (base === remote) return { value: local, conflicted: false };

  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  if (baseLines.length === localLines.length && baseLines.length === remoteLines.length) {
    // This line-oriented merge handles the common prose case and degrades to markers.
    const merged = baseLines.map((line, index) => {
      const localLine = localLines[index] ?? "";
      const remoteLine = remoteLines[index] ?? "";
      const localChanged = localLine !== line;
      const remoteChanged = remoteLine !== line;
      if (localChanged && !remoteChanged) return localLine;
      if (!localChanged && remoteChanged) return remoteLine;
      if (!localChanged && !remoteChanged) return line;
      if (localLine === remoteLine) return localLine;
      return conflictBlock(localLine, remoteLine);
    });
    return { value: merged.join("\n"), conflicted: merged.some((line) => line.includes("<<<<<<< WEFT_LOCAL")) };
  }

  return { value: conflictBlock(local, remote), conflicted: true };
}

export function hasConflictMarkers(value: string): boolean {
  return value.includes("<<<<<<< WEFT_LOCAL") && value.includes(">>>>>>> WEFT_REMOTE");
}

function conflictBlock(local: string, remote: string): string {
  return `<<<<<<< WEFT_LOCAL\n${local}\n=======\n${remote}\n>>>>>>> WEFT_REMOTE`;
}

export const RANK_DEVICE_SEPARATOR = ":";

// Every alphabet character must sort above the device separator, or a rank whose core is a
// prefix of another core would compare in the wrong direction once the suffix is appended
// ("a:dev" against "aB:dev"). That is what keeps plain lexicographic order total (§9.19).
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const FIRST = ALPHABET[0] ?? "A";

export function rankBetween(
  left?: RankString | null,
  right?: RankString | null,
  deviceId: DeviceId = deviceIdValue,
): RankString {
  const leftCore = stripRankSuffix(left);
  const rightCore = stripRankSuffix(right);
  // Two rows can share a core. That is what happens when two devices insert into the same gap,
  // and the device suffix is all that orders them. There is no core between those two, so a
  // rank between them has to be found in the whole string, which is what a sort compares
  // anyway. Refusing here would throw at whoever triggers an ordinary reorder, sometime after
  // two devices happened to insert in the same place.
  if (left != null && right != null && leftCore === rightCore) {
    return betweenRanks(left, right);
  }
  const core = midpoint(leftCore, rightCore);
  return `${core}${RANK_DEVICE_SEPARATOR}${deviceId}` as RankString;
}

/** The lowest character a rank may contain, so a midpoint always has room beneath it. */
const LOWEST_RANK_CHAR = 0x21;
const MID_RANK_CHAR = "m";

/**
 * A string strictly between two others, worked out on raw characters because the parts compared
 * here can include device ids, which the rank alphabet does not cover.
 */
function betweenRanks(left: string, right: string): RankString {
  if (left >= right) throw new Error(`rank bounds out of order: ${left} >= ${right}`);
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1;
  const prefix = left.slice(0, shared);
  const rightCode = shared < right.length ? right.charCodeAt(shared) : Number.POSITIVE_INFINITY;

  if (shared === left.length) {
    // The left rank is a prefix of the right one, so the answer sits between "nothing" and the
    // character the right one continues with.
    const between = Math.floor((LOWEST_RANK_CHAR - 1 + rightCode) / 2);
    if (between >= LOWEST_RANK_CHAR && between < rightCode)
      return `${prefix}${String.fromCharCode(between)}` as RankString;
    return `${left}${MID_RANK_CHAR}` as RankString;
  }

  const leftCode = left.charCodeAt(shared);
  if (rightCode - leftCode > 1) {
    return `${prefix}${String.fromCharCode(Math.floor((leftCode + rightCode) / 2))}` as RankString;
  }
  // Adjacent characters leave no room at this position, so the answer keeps the left rank
  // whole and grows past it. It still sorts below the right one, which differs earlier.
  return `${left}${MID_RANK_CHAR}` as RankString;
}

const deviceIdValue = deviceId("device");

function stripRankSuffix(value?: string | null): string {
  return value?.split(RANK_DEVICE_SEPARATOR)[0] ?? "";
}

function midpoint(left: string, right: string): string {
  // Bounds are open when empty. No `left` means "before everything"; no `right` means "after
  // everything". A core never ends in the first alphabet character, which is what guarantees
  // there is always room to descend one more digit between two adjacent ones.
  if (right !== "" && left >= right) throw new Error(`rank bounds out of order: ${left} >= ${right}`);
  if (right !== "") {
    let shared = 0;
    while ((left[shared] ?? FIRST) === right[shared]) shared += 1;
    if (shared > 0) return right.slice(0, shared) + midpoint(left.slice(shared), right.slice(shared));
  }
  const low = left === "" ? 0 : ALPHABET.indexOf(left[0] ?? FIRST);
  const high = right === "" ? ALPHABET.length : ALPHABET.indexOf(right[0] ?? FIRST);
  if (high - low > 1) return ALPHABET[Math.round((low + high) / 2)] ?? FIRST;
  if (right.length > 1) return right.slice(0, 1);
  return (left[0] ?? FIRST) + midpoint(left.slice(1), "");
}

export const BASE_FIELDS: ReadonlySet<FieldName> = new Set([
  fieldName("id"),
  fieldName("scope_id"),
  fieldName("created"),
]);
