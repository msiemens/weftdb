// The worker's front door. The other half of `openWeftDatabase`, and the whole of what a storage
// worker has to say.
//
// A module of its own rather than another export of `worker-host.ts` because it reaches for
// `./sqlite.ts`, which pulls the codegen module in with it. `worker-host.ts` takes its executor and
// its store as options precisely so that it does not, and the page's entry point is kept clear of
// codegen for the same reason. A worker entry point is the one place that dependency belongs, so
// this has a package subpath of its own and nothing on the page imports it.
//
// One `SharedWorker` serves the whole origin, and a port arrives through `onconnect` saying nothing
// about which database it wants. The first request on it does: a `hydrate` carries the scope and
// the namespace, and those two together name both the file to open and the client to hold (see
// `./database-key.ts`). So this module reads a port until that first request, opens what it names,
// and hands the port and everything it read to the host that owns it.
//
// Files and clients are keyed differently, so each has a map of its own. A file belongs to a
// namespace: one application in this origin, one IndexedDB database, one connection. A client
// belongs to a namespace and a scope together, because `SqliteClientStore.hydrate` filters every
// read by scope and a client that read the lot would push another scope's rows under this device's
// id.
import { schemaHash, type SchemaDefinition } from "weftdb/schema";
import { weftDatabaseKey, type WeftDatabaseIdentity } from "./database-key.ts";
import { SqliteClientStore } from "./sqlite.ts";
import { connectSocketTransport, type SocketTransport } from "./socket-transport.ts";
import { httpTransport, type AsyncSyncTransport, type FetchLike } from "./transport.ts";
import type { SocketHandlers } from "./session.ts";
import { openWebSqliteExecutor, type WaSqliteBuild, type WebSqliteExecutor } from "./wasm-sqlite.ts";
import { serveWeftWorker, type WeftWorkerHost, type WorkerHostPortLike } from "./worker-host.ts";
import type { WorkerRequest } from "./worker.ts";
import type { WebSocketFactory } from "./socket-transport.ts";

/** How hard to try, whichever way the relay is named. Timing, and nothing about where it is. */
export interface WeftWorkerRelayTuning {
  readonly pollWhileLiveMs?: number;
  readonly pollWhileBlindMs?: number;
  readonly debounceMs?: number;
  readonly now?: () => number;
}

/**
 * The relay at a URL, which is the case a deployment is.
 *
 * The credential is not here. The page holds it, because the page is the only place a
 * token can be got, and it arrives over the port. What is here is what the worker builds a transport
 * out of, and it is here rather than on the page because the worker is where the transport is
 * built. A base URL declared on both sides that had to agree is a value nothing checks, wrong only
 * at runtime and only sometimes.
 */
export interface WeftWorkerRelayUrl extends WeftWorkerRelayTuning {
  /** Where the relay is mounted, e.g. `/api/db` behind a dev-server proxy or an absolute origin. */
  readonly baseUrl: string;
  /** Where the relay's sync socket is. Left out means HTTP and a poll, which still works. */
  readonly socketUrl?: string;
  readonly fetch?: FetchLike;
  readonly WebSocket?: WebSocketFactory;
  readonly transport?: never;
  readonly openSocket?: never;
}

/**
 * The relay as a transport this worker was handed, for a relay that is not at a URL at all.
 *
 * The members are the ones `WeftWorkerSessionOptions` already declares, because this is the
 * general case and `WeftWorkerRelayUrl` is the shorthand for the common one, so an
 * application that outgrows the shorthand keeps everything else `serveWeftStorageWorker` does
 * (opening the file its namespace names, installing the schema, serving each arriving port) instead
 * of assembling the worker by hand to change one line. `transport` is a function of the credential
 * for the same reason it is one there. A transport carries its token, so signing in as somebody
 * else is a new transport rather than a mutated one.
 *
 * The case it exists for is a relay reachable over a `MessagePort`. No URL describes that, and
 * `fetch` cannot reach it.
 *
 * Both are told which database they are being built for. One worker serves every database this
 * origin opens, so an application with an endpoint or a credential per namespace, or a relay it can
 * only reach through something one tab handed over, has no other way to tell one session's
 * connection from another's.
 *
 * `baseUrl` and `transport` are each `never` on the other side, so giving both at once is a type
 * error instead of quietly having one of them ignored.
 */
export interface WeftWorkerRelaySupplied extends WeftWorkerRelayTuning {
  /** Built per credential, for one database. Called again whenever the token changes. */
  readonly transport: (token: string, database: WeftDatabaseIdentity) => AsyncSyncTransport;
  /** The live connection, if this relay has one. Left out means the fallback poll alone. */
  readonly openSocket?: (handlers: SocketHandlers, token: string, database: WeftDatabaseIdentity) => SocketTransport;
  readonly baseUrl?: never;
  readonly socketUrl?: never;
  readonly fetch?: never;
  readonly WebSocket?: never;
}

/** Where the relay is: a URL the worker builds a transport from, or a transport it is handed. */
export type WeftWorkerRelayOptions = WeftWorkerRelayUrl | WeftWorkerRelaySupplied;

/**
 * `SharedWorkerGlobalScope`, named because this package is typechecked without the DOM library.
 *
 * An application's worker module is this, and nothing else:
 *
 * ```ts title="src/storage-worker.ts"
 * const worker = serveWeftStorageWorker({ schema, sqlite });
 * (globalThis as unknown as WeftWorkerScope).onconnect = (event) => {
 *   const port = event.ports[0];
 *   if (port !== undefined) worker.connect(port);
 * };
 * ```
 *
 * The two lines are written out rather than done here, so a worker that has something of its own to
 * say to each arriving port (a demo handing over a relay it can only reach as a `MessagePort`)
 * listens on that port before passing it on.
 */
export interface WeftWorkerScope {
  onconnect: ((event: { readonly ports: readonly WorkerHostPortLike[] }) => void) | null;
}

export interface ServeWeftStorageWorkerOptions {
  readonly schema: SchemaDefinition;
  /**
   * This application's SQLite build, uninitialised. The module is the application's to supply, so
   * which build of SQLite ships, and which VFS its databases live in, stays its decision and this
   * package keeps no SQLite runtime dependency.
   */
  readonly sqlite: () => Promise<WaSqliteBuild>;
  /** Left out for a device that never syncs. The three session verbs are then refused instead of ignored. */
  readonly relay?: WeftWorkerRelayOptions;
}

/** Serves every database this origin opens, on every port handed to `connect`. */
export function serveWeftStorageWorker(options: ServeWeftStorageWorkerOptions): WeftStorageWorker {
  return new WeftStorageWorker(options);
}

/** One namespace's database: the connection, and the store that installs the schema into it. */
interface OpenDatabase {
  readonly executor: WebSqliteExecutor;
  readonly store: SqliteClientStore;
}

/**
 * One `(namespace, scope)`'s client, as the host that owns it.
 *
 * The namespace sits beside the promise rather than inside what it resolves to, so `#release` can
 * ask which other clients share a file without awaiting. A port that arrives while it is deciding
 * would otherwise be handed a connection it is about to close.
 */
interface OpenClient {
  readonly namespace: string;
  readonly opening: Promise<WeftWorkerHost>;
  /** The same host once it exists, for `watching` to read without awaiting. */
  host: WeftWorkerHost | undefined;
}

export class WeftStorageWorker {
  readonly #options: ServeWeftStorageWorkerOptions;
  readonly #schemaHash: ReturnType<typeof schemaHash>;
  /** namespace -> the file it is kept in. Held as promises, so two ports racing open one database. */
  readonly #databases = new Map<string, Promise<OpenDatabase>>();
  /** database key -> the client serving it, for the same reason. */
  readonly #clients = new Map<string, OpenClient>();
  #serving = true;

  constructor(options: ServeWeftStorageWorkerOptions) {
    this.#options = options;
    this.#schemaHash = schemaHash(options.schema);
  }

  /**
   * Serves one arriving port, once it has said which database it is for.
   *
   * Everything the port sends before the routing is settled is collected rather than dropped. The
   * listener stays attached until the host has one of its own, and the two swap in the same turn,
   * so nothing arrives while nobody is listening.
   */
  connect(port: WorkerHostPortLike): void {
    const queued: WorkerRequest[] = [];
    let routed = false;
    const listener = (event: MessageEvent<WorkerRequest>): void => {
      const request = event.data;
      queued.push(request);
      if (routed || request.type !== "hydrate") return;
      routed = true;
      const { scopeId, namespace } = request;
      void this.#serve(port, listener, queued, scopeId, namespace);
    };
    port.addEventListener("message", listener);
    port.start?.();
  }

  /** Everything this worker has open, by database key. For a test to read. */
  get serving(): readonly string[] {
    return [...this.#clients.keys()];
  }

  /**
   * Every statement this worker is still recomputing after each mutation, across every database.
   *
   * For a test to read. A registration nobody released is a statement recomputed for the life of
   * the browser, and no individual port can see one. A push carries only that port's own
   * statements.
   */
  get watching(): readonly string[] {
    return [...this.#clients.values()].flatMap((client) => client.host?.watching ?? []);
  }

  /** Stops every client and closes every file. */
  async stop(): Promise<void> {
    this.#serving = false;
    for (const client of [...this.#clients.values()]) (await client.opening).stop();
    this.#clients.clear();
    for (const pending of [...this.#databases.values()]) await (await pending).executor.close();
    this.#databases.clear();
  }

  async #serve(
    port: WorkerHostPortLike,
    listener: (event: MessageEvent<WorkerRequest>) => void,
    queued: readonly WorkerRequest[],
    scopeId: string,
    namespace: string,
  ): Promise<void> {
    const key = weftDatabaseKey(scopeId, namespace);
    const database = { namespace, scopeId };
    const client = this.#clients.get(key) ?? { namespace, opening: this.#open(key, database), host: undefined };
    this.#clients.set(key, client);
    const host = await client.opening;
    client.host = host;
    if (!this.#serving) return;
    port.removeEventListener("message", listener);
    host.connect(port, queued);
  }

  async #open(key: string, database: WeftDatabaseIdentity): Promise<WeftWorkerHost> {
    const open = await this.#database(database.namespace);
    return serveWeftWorker({
      executor: open.executor,
      store: open.store,
      schemaHash: this.#schemaHash,
      onIdle: () => void this.#release(key, database.namespace),
      ...(this.#options.relay === undefined ? {} : { session: this.#session(this.#options.relay, database) }),
    });
  }

  #database(namespace: string): Promise<OpenDatabase> {
    const existing = this.#databases.get(namespace);
    if (existing !== undefined) return existing;
    const opening = this.#openDatabase(namespace);
    this.#databases.set(namespace, opening);
    return opening;
  }

  async #openDatabase(namespace: string): Promise<OpenDatabase> {
    const build = await this.#options.sqlite();
    const executor = await openWebSqliteExecutor(build, {
      path: `${storageNameFor(namespace)}.sqlite3`,
      name: storageNameFor(namespace),
    });
    const store = new SqliteClientStore(executor, this.#options.schema);
    // Run on every open, including after the first. This is also what adds the columns a schema
    // edit introduced since the database was last opened.
    await store.installSchema();
    return { executor, store };
  }

  /**
   * Drops a client whose last tab has gone, and the file with it once no client of that namespace
   * is left.
   *
   * A tab that comes back opens both again, and what it reads is whatever committed. Holding them
   * would keep one database per `(namespace, scope)` this origin had ever opened resident in the
   * worker's heap, for as long as the browser keeps the worker.
   */
  async #release(key: string, namespace: string): Promise<void> {
    const client = this.#clients.get(key);
    if (client === undefined) return;
    this.#clients.delete(key);
    (await client.opening).stop();
    for (const other of this.#clients.values()) if (other.namespace === namespace) return;
    const database = this.#databases.get(namespace);
    if (database === undefined) return;
    this.#databases.delete(namespace);
    await (await database).executor.close();
  }

  #session(
    relay: WeftWorkerRelayOptions,
    database: WeftDatabaseIdentity,
  ): NonNullable<Parameters<typeof serveWeftWorker>[0]["session"]> {
    return {
      schemaHash: this.#schemaHash,
      ...reach(relay, database),
      ...(relay.pollWhileLiveMs === undefined ? {} : { pollWhileLiveMs: relay.pollWhileLiveMs }),
      ...(relay.pollWhileBlindMs === undefined ? {} : { pollWhileBlindMs: relay.pollWhileBlindMs }),
      ...(relay.debounceMs === undefined ? {} : { debounceMs: relay.debounceMs }),
      ...(relay.now === undefined ? {} : { now: relay.now }),
    };
  }
}

/**
 * What one namespace's storage is called: the name of its IndexedDB database, and the name of
 * the file inside it (with `.sqlite3` after it).
 *
 * The namespace has to be in the file name as well as in the store's, because a browser VFS names
 * what it shares after the file path alone and what it shares is origin-wide. `IDBMirrorVFS` takes
 * Web Locks called `<path>@@write` and posts every committed transaction to a `BroadcastChannel`
 * called `mirror:<path>`, so two namespaces opening a file of one name in one origin contend for a
 * single lock and deliver each other's transactions into each other's mirrors, which reads as
 * `database is locked` on one tab and `missing tx` on the next.
 *
 * Encoded because a namespace is a string an application chose and this names storage.
 * `encodeURIComponent` leaves an ordinary name readable and cannot map two namespaces onto one
 * store, because it can be decoded back.
 */
function storageNameFor(namespace: string): string {
  return `weft-${encodeURIComponent(namespace)}`;
}

/**
 * How this worker talks to the relay about one database, from whichever half of the union named
 * it. A supplied factory is bound to that database; a URL is turned into the same pair.
 */
function reach(
  relay: WeftWorkerRelayOptions,
  database: WeftDatabaseIdentity,
): {
  readonly transport: (token: string) => AsyncSyncTransport;
  readonly openSocket?: (handlers: SocketHandlers, token: string) => SocketTransport;
} {
  if (relay.transport !== undefined) {
    const supplied = relay.transport;
    const openSocket = relay.openSocket;
    return {
      transport: (token) => supplied(token, database),
      ...(openSocket === undefined
        ? {}
        : { openSocket: (handlers: SocketHandlers, token: string) => openSocket(handlers, token, database) }),
    };
  }
  const socketUrl = relay.socketUrl;
  const baseUrl = relay.baseUrl;
  return {
    // Per credential rather than per session. A transport carries its token, so signing in as
    // somebody else is a new transport rather than a mutated one.
    transport: (token) =>
      httpTransport({
        baseUrl,
        token,
        ...(relay.fetch === undefined ? {} : { fetch: relay.fetch }),
      }),
    ...(socketUrl === undefined
      ? {}
      : {
          openSocket: (handlers: SocketHandlers, token: string) =>
            connectSocketTransport({
              url: socketUrl,
              token,
              onWake: () => handlers.onWake(),
              onBatch: handlers.onBatch,
              onStatusChange: () => handlers.onStatusChange(),
              cursor: handlers.cursor,
              ...(relay.WebSocket === undefined ? {} : { WebSocket: relay.WebSocket }),
            }),
        }),
  };
}
