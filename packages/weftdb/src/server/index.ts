import {
  BASE_FIELDS,
  compareHlc,
  fieldName,
  isHlcString,
  parseHlc,
  stableHash,
  type FieldName,
  type HlcString,
  type Rejection,
  type RowClass,
  type RowId,
  type SchemaHash,
  type ScopeId,
  type SetOp,
  type TableName,
  type TxnId,
  type WeftOp,
  type WireValue,
} from "weftdb/shared";

export interface FieldRecord {
  scopeId: ScopeId;
  tableName: TableName;
  rowId: RowId;
  field: FieldName;
  value: WireValue;
  hlc: HlcString;
  serverSeq: number;
  txnId: TxnId;
}

export interface RowRecord {
  scopeId: ScopeId;
  tableName: TableName;
  rowId: RowId;
  firstSeenAt: number;
  class: RowClass;
  deletedHlc: HlcString | null;
  /** Highest HLC ever written to the liveness register, by a delete or by a restore. */
  registerHlc: HlcString | null;
  serverSeq: number;
}

export interface ScopeState {
  serverSeq: number;
  tombstoneFloorSeq: number;
  schemaHash?: SchemaHash;
  schemaVersion?: number;
}

export interface DeviceRecord {
  scopeId: ScopeId;
  deviceId: import("weftdb/shared").DeviceId;
  lastSeen: number;
}

export interface HandshakeRequest {
  scopeId: ScopeId;
  deviceId: import("weftdb/shared").DeviceId;
  schemaHash: SchemaHash;
  schemaVersion: number;
  lastServerSeq: number;
}

export type HandshakeResponse =
  | { ok: true; serverSeq: number }
  | { ok: false; reason: "schema_mismatch" }
  | { ok: false; reason: "resync_required"; serverSeq: number };

export interface PushAck {
  txnId: TxnId;
  serverSeq: number;
  firstSeenAtByRow: RowFirstSeen[];
}

export interface RowFirstSeen {
  tableName: TableName;
  rowId: RowId;
  firstSeenAt: number;
}

export interface PullBatch {
  serverSeq: number;
  /**
   * The scope's floor at the moment of the read. A client whose cursor is below it cannot be
   * brought up to date incrementally: what it missed has been hard-purged (§5.9).
   */
  tombstoneFloorSeq: number;
  fields: FieldRecord[];
  rows: RowRecord[];
}

export interface Snapshot extends PullBatch {
  schemaHash?: SchemaHash;
}

/**
 * A push is transaction-granular, so it can half succeed: `acks` names the transactions that
 * were applied whether or not a later one was rejected.
 */
export type PushOutcome = { ok: true; acks: PushAck[] } | { ok: false; rejection: Rejection; acks: PushAck[] };

/** Told that a scope moved, so whoever is listening can be woken. */
export type ScopeWatcher = (scopeId: ScopeId, serverSeq: number) => void;

/**
 * How far ahead of the relay's own clock a write may be stamped before it is refused. Wide enough
 * to absorb an ordinary unsynchronised device clock, narrow enough that a badly wrong one cannot
 * park a value at the top of every field's ordering for as long as it stays wrong.
 */
export const DEFAULT_SKEW_THRESHOLD_MS = 5 * 60 * 1000;

const ID_FIELD = fieldName("id");
const SCOPE_ID_FIELD = fieldName("scope_id");

export class WeftServer {
  readonly fields = new Map<StoreKey, FieldRecord>();
  readonly rows = new Map<StoreKey, RowRecord>();
  readonly scopes = new Map<ScopeId, ScopeState>();
  readonly devices = new Map<string, DeviceRecord>();
  skewThresholdMs: number;
  /**
   * Keys whose records a store may no longer agree with. A durable server writes these and
   * nothing else: without them the only way to persist a push is to write the scope again,
   * which makes the cost of one edit the size of everything anyone has ever written to it.
   *
   * A key is recorded whether the record was written or removed — what is here now decides
   * which of the two the store performs.
   */
  protected readonly touchedFields = new Set<StoreKey>();
  protected readonly touchedRows = new Set<StoreKey>();
  protected readonly touchedDevices = new Set<string>();
  readonly #watchers = new Set<ScopeWatcher>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now, skewThresholdMs = DEFAULT_SKEW_THRESHOLD_MS) {
    this.now = now;
    this.skewThresholdMs = skewThresholdMs;
  }

  /**
   * Called whenever a scope moves forward, by any path. Watching here rather than at the HTTP
   * surface is what makes a change nobody pushed — a prune raising the tombstone floor — reach
   * the devices that need to know about it.
   */
  watch(listener: ScopeWatcher): () => void {
    this.#watchers.add(listener);
    return () => {
      this.#watchers.delete(listener);
    };
  }

  /** Runs an operation and tells the watchers if it moved the scope. */
  protected announcing<T>(scopeId: ScopeId, operation: () => T): T {
    const before = this.scopes.get(scopeId);
    const seqBefore = before?.serverSeq ?? 0;
    const floorBefore = before?.tombstoneFloorSeq ?? 0;
    const result = operation();
    const after = this.scopes.get(scopeId);
    const seqAfter = after?.serverSeq ?? 0;
    // A floor that rose without the sequence moving still matters: a device below it can no
    // longer be caught up incrementally and needs to hear about that.
    if (seqAfter === seqBefore && (after?.tombstoneFloorSeq ?? 0) === floorBefore) return result;
    for (const watcher of this.#watchers) watcher(scopeId, seqAfter);
    return result;
  }

  handshake(request: HandshakeRequest): HandshakeResponse {
    const scope = this.scope(request.scopeId);
    this.touchedDevices.add(deviceKey(request.scopeId, request.deviceId));
    this.devices.set(deviceKey(request.scopeId, request.deviceId), {
      scopeId: request.scopeId,
      deviceId: request.deviceId,
      lastSeen: this.now(),
    });
    if (scope.schemaVersion == null) {
      scope.schemaHash = request.schemaHash;
      scope.schemaVersion = request.schemaVersion;
    } else if (request.schemaVersion > scope.schemaVersion) {
      scope.schemaHash = request.schemaHash;
      scope.schemaVersion = request.schemaVersion;
    } else if (request.schemaVersion < scope.schemaVersion || request.schemaHash !== scope.schemaHash) {
      return { ok: false, reason: "schema_mismatch" };
    }
    if (request.lastServerSeq < scope.tombstoneFloorSeq) {
      return { ok: false, reason: "resync_required", serverSeq: scope.serverSeq };
    }
    return { ok: true, serverSeq: scope.serverSeq };
  }

  push(scopeId: ScopeId, ops: WeftOp[]): PushOutcome {
    return this.announcing(scopeId, () => this.pushOps(scopeId, ops));
  }

  private pushOps(scopeId: ScopeId, ops: WeftOp[]): PushOutcome {
    // Rejection is transaction-granular: validate every op in a txn before applying any.
    const txns = Map.groupBy(ops, (op) => op.txnId);
    const acks: PushAck[] = [];
    for (const [txnId, txnOps] of txns) {
      const rejection = this.validateTxn(scopeId, txnOps);
      // The transactions already applied stay applied, so they are acknowledged even though
      // the push as a whole failed. Reporting only the rejection would leave the client
      // re-sending work that has landed, which comes back as `row_exists` for a create and as
      // `merge_required` for a prose edit competing with itself — a device manufacturing its
      // own conflicts out of a push that half succeeded.
      if (rejection) return { ok: false, rejection, acks };
      acks.push(this.applyTxn(scopeId, txnId, txnOps));
    }
    return { ok: true, acks };
  }

  pull(scopeId: ScopeId, lastServerSeq: number): PullBatch {
    const scope = this.scope(scopeId);
    return {
      serverSeq: scope.serverSeq,
      tombstoneFloorSeq: scope.tombstoneFloorSeq,
      fields: [...this.fields.values()].filter((row) => row.scopeId === scopeId && row.serverSeq > lastServerSeq),
      rows: [...this.rows.values()].filter((row) => row.scopeId === scopeId && row.serverSeq > lastServerSeq),
    };
  }

  snapshot(scopeId: ScopeId): Snapshot {
    const scope = this.scope(scopeId);
    const snapshot: Snapshot = {
      serverSeq: scope.serverSeq,
      tombstoneFloorSeq: scope.tombstoneFloorSeq,
      fields: [...this.fields.values()].filter((row) => row.scopeId === scopeId),
      rows: [...this.rows.values()].filter((row) => row.scopeId === scopeId),
    };
    if (scope.schemaHash !== undefined) snapshot.schemaHash = scope.schemaHash;
    return snapshot;
  }

  pruneTombstones(scopeId: ScopeId, olderThanMs = 30 * 24 * 60 * 60 * 1000): number {
    // Nobody pushed this, and it is exactly the kind of change a device most needs to hear
    // about: one that can leave it below the floor and unable to catch up incrementally.
    return this.announcing(scopeId, () => this.prune(scopeId, olderThanMs));
  }

  private prune(scopeId: ScopeId, olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    const doomed = [...this.rows.entries()].filter(
      ([, row]) => row.scopeId === scopeId && row.deletedHlc != null && parseHlc(row.deletedHlc).wallMs <= cutoff,
    );
    if (doomed.length === 0) return 0;

    // The floor rises before anything is removed. A reader that lands between the two steps
    // must see a floor that already covers the rows about to vanish — the other order leaves
    // a window where the records are gone but the floor still says an incremental pull is
    // enough, which is precisely how a purged row gets stranded on a device (§5.9).
    const scope = this.scope(scopeId);
    scope.tombstoneFloorSeq = doomed.reduce(
      (floor, [, row]) => Math.max(floor, row.serverSeq),
      scope.tombstoneFloorSeq,
    );

    for (const [key, row] of doomed) {
      this.touchedRows.add(key);
      this.rows.delete(key);
      // Fields survive ordinary deletes for restore, but prune removes row and fields together.
      for (const storedFieldKey of [...this.fields.keys()]) {
        if (isFieldForRow(storedFieldKey, scopeId, row.tableName, row.rowId)) {
          this.touchedFields.add(storedFieldKey);
          this.fields.delete(storedFieldKey);
        }
      }
    }
    return doomed.length;
  }

  private validateTxn(scopeId: ScopeId, ops: WeftOp[]): Rejection | undefined {
    // Append/create rows may receive their initial set ops only within the creating txn.
    const createdInTxn = new Set(ops.filter((op) => op.kind === "create" || op.kind === "append").map(rowKey));
    // What earlier ops in this same transaction leave in each field. A transaction is validated
    // whole before any of it is applied, so a write whose ancestor is a value written two ops
    // earlier would otherwise be compared against the field as it stood before the transaction
    // began — and refused for merging with itself.
    const pending = new Map<StoreKey, { value: WireValue; hlc: HlcString }>();
    for (const op of ops) {
      if (op.scopeId !== scopeId) return { reason: "scope_mismatch", op };
      // A stamp that is not canonical parses to `NaN`, and a `NaN` reading folded into a clock
      // with `Math.max` makes every later stamp on that device `NaN` too. Nothing downstream
      // recovers from it, so it never gets stored.
      if (!isHlcString(op.hlc)) return { reason: "malformed_op", op };
      if (parseHlc(op.hlc).wallMs > this.now() + this.skewThresholdMs)
        return { reason: "clock_skew", op, serverValue: this.now() };
      const row = this.rows.get(rowKey(op));
      if ((op.kind === "create" || op.kind === "append") && row) return { reason: "row_exists", op };
      if (
        (op.kind === "delete" || op.kind === "restore" || op.kind === "set") &&
        !row &&
        !createdInTxn.has(rowKey(op))
      ) {
        return { reason: "row_absent", op };
      }
      if (op.kind === "set" && BASE_FIELDS.has(op.field)) {
        // Base fields are the row's identity. Once a row exists they are immutable; while it is
        // being created they may only restate what the create already said, or the row's `id`
        // column and the id it is filed under disagree for the rest of its life.
        if (row) return { reason: "base_field_violation", op };
        if (op.field === ID_FIELD && op.value !== op.rowId) return { reason: "base_field_violation", op };
        if (op.field === SCOPE_ID_FIELD && op.value !== scopeId) return { reason: "base_field_violation", op };
      }
      if (row?.class === "append" && !createdInTxn.has(rowKey(op))) {
        return { reason: "append_class_violation", op };
      }
      if (op.kind === "set") {
        const key = fieldKey(op);
        if (op.baseHash) {
          const current = pending.get(key) ?? this.fields.get(key);
          // diff3 is server-side fast-forward only; mismatches go back to the client.
          if (stableHash(current?.value ?? null) !== op.baseHash) {
            // The stamp travels with the value: the client has to be able to place its merge
            // after the write it is merging with, and it has not pulled that write yet.
            return current === undefined
              ? { reason: "merge_required", op, serverValue: null }
              : { reason: "merge_required", op, serverValue: current.value, serverHlc: current.hlc };
          }
        }
        pending.set(key, { value: op.value, hlc: op.hlc });
      }
    }
    return undefined;
  }

  private applyTxn(scopeId: ScopeId, txnId: TxnId, ops: WeftOp[]): PushAck {
    const firstSeenAtByRow: RowFirstSeen[] = [];
    // Row ops settle existence and class before any field lands, so a batch reordered in
    // transit applies identically to one delivered in emission order.
    for (const op of [...ops.filter((op) => op.kind !== "set"), ...ops.filter((op) => op.kind === "set")]) {
      const rowId = rowKey(op);
      let row = this.rows.get(rowId);
      if (op.kind === "create" || op.kind === "append") {
        row = this.ensureRow(op, op.kind === "append" ? "append" : "row");
      } else if (!row) {
        row = this.ensureRow(op, "row");
      }
      if (!firstSeenAtByRow.some((ack) => ack.tableName === op.tableName && ack.rowId === op.rowId)) {
        firstSeenAtByRow.push({ tableName: op.tableName, rowId: op.rowId, firstSeenAt: row.firstSeenAt });
      }
      if (op.kind === "set") this.applyField(op);
      if ((op.kind === "delete" || op.kind === "restore") && compareHlc(op.hlc, row.registerHlc) > 0) {
        // Delete and restore are one LWW register on a separate axis from field merge, so
        // the highest HLC decides regardless of the order the two arrive in. Neither op
        // ever mutates retained field values.
        row.registerHlc = op.hlc;
        row.deletedHlc = op.kind === "delete" ? op.hlc : null;
        row.serverSeq = this.nextSeq(scopeId);
        this.touchedRows.add(rowId);
        // A restored row must arrive whole at clients that dropped its fields when the
        // delete came through, so retained fields get fresh server_seqs to replay under.
        if (op.kind === "restore") this.replayRowFields(op, scopeId);
      }
    }
    return { txnId, serverSeq: this.scope(scopeId).serverSeq, firstSeenAtByRow };
  }

  private applyField(op: SetOp): void {
    const key = fieldKey(op);
    const current = this.fields.get(key);
    // A write carrying a base hash was checked against the value it claims to follow, so it is
    // a certified successor of what is stored and applies whatever its stamp says. Comparing
    // stamps as well could only discard a write this server has already accepted, and the
    // client is told the push succeeded — the one outcome it cannot recover from. The two
    // checks genuinely disagree: matching content is not the same as having seen the stamp,
    // because two devices can hold identical text under different stamps (§5.4).
    const certified =
      op.baseHash !== undefined && current !== undefined && stableHash(current.value) !== stableHash(op.value);
    if (!current || certified || compareHlc(op.hlc, current.hlc) > 0) {
      this.touchedFields.add(key);
      this.fields.set(key, {
        scopeId: op.scopeId,
        tableName: op.tableName,
        rowId: op.rowId,
        field: op.field,
        value: op.value,
        hlc: op.hlc,
        txnId: op.txnId,
        serverSeq: this.nextSeq(op.scopeId),
      });
    }
  }

  private replayRowFields(op: WeftOp, scopeId: ScopeId): void {
    for (const [key, field] of this.fields) {
      if (field.scopeId !== op.scopeId || field.tableName !== op.tableName || field.rowId !== op.rowId) continue;
      this.touchedFields.add(key);
      this.fields.set(key, { ...field, serverSeq: this.nextSeq(scopeId) });
    }
  }

  private ensureRow(op: WeftOp, rowClass: RowClass): RowRecord {
    const key = rowKey(op);
    let row = this.rows.get(key);
    if (!row) {
      row = {
        scopeId: op.scopeId,
        tableName: op.tableName,
        rowId: op.rowId,
        firstSeenAt: this.now(),
        class: rowClass,
        deletedHlc: null,
        registerHlc: null,
        serverSeq: this.nextSeq(op.scopeId),
      };
      this.touchedRows.add(key);
      this.rows.set(key, row);
    }
    return row;
  }

  private scope(scopeId: ScopeId): ScopeState {
    let scope = this.scopes.get(scopeId);
    if (!scope) {
      scope = { serverSeq: 0, tombstoneFloorSeq: 0 };
      this.scopes.set(scopeId, scope);
    }
    return scope;
  }

  private nextSeq(scopeId: ScopeId): number {
    const scope = this.scope(scopeId);
    scope.serverSeq += 1;
    return scope.serverSeq;
  }
}

export type StoreKey = string & { readonly __storeKey: unique symbol };

export function rowKey(op: Pick<WeftOp, "scopeId" | "tableName" | "rowId">): StoreKey {
  return `${op.scopeId}\0${op.tableName}\0${op.rowId}` as StoreKey;
}

export function fieldKey(op: Pick<SetOp, "scopeId" | "tableName" | "rowId" | "field">): StoreKey {
  return `${op.scopeId}\0${op.tableName}\0${op.rowId}\0${op.field}` as StoreKey;
}

function isFieldForRow(key: StoreKey, scopeId: ScopeId, tableName: TableName, rowId: RowId): boolean {
  return key.startsWith(`${scopeId}\0${tableName}\0${rowId}\0`);
}

function deviceKey(scopeId: ScopeId, deviceId: import("weftdb/shared").DeviceId): string {
  return `${scopeId}\0${deviceId}`;
}
