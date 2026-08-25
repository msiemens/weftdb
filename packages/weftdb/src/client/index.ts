import {
  BASE_FIELDS,
  diff3,
  HlcClock,
  fieldName,
  stableHash,
  wireText,
  type DeviceId,
  type FieldName,
  type HlcString,
  type Rejection,
  type RowId,
  type SchemaHash,
  type ScopeId,
  type SetOp,
  type TableName,
  type TxnId,
  type WeftOp,
  type WireValue,
} from "weftdb/core";
import type {
  FieldRecord,
  HandshakeRequest,
  HandshakeResponse,
  PullBatch,
  PushAck,
  Snapshot,
  WeftServer,
} from "weftdb/server";
import type { SchemaDefinition } from "weftdb/schema";
import type { AsyncSyncTransport, PushResult } from "./transport.ts";

export interface LocalRowInternals {
  _weft_first_synced_at: number | null;
  _weft_rev: number;
  _weft_dirty: number;
  hlc: Map<FieldName, HlcString>;
  diff3Base: Map<FieldName, WireValue>;
}

export interface LocalRow {
  id: RowId;
  scopeId: ScopeId;
  /**
   * The collection this row belongs to. A row id is unique within its table and nowhere else,
   * so anything that keys rows by id alone — a query's result set, an identity cache — conflates
   * two collections that happen to share one.
   */
  tableName: TableName;
  created: string;
  fields: Map<FieldName, WireValue>;
  internals: LocalRowInternals;
}

export interface Tombstone {
  scopeId: ScopeId;
  tableName: TableName;
  rowId: RowId;
  hlc: HlcString;
  serverSeq: number;
}

export type QuarantinedOp = WeftOp & { rejectedAt: number; reason: Rejection["reason"]; serverValue?: WireValue };

/**
 * Somewhere durable for the client to write itself to. §4.1 makes local storage the client's
 * state rather than a cache of it, and §10 depends on that: unsent ops have to sit on disk
 * across a restart, with no session present, until sign-in lets them push.
 */
export interface ClientPersistence {
  save(client: WeftClient): void;
}

export class WeftClient {
  readonly scopeId: ScopeId;
  readonly deviceId: DeviceId;
  readonly schema: SchemaDefinition;
  readonly rows = new Map<string, LocalRow>();
  readonly tombstones = new Map<string, Tombstone>();
  readonly outbox: WeftOp[] = [];
  readonly outboxAttempts = new Map<string, number>();
  readonly quarantine: QuarantinedOp[] = [];
  lastServerSeq = 0;
  /** Set when an incremental pull could not cover the gap; cleared by a snapshot. */
  resyncRequired = false;
  /** Attached by a store; every state change is written through to it. */
  persistence: ClientPersistence | undefined;
  readonly clock: HlcClock;
  private readonly now: () => number;
  /**
   * Rows whose stored copy may be out of date, as `table\0row` keys. A store writes these and
   * leaves the rest alone: without them the only way to persist a keystroke is to write every
   * row the device holds, which on a long list is a fifth of a second of blocked typing.
   *
   * A key is recorded whether the row was written, deleted or brought back — what the client
   * holds under it now decides which of those the store performs.
   */
  readonly touchedRows = new Set<string>();
  /** Unsent ops per row, unsent creations per row, and the length those counts were taken at. */
  private readonly queuedByRow = new Map<string, number>();
  private readonly queuedCreatesByRow = new Map<string, number>();
  private queuedIndexedLength = -1;

  constructor(scopeId: ScopeId, deviceId: DeviceId, schema: SchemaDefinition, now: () => number = Date.now) {
    this.scopeId = scopeId;
    this.deviceId = deviceId;
    this.schema = schema;
    this.now = now;
    this.clock = new HlcClock(deviceId, now);
  }

  create(tableName: TableName, rowId: RowId, values: Record<FieldName, WireValue>, txnId = randomTxnId()): void {
    const key = localKey(tableName, rowId);
    if (this.rows.has(key) || this.tombstones.has(key))
      throw new Error(`local row already exists: ${tableName}/${rowId}`);
    const created = new Date(this.now()).toISOString();
    const row: LocalRow = {
      id: rowId,
      scopeId: this.scopeId,
      tableName,
      created,
      fields: new Map(typedEntries(values)),
      internals: emptyInternals(1, 1),
    };
    this.rows.set(key, row);
    this.touch(key);
    this.pushOutbox(this.rowOp(tableName, rowId, "create", txnId));
    const initialValues: Array<[FieldName, WireValue]> = [
      [fieldName("id"), rowId],
      [fieldName("scope_id"), this.scopeId],
      [fieldName("created"), created],
      ...typedEntries(values),
    ];
    for (const [field, value] of initialValues) {
      // The base fields go into the row as well as onto the wire: they are as true of a row the
      // moment it is made as once the server has seen it. A query selecting them cannot match a
      // row that lacks them, and a decoder reads them as blank, so without this a new row is
      // invisible to the application until it has been pushed (§4.1).
      if (BASE_FIELDS.has(field)) row.fields.set(field, value);
      this.pushOutbox(this.setOp(tableName, rowId, field, value, txnId));
    }
    this.persist();
  }

  append(tableName: TableName, rowId: RowId, values: Record<FieldName, WireValue>, txnId = randomTxnId()): void {
    this.create(tableName, rowId, values, txnId);
    const op = this.outbox.find((candidate) => candidate.txnId === txnId && candidate.kind === "create");
    if (op) {
      this.outboxAttempts.delete(opKey(op));
      op.kind = "append";
      this.outboxAttempts.set(opKey(op), 0);
    }
    this.persist();
  }

  update(tableName: TableName, rowId: RowId, values: Record<FieldName, WireValue>, txnId = randomTxnId()): void {
    // Append-class rows accept no `set` after the transaction that created them, from any
    // client (§9.23). Queuing one locally would show a value that is never going to be real
    // and put the edit in quarantine when the server refuses it — the same reason delete and
    // restore are refused here rather than sent.
    this.rejectAppendClassLifecycle(tableName, "edited");
    const row = this.requireRow(tableName, rowId);
    for (const [field, value] of typedEntries(values)) {
      const merge = this.schema.collections[tableName]?.fields[field]?.merge ?? "lww";
      // A field holds one value, so an unsent write to it is replaced rather than followed.
      // Sending both would be pointless under last-writer-wins and actively wrong under
      // diff3, where the second edit's ancestor is a version only this device ever held.
      this.supersedeQueuedSet(tableName, rowId, field);
      const op = this.setOp(tableName, rowId, field, value, txnId);
      if (merge === "diff3") {
        // The ancestor is what the server will hold when it reaches this op — which is the
        // value of the last write already queued for this field, not the last one the server
        // acknowledged. Two edits queued before a sync are pushed together, so basing the
        // second on the server's old value guarantees a `merge_required` for an edit nobody
        // else touched (§5.4).
        op.baseHash = stableHash(
          this.pendingValue(tableName, rowId, field) ?? row.internals.diff3Base.get(field) ?? null,
        );
      }
      row.fields.set(field, value);
      row.internals._weft_rev += 1;
      this.touch(localKey(tableName, rowId));
      this.pushOutbox(op);
    }
    this.recomputeDirty(tableName, rowId);
    this.persist();
  }

  delete(tableName: TableName, rowId: RowId, txnId = randomTxnId()): void {
    // Append-class rows are neither deletable nor restorable, and the server would reject
    // the op anyway; refusing locally keeps the event log intact instead of removing a row
    // the push can never take back.
    this.rejectAppendClassLifecycle(tableName, "deleted");
    const hlc = this.clock.next();
    this.rows.delete(localKey(tableName, rowId));
    this.touch(localKey(tableName, rowId));
    this.tombstones.set(localKey(tableName, rowId), {
      scopeId: this.scopeId,
      tableName,
      rowId,
      hlc,
      serverSeq: this.lastServerSeq,
    });
    this.pushOutbox({ scopeId: this.scopeId, tableName, rowId, kind: "delete", hlc, txnId });
    this.persist();
  }

  restore(tableName: TableName, rowId: RowId, values: Record<FieldName, WireValue>, txnId = randomTxnId()): void {
    this.rejectAppendClassLifecycle(tableName, "restored");
    const key = localKey(tableName, rowId);
    const created = wireText(values[fieldName("created")] ?? new Date(this.now()).toISOString());
    this.tombstones.delete(key);
    this.touch(key);
    const row: LocalRow = {
      id: rowId,
      scopeId: this.scopeId,
      tableName,
      created,
      fields: new Map(typedEntries(values)),
      internals: emptyInternals(1, 1),
    };
    this.rows.set(key, row);
    this.pushOutbox(this.rowOp(tableName, rowId, "restore", txnId));
    // Base fields go into the row for the same reason they do on a create: a query selecting
    // them cannot match a row that lacks them, so without this a restored row is invisible to
    // the application until it has been pushed and pulled back. They do not go onto the wire —
    // the row still exists on the server, which refuses a write to any of them.
    for (const [field, value] of [
      [fieldName("id"), rowId],
      [fieldName("scope_id"), this.scopeId],
      [CREATED, created],
    ] as const) {
      row.fields.set(field, value);
    }
    for (const [field, value] of typedEntries(values)) {
      if (BASE_FIELDS.has(field)) continue;
      // No base hash. This is a new life of the row, and the ancestor a diff3 merge would be
      // asked to rebase against is a value this device dropped when the delete came through.
      this.pushOutbox(this.setOp(tableName, rowId, field, value, txnId));
    }
    this.persist();
  }

  getRow(tableName: TableName, rowId: RowId): MaterializedRow | undefined {
    const row = this.rows.get(localKey(tableName, rowId));
    return row ? materializeRow(row) : undefined;
  }

  listRows(tableName: TableName): MaterializedRow[] {
    const prefix = `${tableName}\0`;
    return [...this.rows.entries()].filter(([key]) => key.startsWith(prefix)).map(([, row]) => materializeRow(row));
  }

  isRowDirty(tableName: TableName, rowId: RowId): boolean {
    return this.isDirty(tableName, rowId);
  }

  listQuarantine(): readonly QuarantinedOp[] {
    return [...this.quarantine];
  }

  exportQuarantinedTxn(txnId: TxnId): readonly QuarantinedOp[] {
    return this.quarantine.filter((op) => op.txnId === txnId);
  }

  discardQuarantinedTxn(txnId: TxnId): void {
    const discarded = this.quarantine.filter((op) => op.txnId === txnId);
    if (discarded.length === 0) return;
    this.quarantine.splice(0, this.quarantine.length, ...this.quarantine.filter((op) => op.txnId !== txnId));
    for (const op of discarded) this.recomputeDirty(op.tableName, op.rowId);
    // Discarding is "drop the local change and re-pull" (§5.5). Dropping the ops alone would
    // strand whatever they had already written locally — a row the server has never seen and
    // now never will — so the next sync re-derives this scope from a snapshot.
    this.resyncRequired = true;
    this.persist();
  }

  retryQuarantinedTxn(txnId: TxnId): void {
    const retrying = this.quarantine.filter((op) => op.txnId === txnId);
    this.quarantine.splice(0, this.quarantine.length, ...this.quarantine.filter((op) => op.txnId !== txnId));
    for (const op of retrying) {
      const { rejectedAt: _rejectedAt, reason: _reason, serverValue: _serverValue, ...wireOp } = op;
      this.pushOutbox(wireOp);
      this.recomputeDirty(wireOp.tableName, wireOp.rowId);
    }
    this.persist();
  }

  sync(server: WeftServer, schemaHash: SchemaHash): void {
    const outcome = this.handshakeOutcome(server.handshake(this.handshakeRequest(schemaHash)));
    if (outcome === "abort") return;
    if (outcome === "resync") this.applySnapshot(server.snapshot(this.scopeId));
    this.flush(server);
    this.applyPull(server.pull(this.scopeId, this.lastServerSeq));
    // The floor can advance between the handshake and the pull, so the incremental path
    // reports when it cannot cover the gap and the session falls back to a snapshot.
    if (this.resyncRequired) this.applySnapshot(server.snapshot(this.scopeId));
  }

  /**
   * The same session against a transport that answers over a network. Only the sequencing
   * differs: every decision — what a handshake outcome means, what to do with a rejection,
   * how a batch is applied — is shared with `sync`, so the two cannot drift apart in
   * behaviour, only in how long they take.
   */
  async syncWith(transport: AsyncSyncTransport, schemaHash: SchemaHash): Promise<void> {
    const outcome = this.handshakeOutcome(await transport.handshake(this.handshakeRequest(schemaHash)));
    if (outcome === "abort") return;
    if (outcome === "resync") this.applySnapshot(await transport.snapshot(this.scopeId));
    await this.flushWith(transport);
    this.applyPull(await transport.pull(this.scopeId, this.lastServerSeq));
    if (this.resyncRequired) this.applySnapshot(await transport.snapshot(this.scopeId));
  }

  flush(server: WeftServer): void {
    // Every exit from the push loop changes durable state — drained, re-stamped, rebased or
    // quarantined — so the write-through happens once, whichever way it ends.
    try {
      let attempts = 0;
      while (this.outbox.length > 0 && attempts < MAX_PUSH_ATTEMPTS) {
        attempts += 1;
        const sent = [...this.outbox];
        if (this.applyPushResult(server.push(this.scopeId, sent), sent) === "stop") return;
      }
    } finally {
      this.persist();
    }
  }

  async flushWith(transport: AsyncSyncTransport): Promise<void> {
    try {
      let attempts = 0;
      while (this.outbox.length > 0 && attempts < MAX_PUSH_ATTEMPTS) {
        attempts += 1;
        const sent = [...this.outbox];
        if (this.applyPushResult(await transport.push(this.scopeId, sent), sent) === "stop") return;
      }
    } finally {
      this.persist();
    }
  }

  handshakeRequest(schemaHash: SchemaHash): HandshakeRequest {
    return {
      scopeId: this.scopeId,
      deviceId: this.deviceId,
      schemaHash,
      schemaVersion: this.schema.schemaVersion,
      lastServerSeq: this.lastServerSeq,
    };
  }

  private handshakeOutcome(response: HandshakeResponse): "abort" | "resync" | "continue" {
    if (response.ok) return "continue";
    // A schema the server will not accept is not something syncing harder can fix; pushing
    // anyway would only collect rejections.
    if (response.reason === "schema_mismatch") return "abort";
    // Falling below the tombstone floor means absence in the snapshot is authoritative.
    return "resync";
  }

  private applyPushResult(result: PushResult, sent: readonly WeftOp[]): "retry" | "stop" {
    if (result.ok) {
      // Draining first matters: the dirty predicate is recomputed from the outbox, so
      // acknowledged rows would stay dirty forever if their entries were still in it. Only
      // what was actually sent is drained — over a network an edit made while the push was in
      // flight is sitting in the outbox, acknowledged by nobody.
      const acknowledged = new Set<WeftOp>(sent);
      this.outbox.splice(0, this.outbox.length, ...this.outbox.filter((op) => !acknowledged.has(op)));
      for (const op of sent) this.outboxAttempts.delete(opKey(op));
      this.applyAcks(result.acks, sent);
      // Whatever was typed while this push was on the wire is still queued, and the loop's own
      // condition decides whether there is anything left to send.
      return "retry";
    }
    // A push can fail partway: the transactions before the rejected one were applied and are
    // acknowledged. Draining them here is what stops the retry from re-sending work the server
    // already has and colliding with itself.
    this.drainAcked(result.acks ?? [], sent);
    if (result.rejection.reason === "merge_required" && this.incrementAttempt(result.rejection.op) <= 3) {
      // The server never stores diff3 ancestors; the client rebases from its local base.
      if (this.rebase(result.rejection)) return "retry";
      // Nothing local to rebase against — the row was deleted here after the edit was
      // queued — so the edit has diverged and is surfaced rather than looped on.
      this.moveTxnToQuarantine({ ...result.rejection, reason: "rebase_exhausted" });
      return "stop";
    }
    if (result.rejection.reason === "clock_skew" && this.incrementAttempt(result.rejection.op) <= 3) {
      this.restampTxn(result.rejection);
      return "retry";
    }
    if (result.rejection.reason === "merge_required") {
      this.moveTxnToQuarantine({ ...result.rejection, reason: "rebase_exhausted" });
      return "stop";
    }
    this.moveTxnToQuarantine(result.rejection);
    return "stop";
  }

  applyPull(batch: PullBatch): void {
    if (batch.tombstoneFloorSeq > this.lastServerSeq) {
      // Whatever this client missed below the floor has been hard-purged, so no incremental
      // batch can describe it. Advancing the cursor here would strand purged rows locally
      // forever; absence has to come from a snapshot instead (§1.5, §5.9).
      this.resyncRequired = true;
      this.persist();
      return;
    }
    this.applyBatch(batch);
    this.persist();
  }

  applySnapshot(snapshot: Snapshot): void {
    const present = new Set(snapshot.rows.map((row) => localKey(row.tableName, row.rowId)));
    for (const key of [...this.rows.keys()]) {
      const { tableName, rowId } = parseLocalKey(key);
      if (!present.has(key) && !this.isEventLog(tableName)) {
        if (this.isDirty(tableName, rowId)) this.quarantineDirtyRow(tableName, rowId, "row_absent");
        else {
          this.rows.delete(key);
          this.touch(key);
        }
      }
    }
    this.applyBatch(snapshot);
    this.resyncRequired = false;
    this.persist();
  }

  private applyBatch(batch: PullBatch): void {
    for (const row of batch.rows) {
      const key = localKey(row.tableName, row.rowId);
      const local = this.rows.get(key);
      if (row.deletedHlc) {
        this.clock.observe(row.deletedHlc);
        // A queued delete for a row the scope also reports deleted is agreement, not divergence:
        // what this device asked for has happened. It is dropped rather than set aside — and it
        // has to be, because a subscribed socket is told about the delete by the same relay that
        // is still answering the push that carried it, so a device routinely hears about its own
        // delete before the push that made it has drained.
        this.dropQueued(row.tableName, row.rowId, (queued) => queued.kind === "delete");
        // Anything else queued for the row — an edit, a restore — genuinely disagrees with the
        // delete, and is surfaced instead of discarded. The row goes either way: the delete is
        // what the scope says happened, and a row left live would be visible on this device
        // alone.
        if (this.isDirty(row.tableName, row.rowId)) this.quarantineDirtyRow(row.tableName, row.rowId, "row_absent");
        this.rows.delete(key);
        this.touch(key);
        this.tombstones.set(key, {
          scopeId: row.scopeId,
          tableName: row.tableName,
          rowId: row.rowId,
          hlc: row.deletedHlc,
          serverSeq: row.serverSeq,
        });
      } else {
        // A live row record is the only protocol event that can clear a local tombstone.
        this.tombstones.delete(key);
        this.touch(key);
        if (local) {
          // The server's value is authoritative rather than merely a first guess: a purged
          // id brought back by a later `create` is a new row with a new `first_seen_at`, and
          // a device holding the old one would expire it on a different day (§7).
          local.internals._weft_first_synced_at = row.firstSeenAt;
        } else {
          this.rows.set(key, {
            id: row.rowId,
            scopeId: row.scopeId,
            tableName: row.tableName,
            created: "",
            fields: new Map<FieldName, WireValue>(),
            internals: {
              // A row this device still has unsent work for is dirty from the moment it is
              // materialized. The flag cannot be left for the fields to derive: `applyField`
              // recomputes it only for the fields it actually applies, and it skips exactly the
              // ones that have a queued write of their own — so a row brought back by the scope
              // while every one of its fields is shadowed locally would land clean (§9.25).
              ...emptyInternals(0, this.isDirty(row.tableName, row.rowId) ? 1 : 0),
              _weft_first_synced_at: row.firstSeenAt,
            },
          });
        }
      }
    }
    for (const field of batch.fields) {
      this.applyField(field);
    }
    this.lastServerSeq = Math.max(this.lastServerSeq, batch.serverSeq);
  }

  private applyField(field: FieldRecord): void {
    // Receiving is half of an HLC: without folding remote stamps into the local clock, an
    // edit made after a pull can carry a lower HLC than the value it was based on, lose the
    // field-wise comparison, and be dropped by a push the client still counts as applied.
    this.clock.observe(field.hlc);

    const key = localKey(field.tableName, field.rowId);
    // Tombstoned rows retain fields on the server; applying them locally would resurrect.
    if (this.tombstones.has(key)) return;
    const row = this.rows.get(key) ?? {
      id: field.rowId,
      scopeId: this.scopeId,
      tableName: field.tableName,
      created: "",
      fields: new Map<FieldName, WireValue>(),
      // Dirty for the same reason, and it matters more here: the queued-write check below
      // returns before the recompute at the end of this function ever runs.
      internals: emptyInternals(0, this.isDirty(field.tableName, field.rowId) ? 1 : 0),
    };
    if (!this.rows.has(key)) this.rows.set(key, row);
    // A field this device has written and not yet sent keeps the value it was written with. What
    // a pull carries is what the relay holds, which cannot include a write it has not been given:
    // an edit refused for skew, one made offline, one still queued behind a slow push. Applying
    // the relay's copy regardless replaces what the person typed with the value they typed over,
    // while their own edit sits in the outbox waiting its turn.
    //
    // Comparing stamps instead would be wrong. A `diff3` merge is accepted by the relay on the
    // strength of its base hash rather than its stamp (§5.4), so the relay can hold a value
    // stamped below one a device holds, and a device that refused it on that basis would never
    // converge. Once the outbox has drained, everything the relay sends applies.
    if (this.hasQueuedWrite(field.tableName, field.rowId, field.field)) return;
    this.touch(key);
    row.fields.set(field.field, field.value);
    // `created` is held twice: in the field map a decoder reads, and on the row itself, which
    // is the copy a store writes its column from. A row that arrived from the server rather
    // than being made here has only ever had the first, so a save would persist an empty
    // column and the value would be gone on the next hydrate.
    if (field.field === CREATED && typeof field.value === "string") row.created = field.value;
    row.internals.hlc.set(field.field, field.hlc);
    if (this.schema.collections[field.tableName]?.fields[field.field]?.merge === "diff3") {
      row.internals.diff3Base.set(field.field, field.value);
    }
    row.internals._weft_rev += 1;
    this.recomputeDirty(field.tableName, field.rowId);
  }

  /** Removes the transactions a partly-successful push acknowledged from the outbox. */
  private drainAcked(acks: readonly PushAck[], sent: readonly WeftOp[]): void {
    if (acks.length === 0) return;
    const applied = new Set(acks.map((ack) => ack.txnId));
    const drained = sent.filter((op) => applied.has(op.txnId));
    if (drained.length === 0) return;
    // Identity, not transaction id. An edit made while the push was in flight can share a
    // transaction with what was sent — a create still being filled in is exactly that — and
    // draining it by id would retire an op the server has never seen.
    const acknowledged = new Set<WeftOp>(drained);
    this.outbox.splice(0, this.outbox.length, ...this.outbox.filter((op) => !acknowledged.has(op)));
    for (const op of drained) this.outboxAttempts.delete(opKey(op));
    this.applyAcks([...acks], drained);
  }

  private applyAcks(acks: PushAck[], drained: readonly WeftOp[]): void {
    // A write of this device's that the server accepted is now part of what the clock must
    // stay above — a later skew correction is allowed to drop the inflated wall clock it was
    // rejected for, but not to land under something already accepted. Until the acknowledgment
    // was folded in here, the clock only learned of its own writes when it pulled them back,
    // which is after the correction has already been made (§5.5).
    for (const op of drained) this.clock.acknowledge(op.hlc);
    for (const ack of acks) {
      for (const rowAck of ack.firstSeenAtByRow) {
        const row = this.rows.get(localKey(rowAck.tableName, rowAck.rowId));
        if (row) row.internals._weft_first_synced_at = rowAck.firstSeenAt;
      }
    }
    for (const op of drained) this.recomputeDirty(op.tableName, op.rowId);
  }

  private rebase(rejection: Rejection): boolean {
    if (rejection.op.kind !== "set") return false;
    const rejectedOp = rejection.op;
    const row = this.rows.get(localKey(rejectedOp.tableName, rejectedOp.rowId));
    if (!row) return false;
    const base = wireText(row.internals.diff3Base.get(rejectedOp.field) ?? "");
    const local = wireText(rejectedOp.value);
    const remote = wireText(rejection.serverValue ?? "");
    const merged = diff3(base, local, remote).value;
    // The merge has to land after the write it merged with. Folding in the server's stamp
    // first is what makes the re-stamp below strictly later than it; otherwise the push
    // accepts the merge and the field's last-writer-wins comparison throws it away, which
    // looks exactly like the edit never happening.
    if (rejection.serverHlc !== undefined) this.clock.observe(rejection.serverHlc);
    row.fields.set(rejectedOp.field, merged);
    row.internals.diff3Base.set(rejectedOp.field, remote);
    // The row as well as the field: a transaction can edit the same field on several rows, and
    // rewriting all of them with one row's merge sends the wrong text to the others and gives
    // them a base hash belonging to a row they have nothing to do with.
    for (const op of this.outbox.filter(
      (candidate): candidate is SetOp =>
        candidate.kind === "set" &&
        candidate.txnId === rejectedOp.txnId &&
        candidate.tableName === rejectedOp.tableName &&
        candidate.rowId === rejectedOp.rowId &&
        candidate.field === rejectedOp.field,
    )) {
      op.value = merged;
      op.baseHash = stableHash(remote);
      op.hlc = this.clock.next();
    }
    return true;
  }

  private moveTxnToQuarantine(rejection: Rejection): void {
    const rejected = this.outbox.filter((op) => op.txnId === rejection.op.txnId);
    this.outbox.splice(0, this.outbox.length, ...this.outbox.filter((op) => op.txnId !== rejection.op.txnId));
    for (const op of rejected) {
      this.outboxAttempts.delete(opKey(op));
      const quarantined = { ...op, rejectedAt: this.now(), reason: rejection.reason };
      this.quarantine.push(
        rejection.serverValue === undefined ? quarantined : { ...quarantined, serverValue: rejection.serverValue },
      );
      this.recomputeDirty(op.tableName, op.rowId);
    }
  }

  /**
   * Removes unsent work for a row that the scope has already carried out. Only a write whose
   * outcome is now certain belongs here — quarantine, not this, is where anything a person still
   * has to decide about goes.
   */
  private dropQueued(tableName: TableName, rowId: RowId, matches: (op: WeftOp) => boolean): void {
    const satisfied = this.outbox.filter((op) => op.tableName === tableName && op.rowId === rowId && matches(op));
    if (satisfied.length === 0) return;
    const dropped = new Set<WeftOp>(satisfied);
    this.outbox.splice(0, this.outbox.length, ...this.outbox.filter((op) => !dropped.has(op)));
    for (const op of satisfied) this.outboxAttempts.delete(opKey(op));
    this.recomputeDirty(tableName, rowId);
  }

  private quarantineDirtyRow(tableName: TableName, rowId: RowId, reason: Rejection["reason"]): void {
    // Quarantine is a move, not a copy: an op left in the outbox would be pushed on the next
    // flush, and quarantined work is never auto-retried — the user decides (§5.5).
    const diverged = this.outbox.filter((op) => op.tableName === tableName && op.rowId === rowId);
    if (diverged.length === 0) return;
    this.outbox.splice(
      0,
      this.outbox.length,
      ...this.outbox.filter((op) => op.tableName !== tableName || op.rowId !== rowId),
    );
    for (const op of diverged) {
      this.outboxAttempts.delete(opKey(op));
      this.quarantine.push({ ...op, rejectedAt: this.now(), reason });
    }
    this.recomputeDirty(tableName, rowId);
  }

  private rowOp(tableName: TableName, rowId: RowId, kind: "create" | "restore", txnId: TxnId): WeftOp {
    return { scopeId: this.scopeId, tableName, rowId, kind, hlc: this.clock.next(), txnId };
  }

  private setOp(tableName: TableName, rowId: RowId, field: FieldName, value: WireValue, txnId: TxnId): SetOp {
    return { scopeId: this.scopeId, tableName, rowId, kind: "set", field, value, hlc: this.clock.next(), txnId };
  }

  private pushOutbox(op: WeftOp): void {
    this.outbox.push(op);
    this.outboxAttempts.set(opKey(op), 0);
    this.rememberQueued(op);
  }

  /**
   * How many unsent ops each row has. `update` has to know whether a field already has a write
   * queued, and answering that by walking the outbox costs a scan per edit — on a device that
   * has been offline for a morning, a scan of thousands of ops for a keystroke.
   *
   * The count is rebuilt whenever the outbox's length disagrees with the length it was built
   * from, so appending to the outbox directly — which hydration does — cannot leave it stale.
   * Reordering the outbox without changing it leaves the counts true, which is why they are
   * counts and not positions.
   */
  private queuedForRow(tableName: TableName, rowId: RowId): number {
    this.reindexQueued();
    return this.queuedByRow.get(localKey(tableName, rowId)) ?? 0;
  }

  /** Whether a row's opening transaction is still unsent, which is what makes a write one. */
  private queuedCreatesForRow(tableName: TableName, rowId: RowId): number {
    this.reindexQueued();
    return this.queuedCreatesByRow.get(localKey(tableName, rowId)) ?? 0;
  }

  private reindexQueued(): void {
    if (this.queuedIndexedLength === this.outbox.length) return;
    this.queuedByRow.clear();
    this.queuedCreatesByRow.clear();
    for (const op of this.outbox) this.countQueued(op, 1);
    this.queuedIndexedLength = this.outbox.length;
  }

  private rememberQueued(op: WeftOp): void {
    // Only when the index is already in step with the outbox; otherwise the rebuild will count
    // this op along with whatever else arrived behind it.
    if (this.queuedIndexedLength !== this.outbox.length - 1) return;
    this.countQueued(op, 1);
    this.queuedIndexedLength = this.outbox.length;
  }

  private forgetQueued(op: WeftOp): void {
    if (this.queuedIndexedLength !== this.outbox.length + 1) return;
    this.countQueued(op, -1);
    this.queuedIndexedLength = this.outbox.length;
  }

  private countQueued(op: WeftOp, by: number): void {
    const key = localKey(op.tableName, op.rowId);
    this.queuedByRow.set(key, Math.max(0, (this.queuedByRow.get(key) ?? 0) + by));
    if (op.kind !== "create" && op.kind !== "append") return;
    this.queuedCreatesByRow.set(key, Math.max(0, (this.queuedCreatesByRow.get(key) ?? 0) + by));
  }

  /**
   * Drops an unsent write that this one replaces. It stops at the row's lifecycle ops: writes
   * before a delete or restore belong to a different life of the row, and the values a row is
   * created with stay in the transaction that created it, because the server only accepts a
   * new row's opening writes there (§9.23).
   */
  private supersedeQueuedSet(tableName: TableName, rowId: RowId, field: FieldName): void {
    if (this.queuedForRow(tableName, rowId) === 0) return;
    for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
      const op = this.outbox[index];
      if (op === undefined || op.tableName !== tableName || op.rowId !== rowId) continue;
      if (op.kind !== "set") return;
      if (op.field !== field) continue;
      // Asked only of the one op that is about to go, rather than of the whole outbox up front.
      if (this.isOpeningWrite(op)) return;
      this.outbox.splice(index, 1);
      this.outboxAttempts.delete(opKey(op));
      this.forgetQueued(op);
      return;
    }
  }

  /** Whether this write is one of the values its row was created with (§9.23). */
  private isOpeningWrite(op: WeftOp): boolean {
    // Only a row whose creation is still queued can have opening writes, and that is the rare
    // case: a row made on this device and not yet pushed. Everywhere else the answer is no
    // without looking at a single op.
    if (this.queuedCreatesForRow(op.tableName, op.rowId) === 0) return false;
    return this.outbox.some(
      (candidate) =>
        (candidate.kind === "create" || candidate.kind === "append") &&
        candidate.txnId === op.txnId &&
        candidate.tableName === op.tableName &&
        candidate.rowId === op.rowId,
    );
  }

  /** Whether this field has a write of its own waiting to be sent. */
  private hasQueuedWrite(tableName: TableName, rowId: RowId, field: FieldName): boolean {
    if (this.queuedForRow(tableName, rowId) === 0) return false;
    return this.outbox.some(
      (op) => op.kind === "set" && op.tableName === tableName && op.rowId === rowId && op.field === field,
    );
  }

  /** The value the last queued write leaves in this field, if anything is queued for it. */
  private pendingValue(tableName: TableName, rowId: RowId, field: FieldName): WireValue | undefined {
    if (this.queuedForRow(tableName, rowId) === 0) return undefined;
    for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
      const op = this.outbox[index];
      if (op?.kind === "set" && op.tableName === tableName && op.rowId === rowId && op.field === field) return op.value;
    }
    return undefined;
  }

  private incrementAttempt(op: WeftOp): number {
    const key = opKey(op);
    const next = (this.outboxAttempts.get(key) ?? 0) + 1;
    this.outboxAttempts.set(key, next);
    return next;
  }

  private restampTxn(rejection: Rejection): void {
    const serverWallMs = typeof rejection.serverValue === "number" ? rejection.serverValue : this.now();
    for (const op of this.outbox.filter((candidate) => candidate.txnId === rejection.op.txnId)) {
      this.outboxAttempts.delete(opKey(op));
      op.hlc = this.clock.restampAfterSkew(serverWallMs);
      this.outboxAttempts.set(opKey(op), 0);
    }
  }

  private requireRow(tableName: TableName, rowId: RowId): LocalRow {
    const row = this.rows.get(localKey(tableName, rowId));
    if (!row) throw new Error(`missing local row: ${tableName}/${rowId}`);
    return row;
  }

  private recomputeDirty(tableName: TableName, rowId: RowId): void {
    const row = this.rows.get(localKey(tableName, rowId));
    if (!row) return;
    const dirty = this.isDirty(tableName, rowId) ? 1 : 0;
    if (row.internals._weft_dirty === dirty) return;
    this.touch(localKey(tableName, rowId));
    row.internals._weft_dirty = dirty;
    // Subscriptions treat the revision as the row's identity, so a dirty flag that moved
    // without it would leave every "unsent" marker in the UI showing the previous answer.
    row.internals._weft_rev += 1;
  }

  private isDirty(tableName: TableName, rowId: RowId): boolean {
    // Counted, not searched. A list asks this of every row it renders, so a scan of the outbox
    // here is a scan per row on every render — and the rows a person is most likely to be
    // looking at are the ones whose ops sit at the far end of it.
    return (
      this.queuedForRow(tableName, rowId) > 0 ||
      this.quarantine.some((op) => op.tableName === tableName && op.rowId === rowId)
    );
  }

  /**
   * Writes the client through to its store. The naive strategy — rewrite the scope on every
   * change — keeps durability obviously correct; making it incremental is an optimisation,
   * not a semantic change.
   */
  private persist(): void {
    this.persistence?.save(this);
  }

  /** Records that a row's stored copy may be stale. Free when nothing is storing anything. */
  private touch(key: string): void {
    if (this.persistence !== undefined) this.touchedRows.add(key);
  }

  /** Hands a store the keys it has yet to write, and forgets them. */
  drainTouchedRows(): readonly string[] {
    const keys = [...this.touchedRows];
    this.touchedRows.clear();
    return keys;
  }

  private rejectAppendClassLifecycle(tableName: TableName, verb: string): void {
    if (this.isEventLog(tableName)) throw new Error(`append-class rows cannot be ${verb}: ${tableName}`);
  }

  private isEventLog(tableName: TableName): boolean {
    return this.schema.collections[tableName]?.kind === "eventLog";
  }
}

/** Rebase and re-stamp each get three tries; the fourth pass exists to notice they failed. */
const MAX_PUSH_ATTEMPTS = 4;

const CREATED = fieldName("created");

function localKey(tableName: TableName, rowId: RowId): string {
  return `${tableName}\0${rowId}`;
}

function parseLocalKey(key: string): { tableName: TableName; rowId: RowId } {
  const [tableName, rowId] = key.split("\0");
  return { tableName: tableName as TableName, rowId: rowId as RowId };
}

function typedEntries<K extends string, V>(record: Record<K, V>): Array<[K, V]> {
  return Object.entries(record) as Array<[K, V]>;
}

function randomTxnId(): TxnId {
  return crypto.randomUUID() as TxnId;
}

function opKey(op: WeftOp): string {
  return [op.txnId, op.tableName, op.rowId, op.kind, op.kind === "set" ? op.field : ""].join("\0");
}

function emptyInternals(rev: number, dirty: number): LocalRowInternals {
  return {
    _weft_first_synced_at: null,
    _weft_rev: rev,
    _weft_dirty: dirty,
    hlc: new Map<FieldName, HlcString>(),
    diff3Base: new Map<FieldName, WireValue>(),
  };
}

export type MaterializedRow = {
  readonly id: RowId;
  readonly scope_id: ScopeId;
  readonly created: string;
  readonly fields: ReadonlyMap<FieldName, WireValue>;
};

function materializeRow(row: LocalRow): MaterializedRow {
  return Object.freeze({
    id: row.id,
    scope_id: row.scopeId,
    created: row.created,
    fields: new Map(row.fields),
  });
}

// The public surface is listed, not inherited: a new export reaches consumers only from here.
export { httpTransport, RelayError } from "./transport.ts";
export type { AsyncSyncTransport, FetchLike, HttpTransportOptions, PushResult } from "./transport.ts";
export { connectWakeups, TOKEN_PROTOCOL_PREFIX, WAKEUP_PROTOCOL } from "./wakeups.ts";
export type { ScopeAdvanced, WakeupConnection, WakeupOptions, WebSocketFactory, WebSocketLike } from "./wakeups.ts";
export { connectSocketTransport, SocketClosedError, SocketRequestError } from "./socket-transport.ts";
export type { SocketTransport, SocketTransportOptions } from "./socket-transport.ts";
export { WeftSession } from "./session.ts";
export type { BroadcastChannelLike, SessionOptions, SessionStatus, SocketHandlers } from "./session.ts";
export { serializeClient, WebStorageClientStore } from "./web-storage.ts";
export type { StorageLike, StoredClient, StoredValue } from "./web-storage.ts";
export { queryKey, RowIdentityCache, SubscriptionEngine } from "./subscriptions.ts";
export type {
  CollectionName,
  FieldOf,
  QueryDelta,
  QueryKey,
  QueryListener,
  QuerySnapshot,
  TypedQueryKey,
} from "./subscriptions.ts";
export { createWeftDb, WeftDb } from "./facade.ts";
export type { CollectionFacade, MutationInput } from "./facade.ts";
export { applyRetentionDeletes, planRetentionDeletes, visibleChildren } from "./retention.ts";
export type { RetentionCandidate, RetentionPolicy } from "./retention.ts";
export { AuthorizerDependencyRecorder, compileQuery, dependency, invalidatesQuery, queryCacheKey } from "./query.ts";
export type { CompiledQuery, QueryBuilderLike, QueryDependency, RegisteredQuery } from "./query.ts";
export { compileOnlyKysely } from "./kysely.ts";
export { OpfsWorkerTransport } from "./worker.ts";
export type { WorkerLike, WorkerRequest, WorkerRequestBody, WorkerResponse } from "./worker.ts";
export { BroadcastDbProxy, MultiTabCoordinator, serveBroadcastDbProxy } from "./multitab.ts";
export type {
  BroadcastDbProxyServerOptions,
  LockManagerLike,
  MultiTabOptions,
  ProxyRequest,
  ProxyResponse,
  ProxyTarget,
  TabRole,
} from "./multitab.ts";
export { Diff3EditorBuffer } from "./editor.ts";
export type { BufferedRemoteEdit } from "./editor.ts";
