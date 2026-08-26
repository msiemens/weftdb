// The worker half of the page-to-worker bridge: the end `WorkerPortTransport` sends to.
//
// The whole client runs here, beside the database it writes itself through to. One host serves
// every tab that asked for this database, so a row one tab writes is a row the tab beside it is
// told about, and all of them queue their unsent work in the one outbox their shared device id
// stamps.
//
// What crosses back is a row delta, not an acknowledgement. The page applies nothing optimistically
// and therefore has nothing to roll back, which is what keeps the client's "no rollback path"
// (DESIGN.md §259) true of the worker-backed path as well as the main-thread one.
//
// Nothing here knows what the database is stored in. The executor and the store are options, so the
// same host runs against a `node:sqlite` file behind `asyncSqlExecutor` and a `MessageChannel` port
// under Node.
import {
  deviceId as toDeviceId,
  fieldName,
  rowId as toRowId,
  scopeId as toScopeId,
  tableName as toTableName,
  txnId as toTxnId,
  type FieldName,
  type RowId,
  type WireValue,
} from "weftdb/core";
import type { SchemaHash } from "weftdb/core";
import type { AsyncSqlExecutor, SqlRow, SqlValue } from "weftdb/shared";
import { executorRowSelect, reactiveSqlQuery, type ReactiveSqlQuery } from "./subscriptions.ts";
import type { CompiledQuery } from "./query.ts";
import { WeftSession, type SessionStatus, type SocketHandlers } from "./session.ts";
import type { AsyncSyncTransport } from "./transport.ts";
import type { SocketTransport } from "./socket-transport.ts";
// Type-only, because `./sqlite.ts` pulls the codegen module in with it and the client entry point
// is kept clear of that. The caller constructs the store.
import type { SqliteClientStore } from "./sqlite.ts";
import type { ClientPersistence, LocalRow, WeftClient } from "./index.ts";
import type { WireRow, WorkerDelta, WorkerHydrated, WorkerMessage, WorkerMutation, WorkerRequest } from "./worker.ts";

/**
 * The worker's own side of one tab's connection: a `MessagePort` `onconnect` handed over. It is the
 * mirror image of `WorkerLike`, sending `WorkerMessage` — replies and unsolicited pushes alike —
 * and receiving `WorkerRequest`.
 *
 * `start` is optional because a test's stand-in may not have one, and a `MessagePort` reached
 * through `addEventListener` delivers nothing until it is started.
 */
export interface WorkerHostPortLike {
  postMessage(message: WorkerMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
  start?(): void;
}

/**
 * What the worker needs to keep the client it holds in touch with a relay.
 *
 * The session has to run here for the same reason the client does: it drives `syncWith` against a
 * `WeftClient` this thread owns, and reaches into its outbox and quarantine to say what is pending.
 * Left on the page it would be driving a client it cannot see, and every application would write
 * the same side-channel to bridge the gap.
 *
 * `transport` is a function of the credential rather than a value, because a transport carries its
 * token: the socket presents one when it connects, and HTTP sends one per request. Signing in as
 * somebody else is therefore a new transport, not a mutated one.
 */
export interface WeftWorkerSessionOptions {
  readonly schemaHash: SchemaHash;
  /** Built per credential. Called again whenever the token changes. */
  readonly transport: (token: string) => AsyncSyncTransport;
  /** Opened and closed by the session. Also per credential, for the same reason. */
  readonly openSocket?: (handlers: SocketHandlers, token: string) => SocketTransport;
  readonly pollWhileLiveMs?: number;
  readonly pollWhileBlindMs?: number;
  readonly debounceMs?: number;
  readonly now?: () => number;
}

export interface WeftWorkerHostOptions {
  /** The first tab. Left out for a host whose ports all arrive through `connect`. */
  readonly port?: WorkerHostPortLike;
  /**
   * The database. Must be the same handle the store writes through, or a watched statement is run
   * against one file while the rows it selects are saved into another.
   */
  readonly executor: AsyncSqlExecutor;
  readonly store: SqliteClientStore;
  /**
   * The schema this host serves, answered to every `hydrate` so a page built from another is
   * refused rather than left selecting columns this database has never had.
   */
  readonly schemaHash: SchemaHash;
  /**
   * Left out for a device that never syncs. Without it the three session verbs are refused rather
   * than silently accepted, so a page that expected to be syncing hears about it.
   */
  readonly session?: WeftWorkerSessionOptions;
  /**
   * Called once the last tab has disconnected.
   *
   * A `SharedWorker` outlives every tab of its origin, so a client nobody released is a client's
   * worth of rows held in the worker's heap until the browser stops it — and one worker holds a
   * database per `(namespace, scope)` an origin has open.
   */
  readonly onIdle?: () => void;
}

/**
 * Serves the worker protocol on a port. Returns the host, which owns the hydrated client and can
 * be stopped.
 */
export function serveWeftWorker(options: WeftWorkerHostOptions): WeftWorkerHost {
  return new WeftWorkerHost(options);
}

/**
 * One connected tab: the port it talks on, the listener attached to that port, and what it has
 * registered.
 *
 * The watches are counted per connection rather than only in aggregate because a port is the only
 * handle the host has on a tab. A tab that goes away has to have its registrations released, and
 * "which of the watches were this tab's" is a question nothing else can answer — a cache key is
 * derived from the statement, so two tabs watching one list are indistinguishable in the aggregate
 * count.
 */
interface HostConnection {
  readonly port: WorkerHostPortLike;
  readonly listener: (event: MessageEvent<WorkerRequest>) => void;
  /** cacheKey -> how many registrations this port is holding. Also what a delta to it carries. */
  readonly watching: Map<string, number>;
}

/** What a statement nobody is registered for answers. Shared, because it is never written to. */
const NO_IDS: readonly string[] = [];

export class WeftWorkerHost {
  /**
   * Every tab this worker is serving. One in the ordinary single-tab case; one more for each tab
   * that had a port delivered here — see `connect`.
   */
  readonly #connections = new Set<HostConnection>();
  readonly #executor: AsyncSqlExecutor;
  readonly #store: SqliteClientStore;
  /**
   * The statements are run here, on the database this host holds, so this always has an answer —
   * which is why it is `executorRowSelect`'s narrower result rather than a `RowSelect`. The absent
   * answer is the page's state, not the worker's.
   */
  readonly #select: (query: ReactiveSqlQuery) => Promise<readonly RowId[]>;
  /**
   * Statements the pages are watching, by the cache key they know them under, with how many of them
   * asked.
   *
   * Counted because one worker serves every tab: two tabs rendering the same list register the same
   * cache key — it is derived from the compiled statement — and an `unwatch` that simply deleted the
   * entry would stop recomputing a statement the other tab is still showing.
   */
  readonly #watched = new Map<string, { readonly query: ReactiveSqlQuery; refs: number }>();
  /**
   * Rows touched since the last push, as `${tableName}\0${id}` keys. Accumulated rather than read
   * on demand: see `#recorder`.
   */
  readonly #changed = new Set<string>();
  readonly #sessionOptions: WeftWorkerSessionOptions | undefined;
  readonly #schemaHash: SchemaHash;
  readonly #onIdle: (() => void) | undefined;
  #client: WeftClient | undefined;
  /** Which client this host hydrated, so a re-hydrate after a failed write asks for the same one. */
  #identity: { readonly scopeId: string; readonly deviceId: string } | undefined;
  /**
   * Set when a durable write was refused, which leaves the in-memory client ahead of the database
   * it is supposed to be the state of. See `#reload`.
   */
  #stale = false;
  #session: WeftSession | undefined;
  /** `start`'s teardown: stops the poll timer and closes the socket. */
  #stopSession: (() => void) | undefined;
  #offStatus: (() => void) | undefined;
  #token: string | null = null;
  #lastStatus: SessionStatus | undefined;
  #serving = true;
  /** Set once the last port has gone, and reported after that port's own goodbye is answered. */
  #idle = false;
  /**
   * Deltas, in the order the changes they describe happened.
   *
   * Reading what a statement now answers is a query against the database, so a push has to wait
   * for one — and two pushes started a moment apart would otherwise deliver in whichever order
   * their queries finished, leaving a tab holding the older of two answers with nothing to correct
   * it.
   */
  #pushing: Promise<void> = Promise.resolve();

  constructor(options: WeftWorkerHostOptions) {
    this.#executor = options.executor;
    this.#store = options.store;
    this.#sessionOptions = options.session;
    this.#schemaHash = options.schemaHash;
    this.#onIdle = options.onIdle;
    this.#select = executorRowSelect(options.executor);
    if (options.port !== undefined) this.connect(options.port);
  }

  /** The session this host is running, if it has been given a token to run one under. */
  get session(): WeftSession | undefined {
    return this.#session;
  }

  /** The client this host hydrated, or nothing if it has not been asked to hydrate one yet. */
  get client(): WeftClient | undefined {
    return this.#client;
  }

  /** How many tabs this worker is serving. */
  get connections(): number {
    return this.#connections.size;
  }

  /**
   * Which statements this worker is still recomputing after every mutation, by cache key.
   *
   * For a test to read. A push carries only the asking tab's own statements, so a registration
   * nobody released shows on no individual port, and the worker recomputes that statement for the
   * rest of the session on behalf of a tab that has gone.
   */
  get watching(): readonly string[] {
    return [...this.#watched.keys()];
  }

  /**
   * Serves one more tab on a port of its own.
   *
   * `replay` is what the caller read off the port before it knew which host this port belonged to.
   * A `SharedWorker`'s `onconnect` hands over a port carrying no statement of which database it
   * wants, so the entry point reads until the `hydrate` says — and everything it took off the port
   * on the way has to be answered rather than dropped.
   *
   * A port is started before it is listened on, because a `MessagePort` reached through
   * `addEventListener` queues what arrives and delivers none of it until `start`.
   */
  connect(port: WorkerHostPortLike, replay: readonly WorkerRequest[] = []): void {
    if (!this.#serving) return;
    const listener = (event: MessageEvent<WorkerRequest>): void => {
      this.#accept(connection, event.data);
    };
    const connection: HostConnection = { port, listener, watching: new Map() };
    this.#connections.add(connection);
    port.addEventListener("message", listener);
    port.start?.();
    for (const request of replay) this.#accept(connection, request);
  }

  /** Stops answering every tab, and stops the session with it. */
  stop(): void {
    this.#serving = false;
    this.#endSession();
    for (const connection of [...this.#connections]) this.#drop(connection);
  }

  #accept(connection: HostConnection, message: unknown): void {
    if (!this.#serving) return;
    // Anything without a correlation id is not a request. The page's mirror listens on this same
    // port for pushes, and in a `MessageChannel` test both halves can see each other's traffic.
    if (typeof message !== "object" || message === null || typeof (message as WorkerRequest).id !== "number") return;
    const request = message as WorkerRequest;
    // Through a promise whether or not the handler returned one: `sync` answers when the sync it
    // ran has finished, and a page that awaited it would otherwise be told "done" while the relay
    // was still being talked to.
    void Promise.resolve()
      .then(() => this.#handle(connection, request))
      .then(
        (value) => {
          // To the port the request came in on, and to no other. Every tab's requests are numbered
          // from one in the tab that issued them, so an answer posted to all of them settles
          // whichever request each tab happens to have outstanding under that number — one tab's
          // row list handed to another, with nothing anywhere reporting a fault.
          this.#post(connection, { id: request.id, ok: true, value });
        },
        (error: unknown) => {
          // A rejection crosses as text: an `Error` does not survive a structured clone with its
          // prototype intact, and dropping it would hang the page on a request already given up on.
          this.#post(connection, {
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      )
      .then(() => {
        if (!this.#idle) return;
        this.#idle = false;
        this.#onIdle?.();
      });
  }

  /** Answers, or a promise of one: `sync` settles when the sync it ran has finished. */
  #handle(connection: HostConnection, request: WorkerRequest): unknown {
    switch (request.type) {
      case "close":
        return this.#close();
      case "disconnect":
        return this.#disconnect(connection);
      case "execute":
        return this.#execute(request.query);
      case "hydrate":
        return this.#hydrate(connection, request.scopeId, request.deviceId);
      case "mutate":
        return this.#mutate(request.mutation);
      case "watch":
        return this.#watch(connection, request.cacheKey, request.tableName, request.query);
      case "unwatch":
        this.#unwatch(connection, request.cacheKey);
        return null;
      case "auth":
        return this.#auth(request.token);
      case "sync":
        return this.#requireSession().sync();
      case "discardQuarantine":
        return this.#requireSession().discardQuarantine();
    }
  }

  /**
   * A tab saying it has gone. Its registrations are released and its port is dropped.
   *
   * Answered rather than silently acted on, and the answer goes out before the port is dropped, so
   * a tab that awaited its own goodbye is told rather than left waiting. See `#post`, which posts to
   * the connection it is given whether or not that connection is still in the set.
   */
  #disconnect(connection: HostConnection): null {
    if (!this.#connections.has(connection)) return null;
    for (const [cacheKey, count] of connection.watching) {
      // Once per registration, because the aggregate count is per registration: a tab that watched
      // a statement twice holds two references, and releasing one would leave the worker
      // recomputing a statement nobody reads for the rest of the session.
      for (let index = 0; index < count; index += 1) this.#release(cacheKey);
    }
    this.#drop(connection);
    return null;
  }

  /** Stops listening on a port and forgets it. The port itself is the page's to close. */
  #drop(connection: HostConnection): void {
    this.#connections.delete(connection);
    connection.watching.clear();
    connection.port.removeEventListener("message", connection.listener);
    // Recorded here and reported in `#accept`, because whoever hears it is entitled to stop this
    // host and the tab that left is still owed the answer to the goodbye that retired it.
    if (this.#serving && this.#connections.size === 0) this.#idle = true;
  }

  /**
   * Takes the credential the session runs under. A token is not applied to the running session: a
   * socket presents its token when it connects, so the session is rebuilt around the new one and
   * its socket reopened.
   *
   * Signing out ends the session and closes the socket. It does not touch the outbox: unsent work
   * is the device's, not the session's, and a person who signs out and back in expects to find it
   * still queued (§4.1). What it does do is publish one last status saying so, because a page whose
   * status stream simply stopped would go on showing a live connection that has been closed.
   */
  #auth(token: string | null): null {
    if (this.#sessionOptions === undefined) throw new Error("this worker was not given session options");
    if (token === this.#token) return null;
    this.#token = token;
    this.#endSession();
    if (token === null) {
      this.#postSignedOut();
      return null;
    }
    this.#startSession();
    return null;
  }

  /** Builds and starts a session for the current token, if there is both a token and a client. */
  #startSession(): void {
    const options = this.#sessionOptions;
    const token = this.#token;
    const client = this.#client;
    // A token can arrive before the page has asked to hydrate, and a hydrate can arrive before
    // anyone has signed in. Whichever lands second starts the session; neither is an error.
    if (options === undefined || token === null || client === undefined) return;
    const openSocket = options.openSocket;
    const session = new WeftSession({
      client,
      schemaHash: options.schemaHash,
      transport: options.transport(token),
      ...(openSocket === undefined ? {} : { openSocket: (handlers: SocketHandlers) => openSocket(handlers, token) }),
      // A sync applies what the relay sent, so the rows it moved have to reach the page by the
      // same path a mutation's do. Without this a device would pull a neighbour's edit and show
      // it only when something local happened to push next.
      onChange: () => void this.#push(),
      ...(options.pollWhileLiveMs === undefined ? {} : { pollWhileLiveMs: options.pollWhileLiveMs }),
      ...(options.pollWhileBlindMs === undefined ? {} : { pollWhileBlindMs: options.pollWhileBlindMs }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#session = session;
    // The session publishes only when a status differs from the last one it published, so this is
    // one message per real change rather than one per poll.
    this.#offStatus = session.subscribe(() => this.#postStatus(session.status()));
    this.#stopSession = session.start();
    this.#postStatus(session.status());
  }

  #endSession(): void {
    this.#offStatus?.();
    this.#offStatus = undefined;
    this.#stopSession?.();
    this.#stopSession = undefined;
    this.#session?.dispose();
    this.#session = undefined;
  }

  #postStatus(status: SessionStatus): void {
    this.#lastStatus = status;
    // Every tab, for the same reason a delta goes to every tab: one session runs here and what it
    // is doing is true of the device rather than of whichever tab last asked something.
    this.#broadcast({ push: "status", status });
  }

  /**
   * The status of a device with no session: whatever was last true of it, with the three things
   * that describe a live connection turned off. Synthesised rather than read, because the session
   * that could have reported it has been stopped — and saying nothing would leave the page showing
   * the connection it had before it signed out.
   */
  #postSignedOut(): void {
    const last = this.#lastStatus;
    if (last === undefined) return;
    this.#postStatus({ ...last, online: false, syncing: false, live: false });
  }

  #requireSession(): WeftSession {
    const session = this.#session;
    if (session === undefined) {
      throw new Error(
        this.#sessionOptions === undefined
          ? "this worker was not given session options"
          : "this worker has no session: hydrate a client and set a token first",
      );
    }
    return session;
  }

  /**
   * Every row of the scope, and the schema this worker serves.
   *
   * Answering at all is also what tells a tab that the port it was given reached a worker that is
   * serving; nothing else on this protocol has to be sent for that, because this is the first thing
   * a tab sends and it is waiting for the reply regardless.
   */
  async #hydrate(connection: HostConnection, scopeId: string, deviceId: string): Promise<WorkerHydrated> {
    this.#identity = { scopeId, deviceId };
    const client = await this.#store.hydrate(toScopeId(scopeId), toDeviceId(deviceId));
    client.persistence = this.#recorder(client.persistence);
    // A hydrate replaces the client, and a session drives the one it was built with. Ending the
    // old one first is what stops a poll firing against a client this host has let go of.
    this.#endSession();
    this.#client = client;
    this.#stale = false;
    this.#changed.clear();
    this.#startSession();
    // Every row this scope holds, in the one delta shape a push uses, so the page has a single
    // path for "rows arrived" and `_weft_rev` cannot be carried differently by the two.
    return { ...(await this.#delta(connection, [...client.rows.keys()])), schemaHash: this.#schemaHash };
  }

  /**
   * A persistence that notes which rows moved on the way to the store, and whether the store took
   * them.
   *
   * The obvious way to collect the keys — call `client.drainTouchedRows()` once the mutation has
   * been applied — reads an empty set. Every mutator calls `persist()` itself, and
   * `SqliteClientStore.save` takes the touched rows to decide what to write, so the keys are gone
   * before the request handler regains control. Reading them here, before delegating, is what
   * leaves the store its own reason to write them.
   */
  #recorder(inner: ClientPersistence | undefined): ClientPersistence {
    const store = inner ?? this.#store;
    return {
      save: async (client) => {
        for (const key of client.touchedRows) this.#changed.add(key);
        try {
          await store.save(client);
        } catch (error) {
          this.#stale = true;
          throw error;
        }
      },
    };
  }

  async #mutate(mutation: WorkerMutation): Promise<null> {
    // In a `finally`, because a mutation that throws partway — an `update` that wrote one field
    // and was refused the next — has still moved rows, and the page would otherwise render a
    // state the worker no longer holds.
    try {
      await this.#apply(mutation);
    } finally {
      if (this.#stale) await this.#reload();
      await this.#push();
    }
    return null;
  }

  /**
   * Throws away a client the database refused a write from, and reads another out of the file.
   *
   * A mutator changes `rows`, `outbox` and `touchedRows` and then persists, so a write the database
   * rejected — a quota refusal, an aborted transaction — leaves the client holding a state the file
   * does not have and holding it for the rest of the session. Rejecting the caller's promise tells
   * the caller; it repairs nothing here.
   *
   * What comes back is whatever committed, which is exactly the right answer, and every key either
   * client held is marked changed so the delta that follows corrects each tab's rows rather than
   * leaving them showing a write that did not happen.
   */
  async #reload(): Promise<void> {
    const identity = this.#identity;
    if (identity === undefined) return;
    this.#stale = false;
    const previous = this.#client;
    const client = await this.#store.hydrate(toScopeId(identity.scopeId), toDeviceId(identity.deviceId));
    client.persistence = this.#recorder(client.persistence);
    this.#endSession();
    this.#client = client;
    for (const key of previous?.rows.keys() ?? []) this.#changed.add(key);
    for (const key of client.rows.keys()) this.#changed.add(key);
    this.#startSession();
  }

  async #apply(mutation: WorkerMutation): Promise<void> {
    const client = this.#requireClient();
    const tableName = toTableName(mutation.tableName);
    const rowId = toRowId(mutation.rowId);
    const txnId = toTxnId(mutation.txnId);
    switch (mutation.kind) {
      case "create":
        return client.create(tableName, rowId, fieldValues(mutation.values), txnId);
      case "append":
        return client.append(tableName, rowId, fieldValues(mutation.values), txnId);
      case "update":
        return client.update(tableName, rowId, fieldValues(mutation.values), txnId);
      case "delete":
        return client.delete(tableName, rowId, txnId);
      case "restore":
        // No values on the wire, so none here: the row still exists in the scope and its fields
        // come back on the next pull.
        return client.restore(tableName, rowId, {}, txnId);
    }
  }

  async #watch(
    connection: HostConnection,
    cacheKey: string,
    tableName: string,
    query: CompiledQuery,
  ): Promise<readonly string[]> {
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
    connection.watching.set(cacheKey, (connection.watching.get(cacheKey) ?? 0) + 1);
    // Answered with the ids straight away, so a page that has just subscribed does not have to
    // wait for something else to change before its list fills in.
    return this.#ids(cacheKey);
  }

  /**
   * Hands one registration back, on behalf of the tab that took it.
   *
   * A port may only release what it is holding. Without that check a tab could decrement a
   * registration another tab made — by unwatching twice, or by unwatching a cache key it never
   * asked for — and retire a statement the other tab is still rendering from.
   */
  #unwatch(connection: HostConnection, cacheKey: string): void {
    const held = connection.watching.get(cacheKey) ?? 0;
    if (held === 0) return;
    if (held === 1) connection.watching.delete(cacheKey);
    else connection.watching.set(cacheKey, held - 1);
    this.#release(cacheKey);
  }

  #release(cacheKey: string): void {
    const entry = this.#watched.get(cacheKey);
    if (entry === undefined) return;
    entry.refs -= 1;
    if (entry.refs <= 0) this.#watched.delete(cacheKey);
  }

  #execute(query: CompiledQuery): Promise<readonly SqlRow[]> {
    return this.#executor.all({
      sql: query.sql,
      parameters: query.parameters.map(toSqlValue),
      decode: (row) => row,
    });
  }

  async #close(): Promise<null> {
    this.#endSession();
    this.#watched.clear();
    // The per-tab counts go with the registry they were counting into. Left standing, a later
    // disconnect would release references against a registry that had already been emptied.
    for (const connection of this.#connections) connection.watching.clear();
    this.#client = undefined;
    this.#identity = undefined;
    // Only if the executor has one to give back. `AsyncSqlExecutor` declares none, and a database
    // whose connection is the process's own has nothing to release.
    await (this.#executor as Partial<{ close: () => Promise<void> }>).close?.();
    return null;
  }

  /**
   * Posts what has moved since the last push, and tells each tab what *its own* statements now say.
   *
   * The rows go to everybody. A row belongs to the scope rather than to whichever tab typed into
   * it, so a push sent only to the tab that mutated is a page whose rows freeze the moment another
   * tab is the one typing.
   *
   * The results do not. A tab rendering one list has no use for the lists every other tab is
   * rendering, and sending them anyway wakes it — the mirror notifies its engine on every delta —
   * so a busy neighbour costs this tab a re-scan of its own subscriptions for nothing. The host
   * knows which port asked for what (`HostConnection.watching`), so it can simply not send them.
   *
   * Each statement is still computed exactly once. Two tabs rendering one list share a registration,
   * because the cache key is derived from the compiled statement, so the work is done here against
   * `#watched` and only the delivery is per port.
   */
  #push(): Promise<void> {
    // A sync that was already in flight when the page asked to close the database still runs its
    // own teardown, and calls back here to say what moved — against a client this host has let go
    // of. There is nothing left to describe and nobody left to describe it to, so this is where it
    // stops rather than throwing out of a promise the poll started and nobody is holding.
    if (this.#client === undefined) return Promise.resolve();
    // The rows are read before the wait, because `client.rows` is what the next mutation changes:
    // a delta assembled afterwards would carry the keys of the change that started it and the row
    // values of every change that landed while it queued.
    const keys = [...this.#changed];
    this.#changed.clear();
    const moved = this.#moved(keys);
    this.#pushing = this.#pushing.then(() => this.#deliver(moved));
    return this.#pushing;
  }

  async #deliver(moved: { readonly rows: readonly WireRow[]; readonly removed: readonly string[] }): Promise<void> {
    const answers = new Map<string, readonly string[]>();
    for (const cacheKey of this.#watched.keys()) answers.set(cacheKey, await this.#ids(cacheKey));
    // Over a copy, for the reason `#broadcast` takes one: posting to a port is what makes a tab
    // notice its state has moved, and a tab is allowed to answer that by disconnecting.
    for (const connection of [...this.#connections]) {
      this.#post(connection, {
        push: "delta",
        ...moved,
        results: [...connection.watching.keys()].map(
          (cacheKey) => [cacheKey, answers.get(cacheKey) ?? NO_IDS] as const,
        ),
      });
    }
  }

  /**
   * The delta one connection is owed: the rows that moved, plus what the statements *that*
   * connection registered answer now.
   *
   * Used for a hydrate's reply, which is addressed to one port like any other reply.
   */
  async #delta(connection: HostConnection, keys: readonly string[]): Promise<WorkerDelta> {
    const results: (readonly [string, readonly string[]])[] = [];
    for (const cacheKey of connection.watching.keys()) results.push([cacheKey, await this.#ids(cacheKey)] as const);
    return { ...this.#moved(keys), results };
  }

  /** The row half of a delta, which is the same for every tab of the scope. */
  #moved(keys: readonly string[]): { readonly rows: readonly WireRow[]; readonly removed: readonly string[] } {
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
    return { rows, removed };
  }

  async #ids(cacheKey: string): Promise<readonly string[]> {
    const entry = this.#watched.get(cacheKey);
    return entry === undefined ? [] : this.#select(entry.query);
  }

  /**
   * Posts to one tab. Takes the connection rather than looking one up, and does not require it to
   * still be in the set: `#disconnect` answers the request that retired it.
   */
  #post(connection: HostConnection, message: WorkerMessage): void {
    if (!this.#serving) return;
    connection.port.postMessage(message);
  }

  #broadcast(message: WorkerMessage): void {
    if (!this.#serving) return;
    // Over a copy: posting to a port is what makes a tab notice its state has moved, and a tab is
    // allowed to answer that by disconnecting, which would otherwise skip whoever came after it.
    for (const connection of [...this.#connections]) connection.port.postMessage(message);
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
