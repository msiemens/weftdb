// The page half of the page-to-worker bridge. The client itself is in the worker (see
// `worker-host.ts` for why it has to be); this is what the React hooks read.
//
// It is an echo mirror, not an optimistic cache. A mutator posts and returns `void`; the worker
// applies it, writes it through to SQLite, and pushes back the rows that moved; this applies the
// push and wakes the subscriptions. Nothing is applied here first, so nothing here can need
// undoing — which is what keeps DESIGN.md §259's "the client has no rollback path" true of the
// worker-backed path too.
//
// The boundary is affordable at this granularity. Measured in Firefox over OPFS SAH, a round trip
// costs 0.02 ms empty, 0.04 ms for a one-row delta and 0.14 ms for a hundred-row delta, against a
// SQLite commit of 4.2 ms at a hundred rows — so the crossing is noise beside the write, and the
// write is what the demos already pay on the main thread today.
import {
  fieldName,
  rowId as toRowId,
  scopeId as toScopeId,
  tableName as toTableName,
  txnId as toTxnId,
  type RowId,
  type TableName,
  type TxnId,
  type WireValue,
} from "weftdb/core";
import { SubscriptionEngine, type ReactiveSqlQuery, type RowSelect } from "./subscriptions.ts";
import type { LocalRow, MaterializedRow } from "./index.ts";
import type { SessionStatus } from "./session.ts";
import {
  isDeltaPush,
  type WireRow,
  type WorkerDelta,
  type WorkerMutation,
  type WorkerPortTransport,
  type WorkerPush,
  type WorkerRequestBody,
} from "./worker.ts";

export interface WeftClientMirrorOptions {
  /**
   * What this mirror talks to: a worker port, whether this tab made the worker or was handed a
   * port to it. Nothing below this line can tell which, which is the point. The caller owns it —
   * a tab holding the worker also forwards ports into it — so a mirror that constructed and
   * disposed one privately would be taking a handle its tab still needs.
   */
  readonly transport: WorkerPortTransport;
  readonly scopeId: string;
  readonly deviceId: string;
  /**
   * The engine whose snapshots this mirror invalidates. One per mirror: an engine shared between
   * two of them has them evicting each other's cached rows on every render, which
   * `useSyncExternalStore` turns into an infinite update loop rather than a slow one.
   */
  readonly engine?: SubscriptionEngine;
  /**
   * Where a failed mutation goes. Mutators return `void`, so the promise the worker rejects has
   * nowhere else to be reported — and swallowing it would make a refused edit look like an edit
   * that simply had no effect.
   */
  readonly onError?: (error: Error) => void;
}

export class WeftClientMirror {
  /**
   * The rows the worker last said this scope holds, keyed `${tableName}\0${id}` exactly as
   * `WeftClient.rows` is. A map rather than an iterable because the hooks read it on every render.
   */
  readonly rows = new Map<string, LocalRow>();
  readonly engine: SubscriptionEngine;
  readonly scopeId: string;
  readonly deviceId: string;
  #transport: WorkerPortTransport;
  readonly #onError: (error: Error) => void;
  /** Statements this page has registered, by cache key, with how many callers still want each. */
  readonly #watched = new Map<string, MirrorWatch>();
  /** The ids each of those last matched, in order, as the worker last ran them. */
  readonly #results = new Map<string, readonly RowId[]>();
  #offPush: () => void;
  /** What the worker's session last said it was doing, held by identity for `useSyncExternalStore`. */
  #status: SessionStatus | undefined;
  readonly #statusListeners = new Set<() => void>();

  constructor(options: WeftClientMirrorOptions) {
    this.scopeId = options.scopeId;
    this.deviceId = options.deviceId;
    this.engine = options.engine ?? new SubscriptionEngine();
    this.#onError = options.onError ?? defaultOnError;
    this.#transport = options.transport;
    this.#offPush = this.#transport.onPush(this.#onPush);
  }

  /**
   * Which rows a statement matched, in order — read out of what the worker last pushed rather than
   * run here, because the database is on the other thread. Synchronous, which is what
   * `useSyncExternalStore` requires of a snapshot; a statement whose registration has not come back
   * yet answers with nothing rather than blocking a render on a round trip.
   *
   * An arrow property rather than a method, because `SqlQuerySource` holds it as a value and the
   * hooks key their `useCallback` on the source's identity.
   */
  readonly select: RowSelect = (query) => this.#results.get(query.cacheKey) ?? EMPTY;

  /**
   * Points this mirror at another transport and reloads everything through it.
   *
   * This is what a tab does when leadership moves. A dedicated worker dies with the document that
   * created it, so the tab that takes over builds a new one and every other tab is given a port to
   * that one — and on both paths the mirror is holding rows from a worker that no longer exists and
   * registrations in a registry that went with it.
   *
   * Both are dropped rather than carried over. The rows go because the tab was disconnected for
   * some interval and cannot know what happened during it: the database is durable and the same
   * file is being reopened, so what comes back is whatever committed, which is exactly the right
   * answer — including for a write that was in flight when the worker died and whose fate the
   * caller was told it could not know. The registrations go because the new worker has never heard
   * of them; they are made again from the statements this mirror kept, which is what stops a list
   * from silently freezing after a migration nobody noticed.
   *
   * The old transport is not disposed here. The caller made it and is the one that knows what to
   * say to whatever was in flight on it.
   */
  async attach(transport: WorkerPortTransport): Promise<void> {
    this.#offPush();
    this.#transport = transport;
    this.#offPush = transport.onPush(this.#onPush);
    this.rows.clear();
    this.#results.clear();
    await this.hydrate();
    const registered: Promise<void>[] = [];
    for (const entry of [...this.#watched.values()]) {
      entry.ready = this.#register(entry.query);
      registered.push(entry.ready);
    }
    await Promise.all(registered);
    this.engine.notify();
  }

  /** Loads this scope's rows out of the worker. Resolves once they are here. */
  async hydrate(): Promise<void> {
    const delta = await this.#transport.request({
      type: "hydrate",
      scopeId: this.scopeId,
      deviceId: this.deviceId,
    });
    this.#applyDelta(asDelta(delta));
    this.engine.notify();
  }

  /**
   * Registers a statement with the worker, which re-runs it after every mutation. Resolves once
   * its first answer is in.
   *
   * Registrations are counted, not replaced. Two components rendering the same list watch the same
   * cache key, and without a count the first of them to unmount would unwatch the statement out
   * from under the second — which shows up as a list that silently stops updating, not as an error.
   * The second and later callers await the first one's round trip rather than opening their own, so
   * one statement is one registration in the worker however many places read it.
   */
  watch(query: ReactiveSqlQuery): Promise<void> {
    const existing = this.#watched.get(query.cacheKey);
    if (existing !== undefined) {
      existing.refs += 1;
      return existing.ready;
    }
    // Recorded before the round trip, so a push that beats the reply is recognised rather than
    // dropped as belonging to a statement nobody asked for.
    // `ready` is filled in straight after rather than passed in, because `#register` resolves
    // against this very entry: the map has to hold it before the round trip can end.
    const entry: MirrorWatch = { query, refs: 1, ready: Promise.resolve() };
    this.#watched.set(query.cacheKey, entry);
    entry.ready = this.#register(query);
    return entry.ready;
  }

  /** Stops the worker recomputing a statement, once nobody here is reading it any more. */
  unwatch(query: ReactiveSqlQuery): void {
    const entry = this.#watched.get(query.cacheKey);
    if (entry === undefined) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.#watched.delete(query.cacheKey);
    this.#results.delete(query.cacheKey);
    this.#send({ type: "unwatch", cacheKey: query.cacheKey });
  }

  /**
   * One row as `WeftDb` hands it out, read from the last push rather than from the database. The
   * fields are the ones the worker sent, so a row this mirror has not been told about — one outside
   * the hydrated scope, or one whose delta is still crossing — reads as missing rather than stale.
   */
  getRow(tableName: TableName, rowId: RowId): MaterializedRow | undefined {
    const row = this.rows.get(localKey(tableName, rowId));
    return row === undefined ? undefined : materializeRow(row);
  }

  /** Every row of a collection this mirror holds, in the order the worker's pushes filled the map. */
  listRows(tableName: TableName): MaterializedRow[] {
    const prefix = `${tableName}\0`;
    return [...this.rows.entries()].filter(([key]) => key.startsWith(prefix)).map(([, row]) => materializeRow(row));
  }

  /**
   * Whether this row has work the scope has not seen. Synchronous and local, because a list asks
   * it of every row it renders: it reads the dirty counter the worker mirrored onto the row, which
   * is the same number `WeftClient.isRowDirty` computes from its outbox and quarantine.
   */
  isRowDirty(tableName: TableName, rowId: RowId): boolean {
    const row = this.rows.get(localKey(tableName, rowId));
    return row !== undefined && row.internals._weft_dirty !== 0;
  }

  create(tableName: TableName, rowId: RowId, values: Record<string, WireValue>, txnId = randomTxnId()): void {
    this.#mutate({ kind: "create", tableName, rowId, txnId, values });
  }

  append(tableName: TableName, rowId: RowId, values: Record<string, WireValue>, txnId = randomTxnId()): void {
    this.#mutate({ kind: "append", tableName, rowId, txnId, values });
  }

  update(tableName: TableName, rowId: RowId, values: Record<string, WireValue>, txnId = randomTxnId()): void {
    this.#mutate({ kind: "update", tableName, rowId, txnId, values });
  }

  delete(tableName: TableName, rowId: RowId, txnId = randomTxnId()): void {
    this.#mutate({ kind: "delete", tableName, rowId, txnId });
  }

  restore(tableName: TableName, rowId: RowId, txnId = randomTxnId()): void {
    this.#mutate({ kind: "restore", tableName, rowId, txnId });
  }

  /**
   * Hands the worker the credential its session runs under, or `null` to sign out.
   *
   * The page keeps the token, because the page is where it can be got: a worker has no
   * `localStorage` and no redirect to read one out of. What it does not keep is the session, so
   * this is the whole of the arrangement rather than a side-channel beside it.
   *
   * Signing out leaves unsent work queued. The device still holds it, and signing back in pushes
   * it (§4.1); dropping it is `discardQuarantine`, which is a different decision made deliberately.
   */
  setToken(token: string | null): void {
    this.#send({ type: "auth", token });
  }

  /**
   * Syncs now rather than at the next poll. Resolves when that sync has finished, so a pull-to-
   * refresh can stop spinning at the right moment; a failure to reach the relay is an ordinary
   * state and settles the status rather than rejecting here.
   */
  async sync(): Promise<void> {
    await this.#transport.request({ type: "sync" });
  }

  /** Drops this device's diverged work and re-derives its rows from the relay (§5.5). */
  discardQuarantine(): void {
    this.#send({ type: "discardQuarantine" });
  }

  /**
   * What the worker's session last reported, or nothing before it has reported anything — which is
   * the state of a device that has not signed in yet, not an error. The object is the one the
   * worker sent and is replaced only when a new push arrives, so `useSyncExternalStore` can compare
   * it by identity.
   */
  status(): SessionStatus | undefined {
    return this.#status;
  }

  subscribeStatus(listener: () => void): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  /**
   * Stops applying pushes. The transport is left alone: the caller made it, and on a migration the
   * caller replaces it under a mirror that carries on — so tearing it down here would take the
   * tab's connection with the mirror.
   */
  dispose(): void {
    this.#offPush();
  }

  async #register(query: ReactiveSqlQuery): Promise<void> {
    const ids = await this.#transport.request({
      type: "watch",
      cacheKey: query.cacheKey,
      tableName: query.tableName,
      query: query.compiled,
    });
    // Unwatched while the registration was in flight: the answer is for a statement this page has
    // already stopped caring about, and caching it would resurrect it.
    if (!this.#watched.has(query.cacheKey)) return;
    this.#results.set(query.cacheKey, asIds(ids));
    this.engine.notify();
  }

  #mutate(mutation: WorkerMutation): void {
    this.#send({ type: "mutate", mutation });
  }

  /**
   * Fire and forget, but not fire and ignore. A mutator returns `void` — the row map moves when
   * the echo arrives, not when the call returns — so the only place a refusal can surface is here.
   */
  #send(body: WorkerRequestBody): void {
    void this.#transport.request(body).catch((error: unknown) => {
      this.#onError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  readonly #onPush = (push: WorkerPush): void => {
    if (!isDeltaPush(push)) {
      // Status listeners rather than the engine's: nothing about a row moved, and waking every
      // subscribed query so a connection indicator could change colour would re-scan every list
      // on this page each time the relay was polled.
      this.#status = push.status;
      for (const listener of [...this.#statusListeners]) listener();
      return;
    }
    this.#applyDelta(push);
    this.engine.notify();
  };

  #applyDelta(delta: WorkerDelta): void {
    for (const key of delta.removed) this.rows.delete(key);
    // Only the rows that moved are in the delta, so every other entry in the map keeps the object
    // it had — and with it the revision `RowIdentityCache` decides identity by, which is what makes
    // `React.memo` hold across a push that touched one row of a thousand.
    for (const row of delta.rows) this.rows.set(localKey(toTableName(row.tableName), toRowId(row.id)), toLocalRow(row));
    // Every result in the delta is one this page asked for: the worker sends each port only the
    // statements that port registered, so there is nothing here to sift out. A delta that carried
    // the whole scope's statements would wake this tab for every list every other tab is rendering.
    for (const [cacheKey, ids] of delta.results) this.#results.set(cacheKey, ids as readonly RowId[]);
  }
}

/** One registered statement, and how many callers here are still reading it. */
interface MirrorWatch {
  /**
   * The statement itself, kept rather than only its cache key.
   *
   * A registration lives in the worker, and the worker dies with the tab that created it. A tab
   * that reconnects after leadership moved therefore has to register everything it is reading all
   * over again — and a cache key is a hash of the compiled statement, which cannot be turned back
   * into one.
   */
  readonly query: ReactiveSqlQuery;
  refs: number;
  /** The first caller's round trip, which every later caller for this key awaits instead of its own. */
  ready: Promise<void>;
}

const EMPTY: readonly RowId[] = [];

function defaultOnError(error: Error): void {
  console.error("weftdb: a mutation the worker was given failed", error);
}

function toLocalRow(row: WireRow): LocalRow {
  return {
    id: toRowId(row.id),
    scopeId: toScopeId(row.scopeId),
    tableName: toTableName(row.tableName),
    created: row.created,
    fields: new Map(row.fields.map(([name, value]) => [fieldName(name), value] as const)),
    internals: {
      // Per-field HLCs, diff3 ancestors and the first-sync stamp stay in the worker: they are what
      // the sync session and retention read, and neither of those runs on this thread.
      _weft_first_synced_at: null,
      // Mirrored exactly. This is the single correctness property the bridge rests on — see
      // `WireRow.rev`.
      _weft_rev: row.rev,
      _weft_dirty: row.dirty,
      hlc: new Map(),
      diff3Base: new Map(),
    },
  };
}

/**
 * A row in the shape `WeftDb` returns. Frozen, and over a copy of the field map, so a caller cannot
 * write into the mirror's own row and have the next push silently undo it.
 */
function materializeRow(row: LocalRow): MaterializedRow {
  return Object.freeze({
    id: row.id,
    scope_id: row.scopeId,
    created: row.created,
    fields: new Map(row.fields),
  });
}

function asDelta(value: unknown): WorkerDelta {
  if (typeof value !== "object" || value === null) throw new Error("the worker answered with no delta");
  const delta = value as Partial<WorkerDelta>;
  if (!Array.isArray(delta.rows) || !Array.isArray(delta.removed) || !Array.isArray(delta.results)) {
    throw new Error("the worker answered with a malformed delta");
  }
  return delta as WorkerDelta;
}

function asIds(value: unknown): readonly RowId[] {
  if (!Array.isArray(value)) throw new Error("the worker answered a watch with no id list");
  return value as readonly RowId[];
}

function localKey(tableName: TableName, rowId: RowId): string {
  return `${tableName}\0${rowId}`;
}

function randomTxnId(): TxnId {
  return toTxnId(crypto.randomUUID());
}
