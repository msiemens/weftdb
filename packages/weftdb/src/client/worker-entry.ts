// The worker's front door: the other half of `openWeftDatabase`, and the whole of what a storage
// worker has to say.
//
// It is a module of its own rather than another export of `worker-host.ts` because it reaches for
// `./sqlite.ts`, which pulls the codegen module in with it. `worker-host.ts` takes its executor and
// its store as options precisely so that it does not, and the page's entry point is kept clear of
// codegen for the same reason. A worker entry point is the one place that dependency belongs, so
// this has a package subpath of its own and nothing on the page imports it.
//
// Storage is OPFS, through a synchronous access handle pool, wherever a browser will hand one out.
// Where it will not — private browsing is the case that matters — the database is opened in memory
// instead and the page is told which it got, so an application can say that this window will not
// remember. What is never worked around is a *build* with no pool VFS in it at all: see below.
import { schemaHash, type SchemaDefinition } from "weftdb/schema";
import type { SqlExecutor } from "weftdb/shared";
import { SqliteClientStore } from "./sqlite.ts";
import { connectSocketTransport } from "./socket-transport.ts";
import { httpTransport, type FetchLike } from "./transport.ts";
import type { SocketHandlers } from "./session.ts";
import {
  openMemorySqliteExecutor,
  openWebSqliteExecutor,
  WasmSqliteUnavailableError,
  type Sqlite3Module,
  type WasmSqliteExecutor,
} from "./wasm-sqlite.ts";
import { serveWeftWorker, type WeftWorkerHost, type WorkerHostPortLike } from "./worker-host.ts";
import type { WeftDurability, WeftWorkerReady } from "./worker.ts";
import type { WebSocketFactory } from "./wakeups.ts";

/**
 * Where the relay is, and how hard to try to reach it.
 *
 * The credential is deliberately absent: the page holds that, because the page is the only place a
 * token can be got, and it arrives over the port. What is here is what the worker builds a transport
 * out of — and it is here rather than on the page because the worker is where the transport is
 * built. A base URL declared on both sides that had to agree is a value nothing checks, wrong only
 * at runtime and only sometimes.
 */
export interface WeftWorkerRelayOptions {
  /** Where the relay is mounted, e.g. `/api/db` behind a dev-server proxy or an absolute origin. */
  readonly baseUrl: string;
  /** Where the relay's sync socket is. Left out means HTTP and a poll, which still works. */
  readonly socketUrl?: string;
  readonly fetch?: FetchLike;
  readonly WebSocket?: WebSocketFactory;
  readonly pollWhileLiveMs?: number;
  readonly pollWhileBlindMs?: number;
  readonly debounceMs?: number;
  readonly now?: () => number;
}

export interface ServeWeftWorkerDefaultsOptions {
  readonly schema: SchemaDefinition;
  /**
   * The `@sqlite.org/sqlite-wasm` default export, uncalled. The module is the application's to
   * supply, so which build of SQLite ships — or whether one ships at all — stays its decision and
   * this package keeps no SQLite runtime dependency.
   */
  readonly sqlite3InitModule: () => Promise<Sqlite3Module>;
  /** Left out for a device that never syncs: the three session verbs are then refused, not ignored. */
  readonly relay?: WeftWorkerRelayOptions;
  /** The port to serve on. The worker's own global by default, which is what a real worker wants. */
  readonly port?: WorkerHostPortLike;
  /** The database's name within the pool. */
  readonly path?: string;
  readonly poolName?: string;
  readonly initialCapacity?: number;
}

/**
 * Opens this device's database and serves it, then says so.
 *
 * The announcement is the point of the return path. Whether OPFS will hand out a synchronous access
 * handle pool is a property of the worker and of nothing the page can see, so the page cannot decide
 * in advance; and a failure thrown here would reach it as an `error` event with no detail, or as an
 * unhandled rejection with none at all. Reported as an ordinary message, it becomes a rejected
 * `openWeftDatabase` naming the cause — or, where the database was opened in memory instead, an open
 * that succeeds and reports `durability: "ephemeral"`.
 *
 * Resolves with the host, or with nothing when there was no database to serve — the page has already
 * been told which by then.
 */
export async function serveWeftWorkerDefaults(
  options: ServeWeftWorkerDefaultsOptions,
): Promise<WeftWorkerHost | undefined> {
  // A dedicated worker's own global is the port it serves on.
  const port: WorkerHostPortLike = options.port ?? globalThis;
  let executor: (SqlExecutor & { close(): void }) | undefined;
  try {
    const sqlite3 = await options.sqlite3InitModule();
    const opened = await openDatabase(sqlite3, options);
    executor = opened.executor;
    const durability = opened.durability;
    const store = new SqliteClientStore(executor, options.schema);
    // Every open, not only the first: this is also what adds the columns a schema edit introduced
    // since the database was last opened.
    store.installSchema();
    const host = serveWeftWorker({
      port,
      executor,
      store,
      durability,
      ...(options.relay === undefined ? {} : { session: session(options.schema, options.relay) }),
    });
    // After `serveWeftWorker`, never before. The page waits for this before it posts anything, so a
    // request cannot arrive while there is no listener to receive it — which on a dedicated worker
    // is a message delivered to nobody rather than a message queued.
    post(port, { weft: "ready", ok: true, schemaHash: schemaHash(options.schema), durability });
    return host;
  } catch (error) {
    // The handle, if one was ever taken, before the page is told there is no database: a pool left
    // open would keep the file locked against the tab that takes over.
    executor?.close();
    post(port, { weft: "ready", ok: false, error: describe(error) });
    return undefined;
  }
}

/**
 * OPFS if the browser will have it, memory if it will not — and nothing at all if the build cannot
 * do OPFS in the first place.
 *
 * The two failures are one failure to look at and could not be further apart in what they mean.
 *
 * `WasmSqliteUnavailableError` says the sqlite3 module has no `installOpfsSAHPoolVfs` on it: there
 * is no pool VFS in this build, on any browser, for anybody. Falling back there would hand a
 * developer a database that works perfectly through every reload of development and loses every
 * device's data in production, with the build that shipped wrong never once saying so. So it is
 * rethrown and the open is refused.
 *
 * Anything else thrown from installing the pool or opening the file means the function is there and
 * the browser declined — a mode with no OPFS to give, which is what private browsing is. The person
 * asked the browser for a session it would not remember; they get a working database that keeps
 * nothing, and the page is told so.
 */
async function openDatabase(
  sqlite3: Sqlite3Module,
  options: ServeWeftWorkerDefaultsOptions,
): Promise<{ readonly executor: WasmSqliteExecutor; readonly durability: WeftDurability }> {
  try {
    const executor = await openWebSqliteExecutor(sqlite3, {
      path: options.path ?? "weft.sqlite3",
      ...(options.poolName === undefined ? {} : { poolName: options.poolName }),
      ...(options.initialCapacity === undefined ? {} : { initialCapacity: options.initialCapacity }),
    });
    return { executor, durability: "durable" };
  } catch (error) {
    if (error instanceof WasmSqliteUnavailableError) throw error;
    // `:memory:` needs no OPFS, no VFS install and no access handle, so nothing that just failed can
    // fail again here. It is a real SQLite: every statement the durable path answers, this answers.
    return { executor: openMemorySqliteExecutor(sqlite3), durability: "ephemeral" };
  }
}

function session(
  schema: SchemaDefinition,
  relay: WeftWorkerRelayOptions,
): NonNullable<Parameters<typeof serveWeftWorker>[0]["session"]> {
  const socketUrl = relay.socketUrl;
  return {
    schemaHash: schemaHash(schema),
    // Per credential rather than per session: a transport carries its token, so signing in as
    // somebody else is a new transport rather than a mutated one.
    transport: (token) =>
      httpTransport({
        baseUrl: relay.baseUrl,
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
    ...(relay.pollWhileLiveMs === undefined ? {} : { pollWhileLiveMs: relay.pollWhileLiveMs }),
    ...(relay.pollWhileBlindMs === undefined ? {} : { pollWhileBlindMs: relay.pollWhileBlindMs }),
    ...(relay.debounceMs === undefined ? {} : { debounceMs: relay.debounceMs }),
    ...(relay.now === undefined ? {} : { now: relay.now }),
  };
}

/**
 * The announcement is not part of the request/response protocol `WorkerHostPortLike` describes — it
 * carries neither the id a reply is recognised by nor the tag a push is — so it goes out through the
 * port's own widest shape rather than widening that interface. Everything already listening on
 * either end drops it untouched; see `WeftWorkerReady`.
 */
function post(port: WorkerHostPortLike, message: WeftWorkerReady): void {
  (port as unknown as { postMessage(message: WeftWorkerReady): void }).postMessage(message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
