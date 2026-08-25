// The worker half of the page-to-worker bridge. `OpfsWorkerTransport` has always been a sender
// with nothing on the other end; this is the other end.
//
// The whole client runs here. That is forced rather than chosen: `SqlExecutor` is synchronous, the
// only browser storage SQLite can reach synchronously is an OPFS sync access handle, and a sync
// access handle exists only inside a dedicated worker — so the `WeftClient` whose every change is
// written through to that database has to be in the worker with it.
//
// What crosses back is a row delta, not an acknowledgement. The page applies nothing optimistically
// and therefore has nothing to roll back, which is what keeps the client's "no rollback path"
// (DESIGN.md §259) true of the worker-backed path as well as the main-thread one.
//
// Nothing here knows about OPFS. The executor and the store are options, so the same host runs
// against `openSqliteExecutor(":memory:")` and a `MessageChannel` port under Node.
import {
  deviceId as toDeviceId,
  fieldName,
  rowId as toRowId,
  scopeId as toScopeId,
  tableName as toTableName,
  txnId as toTxnId,
  type FieldName,
  type WireValue,
} from "weftdb/core";
import type { SqlExecutor, SqlRow, SqlValue } from "weftdb/shared";
import { executorRowSelect, reactiveSqlQuery, type ReactiveSqlQuery, type RowSelect } from "./subscriptions.ts";
import type { CompiledQuery } from "./query.ts";
// Type-only, and deliberately so: `./sqlite.ts` pulls the codegen module in with it, and the
// client entry point is kept clear of that. The caller constructs the store.
import type { SqliteClientStore } from "./sqlite.ts";
import type { ClientPersistence, LocalRow, WeftClient } from "./index.ts";
import type { WireRow, WorkerDelta, WorkerMessage, WorkerMutation, WorkerRequest } from "./worker.ts";

/**
 * The worker's own side of the port. In a dedicated worker this is `self`; in a test it is one end
 * of a `MessageChannel`. It is the mirror image of `WorkerLike`: it sends `WorkerMessage` — replies
 * and unsolicited pushes alike — and receives `WorkerRequest`.
 */
export interface WorkerHostPortLike {
  postMessage(message: WorkerMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
}

export interface WeftWorkerHostOptions {
  readonly port: WorkerHostPortLike;
  /**
   * The database. Must be the same handle the store writes through, or a watched statement is run
   * against one file while the rows it selects are saved into another.
   */
  readonly executor: SqlExecutor;
  readonly store: SqliteClientStore;
}

/**
 * Serves the worker protocol on a port. Returns the host, which owns the hydrated client and can
 * be stopped.
 */
export function serveWeftWorker(options: WeftWorkerHostOptions): WeftWorkerHost {
  return new WeftWorkerHost(options);
}

export class WeftWorkerHost {
  readonly #port: WorkerHostPortLike;
  readonly #executor: SqlExecutor;
  readonly #store: SqliteClientStore;
  readonly #select: RowSelect;
  /**
   * Statements the pages are watching, by the cache key they know them under, with how many of them
   * asked.
   *
   * Counted because one worker now serves every tab: a follower reaches this host through the
   * leader's `BroadcastDbProxy`, so two tabs rendering the same list register the same cache key,
   * and an `unwatch` that simply deleted the entry would stop recomputing a statement the other tab
   * is still showing. The count is per registration rather than per tab because the proxy does not
   * name its tabs here — which is fine as long as each tab registers a key once and hands back
   * exactly what it took, which is what `WeftClientMirror` and `BroadcastDbProxy.dispose` between
   * them guarantee.
   */
  readonly #watched = new Map<string, { readonly query: ReactiveSqlQuery; refs: number }>();
  /**
   * Rows touched since the last push, as `${tableName}\0${id}` keys. Accumulated rather than read
   * on demand: see `#recorder`.
   */
  readonly #changed = new Set<string>();
  #client: WeftClient | undefined;
  #serving = true;

  constructor(options: WeftWorkerHostOptions) {
    this.#port = options.port;
    this.#executor = options.executor;
    this.#store = options.store;
    this.#select = executorRowSelect(options.executor);
    this.#port.addEventListener("message", this.#onMessage);
  }

  /** The client this host hydrated, or nothing if it has not been asked to hydrate one yet. */
  get client(): WeftClient | undefined {
    return this.#client;
  }

  /** Stops answering. A reply produced after this is dropped rather than posted. */
  stop(): void {
    this.#serving = false;
    this.#port.removeEventListener("message", this.#onMessage);
  }

  readonly #onMessage = (event: MessageEvent<WorkerRequest>): void => {
    if (!this.#serving) return;
    const request = event.data;
    // Anything without a correlation id is not a request. The page's mirror listens on this same
    // port for pushes, and in a `MessageChannel` test both halves can see each other's traffic.
    if (typeof request !== "object" || request === null || typeof request.id !== "number") return;
    try {
      this.#post({ id: request.id, ok: true, value: this.#handle(request) });
    } catch (error) {
      // A rejection crosses as text: an `Error` does not survive a structured clone with its
      // prototype intact, and dropping it would hang the page on a request already given up on.
      this.#post({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  #handle(request: WorkerRequest): unknown {
    switch (request.type) {
      case "open":
        // The database was opened before this host was constructed — the executor is an option —
        // so this is an acknowledgement that the worker is up, not an instruction.
        return null;
      case "close":
        return this.#close();
      case "execute":
        return this.#execute(request.query);
      case "hydrate":
        return this.#hydrate(request.scopeId, request.deviceId);
      case "mutate":
        return this.#mutate(request.mutation);
      case "watch":
        return this.#watch(request.cacheKey, request.tableName, request.query);
      case "unwatch":
        this.#unwatch(request.cacheKey);
        return null;
    }
  }

  #hydrate(scopeId: string, deviceId: string): WorkerDelta {
    const client = this.#store.hydrate(toScopeId(scopeId), toDeviceId(deviceId));
    client.persistence = this.#recorder(client.persistence);
    this.#client = client;
    this.#changed.clear();
    // Every row this scope holds, in the one delta shape a push uses, so the page has a single
    // path for "rows arrived" and `_weft_rev` cannot be carried differently by the two.
    return this.#delta([...client.rows.keys()]);
  }

  /**
   * A persistence that notes which rows moved on the way to the store.
   *
   * The obvious implementation — call `client.drainTouchedRows()` once the mutation has been
   * applied — reads an empty set. Every mutator calls `persist()` itself, and
   * `SqliteClientStore.save` drains the touched rows to decide what to write, so the keys are gone
   * before the request handler regains control. Reading them here, before delegating, is what
   * leaves the store its own reason to write them.
   */
  #recorder(inner: ClientPersistence | undefined): ClientPersistence {
    const store = inner ?? this.#store;
    return {
      save: (client) => {
        for (const key of client.touchedRows) this.#changed.add(key);
        store.save(client);
      },
    };
  }

  #mutate(mutation: WorkerMutation): null {
    // In a `finally`, because a mutation that throws partway — an `update` that wrote one field
    // and was refused the next — has still moved rows, and the page would otherwise render a
    // state the worker no longer holds.
    try {
      this.#apply(mutation);
    } finally {
      this.#push();
    }
    return null;
  }

  #apply(mutation: WorkerMutation): void {
    const client = this.#requireClient();
    const tableName = toTableName(mutation.tableName);
    const rowId = toRowId(mutation.rowId);
    const txnId = toTxnId(mutation.txnId);
    switch (mutation.kind) {
      case "create":
        client.create(tableName, rowId, fieldValues(mutation.values), txnId);
        return;
      case "append":
        client.append(tableName, rowId, fieldValues(mutation.values), txnId);
        return;
      case "update":
        client.update(tableName, rowId, fieldValues(mutation.values), txnId);
        return;
      case "delete":
        client.delete(tableName, rowId, txnId);
        return;
      case "restore":
        // No values on the wire, so none here: the row still exists in the scope and its fields
        // come back on the next pull.
        client.restore(tableName, rowId, {}, txnId);
        return;
    }
  }

  #watch(cacheKey: string, tableName: string, query: CompiledQuery): readonly string[] {
    const existing = this.#watched.get(cacheKey);
    // A second tab watching a list the first tab already watches. The compiled statement is the
    // same — the cache key is derived from it — so the registration is shared rather than rebuilt,
    // and only the count moves.
    if (existing !== undefined) existing.refs += 1;
    else {
      // Rebuilt rather than trusted: `reactiveSqlQuery` refuses a statement that does not constrain
      // `scope_id`, and one database file holds every scope this device is signed into.
      this.#watched.set(cacheKey, { query: reactiveSqlQuery({ tableName: toTableName(tableName), query }), refs: 1 });
    }
    // Answered with the ids straight away, so a page that has just subscribed does not have to
    // wait for something else to change before its list fills in.
    return this.#ids(cacheKey);
  }

  #unwatch(cacheKey: string): void {
    const entry = this.#watched.get(cacheKey);
    if (entry === undefined) return;
    entry.refs -= 1;
    if (entry.refs <= 0) this.#watched.delete(cacheKey);
  }

  #execute(query: CompiledQuery): readonly SqlRow[] {
    return this.#executor.all({
      sql: query.sql,
      parameters: query.parameters.map(toSqlValue),
      decode: (row) => row,
    });
  }

  #close(): null {
    this.#watched.clear();
    this.#client = undefined;
    // Only if the executor has a handle to give back. `SqlExecutor` does not declare one — an
    // in-memory database has nothing to close — but the OPFS one holds a sync access handle, and
    // leaving it open keeps the file locked against the next tab.
    (this.#executor as Partial<{ close: () => void }>).close?.();
    return null;
  }

  /** Posts what has moved since the last push, along with what every watched statement now says. */
  #push(): void {
    const keys = [...this.#changed];
    this.#changed.clear();
    this.#post({ push: "delta", ...this.#delta(keys) });
  }

  #delta(keys: readonly string[]): WorkerDelta {
    const client = this.#requireClient();
    const rows: WireRow[] = [];
    const removed: string[] = [];
    for (const key of keys) {
      const row = client.rows.get(key);
      // A touched key the client no longer holds was deleted, or purged, or superseded by a
      // tombstone. Either way the page has to be told to drop it, and the key is the only handle
      // left to name it by.
      if (row === undefined) removed.push(key);
      else rows.push(toWireRow(row));
    }
    return {
      rows,
      removed,
      // Every watched key, not only the ones the tab that caused this asked for — this host has one
      // registry and every tab's statements are in it. That is what makes one relayed push enough
      // for all of them: each mirror keeps the keys it is watching and drops the rest, so a leader
      // does not have to work out which follower cares about what.
      results: [...this.#watched.keys()].map((cacheKey) => [cacheKey, this.#ids(cacheKey)] as const),
    };
  }

  #ids(cacheKey: string): readonly string[] {
    const entry = this.#watched.get(cacheKey);
    return entry === undefined ? [] : this.#select(entry.query);
  }

  #post(message: WorkerMessage): void {
    if (!this.#serving) return;
    this.#port.postMessage(message);
  }

  #requireClient(): WeftClient {
    const client = this.#client;
    if (client === undefined) throw new Error("the worker has not hydrated a client yet");
    return client;
  }
}

function toWireRow(row: LocalRow): WireRow {
  return {
    tableName: row.tableName,
    id: row.id,
    scopeId: row.scopeId,
    created: row.created,
    fields: [...row.fields.entries()],
    // Sent as it stands. The mirror's `RowIdentityCache` keys a materialized row on this number,
    // so a revision that arrived renumbered would either hand React a stale object for a row that
    // changed or a fresh one for a row that did not.
    rev: row.internals._weft_rev,
    dirty: row.internals._weft_dirty,
  };
}

function fieldValues(values: Readonly<Record<string, WireValue>>): Record<FieldName, WireValue> {
  const fields: Record<FieldName, WireValue> = {};
  for (const [name, value] of Object.entries(values)) fields[fieldName(name)] = value;
  return fields;
}

/**
 * A bind parameter as the executor takes it. A query builder types its parameters `unknown`,
 * and SQLite takes four kinds of which a boolean is not one — so `where("done", "=", false)`
 * would otherwise reach the driver as a boolean and fail at the binding rather than answering.
 * `executorRowSelect` does the same for the statements this host watches; this covers the raw
 * `execute` path, which does not go through it.
 */
function toSqlValue(value: unknown): SqlValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (value instanceof Uint8Array) return value as Uint8Array<ArrayBuffer>;
  throw new Error(`a SQL parameter of this kind cannot be bound: ${value === undefined ? "undefined" : typeof value}`);
}
