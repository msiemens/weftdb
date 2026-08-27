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
} from "weftdb/core";

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
  /**
   * Which run of this scope's history a sequence number belongs to, minted when the scope is
   * first seen here. A device compares it against the one it holds and takes a snapshot when they
   * differ, because a sequence number means nothing across a server that lost what it had.
   */
  epoch: string;
}

export interface DeviceRecord {
  scopeId: ScopeId;
  deviceId: import("weftdb/core").DeviceId;
  lastSeen: number;
}

export interface HandshakeRequest {
  scopeId: ScopeId;
  deviceId: import("weftdb/core").DeviceId;
  schemaHash: SchemaHash;
  schemaVersion: number;
  lastServerSeq: number;
  /** The epoch the cursor was counted in, absent on a device that has never synced. */
  epoch?: string;
}

export type HandshakeResponse =
  { ok: true; epoch: string } | { ok: false; reason: "schema_mismatch" | "resync_required"; epoch: string };

export interface PushAck {
  txnId: TxnId;
  firstSeenAtByRow: RowFirstSeen[];
  /**
   * The records that beat a `set` in this transaction, for the device that sent it.
   *
   * A write losing the stamp comparison is still acknowledged because it was valid and it
   * arrived. The device drops an acknowledged op from its outbox and keeps what it wrote, and the
   * record that beat it kept the sequence it already had, below that device's cursor, where no
   * incremental pull reaches it again. Carrying the winner back on the acknowledgement closes that
   * gap, and it survives redelivery because a second push of the same op loses to the same record
   * and is answered with the same value.
   */
  supersededBy: FieldRecord[];
}

export interface RowFirstSeen {
  tableName: TableName;
  rowId: RowId;
  firstSeenAt: number;
}

export interface PullBatch {
  serverSeq: number;
  /** Which run of the scope's history `serverSeq` counts in. See `ScopeState.epoch`. */
  epoch: string;
  /**
   * The scope's floor at the moment of the read. A client whose cursor is below it cannot be
   * brought up to date incrementally, because what it missed has been hard-purged (§5.9).
   */
  tombstoneFloorSeq: number;
  fields: FieldRecord[];
  rows: RowRecord[];
}

export interface Snapshot extends PullBatch {
  schemaHash?: SchemaHash;
}

/**
 * A push is transaction-granular, so it can half succeed. `acks` names the transactions that
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
   * Keys whose stored records may not match what is held in memory. A durable server writes
   * only these on each push, because writing the whole scope again would make the cost of one
   * edit the size of everything ever written to it.
   *
   * A key is recorded whether its record was written or removed. Whether the key is still
   * present in memory decides which of the two the store performs.
   */
  protected readonly touchedFields = new Set<StoreKey>();
  protected readonly touchedRows = new Set<StoreKey>();
  protected readonly touchedDevices = new Set<string>();
  readonly #watchers = new Set<ScopeWatcher>();
  private readonly now: () => number;
  /** The last `first_seen_at` handed out, which the next one has to clear. */
  private lastFirstSeenAt = 0;
  /** Injectable so a test can name the epochs it is asserting about. */
  private readonly newEpoch: () => string;

  constructor(
    now: () => number = Date.now,
    skewThresholdMs = DEFAULT_SKEW_THRESHOLD_MS,
    newEpoch: () => string = () => crypto.randomUUID(),
  ) {
    this.now = now;
    this.skewThresholdMs = skewThresholdMs;
    this.newEpoch = newEpoch;
  }

  /**
   * Called whenever a scope moves forward, by any path, including a prune raising the tombstone
   * floor that nobody pushed. Watching at this layer catches every one of those paths, so every
   * device that needs to know about a change hears about it.
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
    // A floor that rose without the sequence moving still matters, because a device below it
    // cannot be caught up incrementally and needs to hear about that.
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
      return { ok: false, reason: "schema_mismatch", epoch: scope.epoch };
    }
    if (request.lastServerSeq < scope.tombstoneFloorSeq) {
      return { ok: false, reason: "resync_required", epoch: scope.epoch };
    }
    // A cursor counted in another epoch names a record this scope never wrote, and one above the
    // head names a record it has not written yet. Both mean the device holds a history this
    // server does not have. An incremental pull only answers with what comes after the cursor,
    // and after the cursor there is nothing to reconcile with.
    if (request.epoch !== undefined && request.epoch !== scope.epoch) {
      return { ok: false, reason: "resync_required", epoch: scope.epoch };
    }
    if (request.lastServerSeq > scope.serverSeq) {
      return { ok: false, reason: "resync_required", epoch: scope.epoch };
    }
    return { ok: true, epoch: scope.epoch };
  }

  push(scopeId: ScopeId, ops: WeftOp[]): PushOutcome {
    return this.announcing(scopeId, () => this.pushOps(scopeId, ops));
  }

  private pushOps(scopeId: ScopeId, ops: WeftOp[]): PushOutcome {
    // Rejection is transaction-granular, so every op in a transaction is validated before any
    // of it is applied.
    const txns = Map.groupBy(ops, (op) => op.txnId);
    const acks: PushAck[] = [];
    for (const [txnId, txnOps] of txns) {
      const rejection = this.validateTxn(scopeId, txnOps);
      // The transactions already applied stay applied, so they are acknowledged even though
      // the push as a whole failed. Reporting only the rejection would leave the client
      // re-sending work that has landed, which comes back as `row_exists` for a create and as
      // `merge_required` for a prose edit competing with itself, a device manufacturing its
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
      epoch: scope.epoch,
      tombstoneFloorSeq: scope.tombstoneFloorSeq,
      fields: [...this.fields.values()].filter((row) => row.scopeId === scopeId && row.serverSeq > lastServerSeq),
      rows: [...this.rows.values()].filter((row) => row.scopeId === scopeId && row.serverSeq > lastServerSeq),
    };
  }

  snapshot(scopeId: ScopeId): Snapshot {
    const scope = this.scope(scopeId);
    const snapshot: Snapshot = {
      serverSeq: scope.serverSeq,
      epoch: scope.epoch,
      tombstoneFloorSeq: scope.tombstoneFloorSeq,
      fields: [...this.fields.values()].filter((row) => row.scopeId === scopeId),
      rows: [...this.rows.values()].filter((row) => row.scopeId === scopeId),
    };
    if (scope.schemaHash !== undefined) snapshot.schemaHash = scope.schemaHash;
    return snapshot;
  }

  pruneTombstones(scopeId: ScopeId, olderThanMs = 30 * 24 * 60 * 60 * 1000): number {
    // Nobody pushed this, but it can leave a device below the floor and unable to catch up
    // incrementally, which is exactly the kind of change a device most needs to hear about.
    return this.announcing(scopeId, () => this.prune(scopeId, olderThanMs));
  }

  private prune(scopeId: ScopeId, olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    const doomed = [...this.rows.entries()].filter(
      ([, row]) => row.scopeId === scopeId && row.deletedHlc != null && parseHlc(row.deletedHlc).wallMs <= cutoff,
    );
    if (doomed.length === 0) return 0;

    // The floor rises before anything is removed, so a reader that lands in between sees a
    // floor that already covers the rows about to vanish. Rising it after removal would leave a
    // window where the records are gone but the floor still says an incremental pull is enough,
    // which is precisely how a purged row gets stranded on a device (§5.9).
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
    // began, and refused for merging with itself.
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
            // The stamp travels with the value, because the client has to be able to place its
            // merge after the write it is merging with, and it has not pulled that write yet.
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
    const supersededBy: FieldRecord[] = [];
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
      if (op.kind === "set") {
        const winner = this.applyField(op);
        if (winner) supersededBy.push(winner);
      }
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
    return { txnId, firstSeenAtByRow, supersededBy };
  }

  /** The record that beat this write, where it lost. */
  private applyField(op: SetOp): FieldRecord | undefined {
    const key = fieldKey(op);
    const current = this.fields.get(key);
    // A write carrying a base hash has already been compared against the value it claims to
    // follow, during validation, and a mismatch never reaches here; it went back as
    // `merge_required`. So it is a certified successor of what is stored and fast-forwards
    // whatever its stamp says (§5.4). Comparing stamps as well could only discard a write this
    // server has already told the client succeeded, and that is the one outcome it cannot
    // recover from.
    //
    // Whether the merged value happens to equal the stored one decides nothing. The write still
    // has to land, because what it carries is a stamp as well as a value, and leaving the older
    // stamp in place makes every later write between the two lose a comparison it should win,
    // and those losses are silent.
    const certified = op.baseHash !== undefined;
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
      return undefined;
    }
    return current;
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
        firstSeenAt: this.freshFirstSeenAt(),
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

  /**
   * §5.8 makes `first_seen_at` a property of the row, and §5.9 has a purged id come back as a new
   * row with a new one, so a client tells one life of an id from the next by comparing it. Two
   * lives stamped in the same millisecond would be indistinguishable, and a prune leaves no record
   * to compare against, so the stamp is held above the last one this server issued.
   *
   * A burst of creations inside one millisecond therefore runs ahead of the wall clock by one
   * millisecond per row. Retention reads the higher of this and the anchor (§7), so the drift can
   * only postpone an expiry, never bring one forward.
   */
  private freshFirstSeenAt(): number {
    this.lastFirstSeenAt = Math.max(this.now(), this.lastFirstSeenAt + 1);
    return this.lastFirstSeenAt;
  }

  private scope(scopeId: ScopeId): ScopeState {
    let scope = this.scopes.get(scopeId);
    if (!scope) {
      scope = { serverSeq: 0, tombstoneFloorSeq: 0, epoch: this.newEpoch() };
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

function deviceKey(scopeId: ScopeId, deviceId: import("weftdb/core").DeviceId): string {
  return `${scopeId}\0${deviceId}`;
}
