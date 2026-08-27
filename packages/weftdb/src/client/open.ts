// The page's front door. Everything between "this application has a schema and a scope" and
// "components can read rows", paid once here instead of once per application.
//
// One `SharedWorker` holds every database this origin has open, and a tab reaches it by
// constructing one at the same URL and taking the port. A `SharedWorker` is identified by its
// script URL, so every tab that names the same one is served by the same instance, and the browser
// is what makes that exclusive.
//
// This module mints the device id, sends the `hydrate` that says which database the port wants,
// refuses a page and a worker built from different schemas, gives the mirror an engine of its own,
// and reconnects when the browser stops the worker under memory pressure.
import { deviceId as toDeviceId, type DeviceId } from "weftdb/core";
import { schemaHash, type SchemaDefinition } from "weftdb/schema";
import { DEFAULT_NAMESPACE } from "./database-key.ts";
import { SubscriptionEngine } from "./subscriptions.ts";
import type { SessionStatus } from "./session.ts";
import { WorkerPortTransport, type WorkerLike } from "./worker.ts";
import { WeftClientMirror } from "./worker-mirror.ts";

/** The slice of the DOM `Storage` interface the device id needs. `localStorage` satisfies it. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Where this device's credential comes from. Read again per credential; see `setToken`. */
export interface OpenRelayOptions {
  /**
   * The token the worker's sync session runs under, or `null` for a device that has not signed in.
   *
   * A function, because a transport carries its own token. HTTP sends one per request and
   * a socket presents one when it connects, so signing in as somebody else means building a new
   * transport instead of patching the current one. Re-reading it is how a refreshed token reaches
   * the session, which is what `setToken()` with no argument does.
   *
   * Where the relay is does not appear here. That belongs in the worker's own
   * `serveWeftStorageWorker({ relay })`, because the worker is where the transport is built, and
   * a base URL declared both here and in the worker's options is exactly the class of mistake this
   * module exists to remove.
   */
  readonly token: () => string | null;
}

export interface OpenWeftDatabaseOptions {
  /**
   * This application's schema. It is not used to open anything (the worker holds the database and
   * imports the schema itself), but its hash is compared against the one the worker reports, so a
   * page bundle and a worker bundle built from different schemas are refused instead of quietly
   * selecting columns the other one has never heard of.
   */
  readonly schema: SchemaDefinition;
  readonly scopeId: string;
  /**
   * The storage worker's module, as `new URL("./storage-worker.ts", import.meta.url)`.
   *
   * It is a `SharedWorker`, and a `SharedWorker` is identified by its script URL, so every tab of
   * the origin has to name the same one. That is why this is a URL the application owns instead
   * of something derived here.
   */
  readonly worker: URL | string;
  readonly relay?: OpenRelayOptions;
  /**
   * Where a failure with no caller to reject reaches the page: a statement the worker refused, a
   * reconnect that failed, and a mutation whose promise nobody kept. A mutator's own refusal is its
   * own promise rejecting.
   */
  readonly onError?: (error: Error) => void;
  /**
   * Where this device's id is kept. `localStorage` by default, so it survives the tab; taking it as
   * an option is what makes the identity testable and lets an application supply storage of its own.
   */
  readonly deviceStorage?: StorageLike;
  /**
   * Which application in this origin this database belongs to. `"weft"` by default.
   *
   * It is half of the database's identity, and the scope is the other half. Two calls that agree on
   * both are two tabs of one database: one client in the worker, one outbox, one device id. Two
   * calls that differ in either are two databases that share nothing (separate entries in the
   * worker, separate files, separate device ids), even where the `scopeId` is the same string.
   *
   * It also prefixes every key the device id is kept under.
   */
  readonly namespace?: string;
  /**
   * How the connection to the storage worker is made. The default constructs a `SharedWorker` and
   * hands back its port.
   *
   * Node has no `SharedWorker`, so this is what lets the assembly run there. A test connects a
   * `MessageChannel` end to a `serveWeftWorker` in the same process, which is the shipped host with
   * the process boundary taken out.
   */
  readonly connect?: (url: URL | string) => WorkerLike;
  /**
   * How long a request waits for the worker before this tab treats the worker as gone and
   * reconnects. Raise it where a device is expected to hold a database large enough that a cold
   * hydrate runs longer than the default.
   */
  readonly workerDeadlineMs?: number;
}

/** What an application is left holding. Everything else is the library's. */
export interface WeftDatabase {
  /**
   * What the generated hooks and mutators read and write through. It satisfies the `WeftSource`
   * shape the hooks take, so `use<Collection>` and `use<Collection>Query` work over it unchanged,
   * and `MutationTarget`, so `<collection>Mutators` writes through it.
   */
  readonly source: WeftClientMirror;
  /** What the worker's sync session last reported, or nothing before this device has signed in. */
  status(): SessionStatus | undefined;
  subscribeStatus(listener: () => void): () => void;
  /**
   * Hands the worker a credential. With no argument the `relay.token` function is read again, which
   * is how a refreshed token reaches the session; `null` signs out and leaves unsent work queued.
   */
  setToken(token?: string | null): Promise<void>;
  /**
   * Unwinds everything this opened, in an order that leaves nothing running. Safe to call more than
   * once, and safe to call without awaiting, since a `pagehide` handler should not block on it.
   */
  dispose(): Promise<void>;
}

export type WeftOpenFailure =
  /** The page and the worker were built from different schemas. */
  | "schema-mismatch"
  /** This environment has no `SharedWorker`, and no `connect` was supplied. */
  | "no-worker"
  /** This environment has no `localStorage` to keep a device id in, and none was supplied. */
  | "no-device-storage";

export class WeftOpenError extends Error {
  readonly reason: WeftOpenFailure;

  constructor(reason: WeftOpenFailure, detail: string) {
    super(detail);
    this.name = "WeftOpenError";
    this.reason = reason;
  }
}

/** What a request in flight when the worker went away is rejected with. */
const LOST = "the storage worker went away; the write's outcome is unknown";

/**
 * The device this browser is, for this scope.
 *
 * Namespaced by scope, so being signed into two scopes from one browser is two devices. The relay
 * counts devices per scope, and one id shared between them would have each scope's cursor advanced
 * by the other's pulls. Minted once and kept, because a device that renamed itself on every reload
 * would leave the relay a new device per visit and this device's own past writes stamped by
 * somebody else.
 */
export function deviceIdForScope(
  scopeId: string,
  options: { readonly storage?: StorageLike; readonly namespace?: string } = {},
): DeviceId {
  const storage = options.storage ?? defaultDeviceStorage();
  const key = `${options.namespace ?? DEFAULT_NAMESPACE}/device/${scopeId}`;
  const existing = storage.getItem(key);
  if (existing !== null && existing !== "") return toDeviceId(existing);
  const minted = crypto.randomUUID();
  storage.setItem(key, minted);
  return toDeviceId(minted);
}

/**
 * Opens this device's database and returns what an application reads and writes through.
 *
 * One call per scope per tab. Every tab of the origin is served by one `SharedWorker` and talks to
 * it over a port of its own, so nothing above this line has to know how many other tabs there are.
 */
export async function openWeftDatabase(options: OpenWeftDatabaseOptions): Promise<WeftDatabase> {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const deviceId = deviceIdForScope(options.scopeId, {
    ...(options.deviceStorage === undefined ? {} : { storage: options.deviceStorage }),
    namespace,
  });
  const tab = new DatabaseTab(options, deviceId, namespace);
  try {
    await tab.start();
  } catch (error) {
    await tab.dispose();
    throw error;
  }
  return tab.handle();
}

/**
 * One tab's whole connection to the database, from the open to the last teardown, across however
 * many workers it talks to on the way.
 *
 * A class rather than a function, because a browser may stop a `SharedWorker` under memory pressure
 * and every port to it dies at once. The tab that outlives it holds a mirror the application is
 * still reading from, and something has to own both that mirror and whichever transport is
 * currently under it.
 */
class DatabaseTab {
  readonly #options: OpenWeftDatabaseOptions;
  readonly #deviceId: DeviceId;
  readonly #namespace: string;
  #mirror: WeftClientMirror | undefined;
  #transport: WorkerPortTransport | undefined;
  /**
   * The credential last handed over, replayed after a reconnect. A new worker has never been told
   * one, and a device whose session silently stopped syncing would be the quietest possible
   * failure.
   */
  #token: string | null | undefined;
  #reconnecting: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(options: OpenWeftDatabaseOptions, deviceId: DeviceId, namespace: string) {
    this.#options = options;
    this.#deviceId = deviceId;
    this.#namespace = namespace;
  }

  /** Connects, hydrates, and checks that the worker is serving the schema this page was built from. */
  async start(): Promise<void> {
    const transport = this.#connect();
    const mirror = new WeftClientMirror({
      transport,
      scopeId: this.#options.scopeId,
      deviceId: this.#deviceId,
      namespace: this.#namespace,
      // One mirror, one engine. Sharing an engine between two mirrors has them evicting each
      // other's cached snapshots on every render, which `useSyncExternalStore` turns into an update
      // loop rather than a slow render, so the engine is built here and never handed out.
      engine: new SubscriptionEngine(),
      ...(this.#options.onError === undefined ? {} : { onError: this.#options.onError }),
    });
    this.#mirror = mirror;
    await mirror.hydrate();
    this.#requireSchemaMatch(mirror);
    // Handed over here because a mirror with no token has a client and no session. The worker holds
    // the rows and never syncs them, which is a device that works perfectly offline and never comes
    // back.
    const token = this.#options.relay?.token;
    if (token !== undefined) await this.setToken(token());
    // A `SharedWorker` the browser stopped takes every port with it, and the page learns of it from
    // a port that closes or from a request that goes unanswered. Reconnecting is constructing one at
    // the same URL again, which either wakes the stopped worker or joins the one already running.
    transport.onClosed(() => {
      this.#reconnecting = this.#reconnecting.then(() => this.#reconnect());
    });
  }

  handle(): WeftDatabase {
    const mirror = this.#requireMirror();
    const token = this.#options.relay?.token;
    return {
      source: mirror,
      status: () => mirror.status(),
      subscribeStatus: (listener) => mirror.subscribeStatus(listener),
      setToken: async (next) => {
        // No argument re-reads the option. A token that has been refreshed since the open is a new
        // credential, and the session is rebuilt around it instead of being patched in place.
        await this.setToken(next === undefined ? (token?.() ?? null) : next);
      },
      dispose: () => this.dispose(),
    };
  }

  /** Hands the worker this tab's credential, and remembers it for the next worker. */
  async setToken(token: string | null): Promise<void> {
    this.#token = token;
    await this.#mirror?.setToken(token);
  }

  /**
   * Unwinds everything, in the order that leaves nothing running.
   *
   * Each step is load-bearing. Stop applying pushes; hand this tab's watches back so the worker
   * stops recomputing statements nobody reads; then settle what was in flight and close the port,
   * which is what lets the worker drop a database whose last tab has gone.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#mirror?.dispose();
    const transport = this.#transport;
    this.#transport = undefined;
    if (transport === undefined) return;
    await transport.request({ type: "disconnect" }).catch(() => undefined);
    transport.dispose("the database was closed");
  }

  /**
   * The worker went away. Whatever was outstanding is settled, and everything this tab was reading
   * is asked for again from whichever worker answers now.
   */
  async #reconnect(): Promise<void> {
    if (this.#disposed) return;
    const mirror = this.#mirror;
    if (mirror === undefined) return;
    // First, and unconditionally. A request issued a moment before the worker vanished is never
    // going to be answered, and leaving it pending is a caller awaiting a promise nothing is left
    // to settle. It rejects instead of resolving. Telling a mutator that a write nobody performed
    // had succeeded is the one outcome worse than not knowing.
    this.#transport?.dispose(LOST);
    this.#transport = undefined;
    try {
      const transport = this.#connect();
      if (this.#disposed) return;
      // The rows and every registration are made again from the new worker. What comes back is
      // whatever committed to the database, which is also the answer for the write whose fate the
      // rejection above declined to guess at.
      await mirror.attach(transport);
      if (this.#token !== undefined) await mirror.setToken(this.#token);
      transport.onClosed(() => {
        this.#reconnecting = this.#reconnecting.then(() => this.#reconnect());
      });
    } catch (error) {
      this.#report(error);
    }
  }

  #connect(): WorkerPortTransport {
    const port = (this.#options.connect ?? defaultConnect)(this.#options.worker);
    const deadlineMs = this.#options.workerDeadlineMs;
    const transport = new WorkerPortTransport(port, ...(deadlineMs === undefined ? [] : [{ deadlineMs }]));
    this.#transport = transport;
    return transport;
  }

  #requireSchemaMatch(mirror: WeftClientMirror): void {
    const expected = schemaHash(this.#options.schema);
    const served = mirror.schemaHash;
    if (served === expected) return;
    throw new WeftOpenError(
      "schema-mismatch",
      `this page was built from schema ${expected} and its storage worker from ${String(served)}. ` +
        "They have to be the same schema: the worker's tables are generated from its own copy, so a " +
        "page reading this one would select columns that database has never had.",
    );
  }

  #requireMirror(): WeftClientMirror {
    const mirror = this.#mirror;
    if (mirror === undefined) throw new Error("this database was not opened");
    return mirror;
  }

  #report(error: unknown): void {
    const report = this.#options.onError ?? defaultOnError;
    report(error instanceof Error ? error : new Error(String(error)));
  }
}

function defaultOnError(error: Error): void {
  console.error("weftdb: this tab could not reconnect to the storage worker", error);
}

function defaultDeviceStorage(): StorageLike {
  const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
  if (storage === undefined) {
    throw new WeftOpenError(
      "no-device-storage",
      "this environment has no localStorage to keep a device id in; pass `deviceStorage`.",
    );
  }
  return storage;
}

/**
 * This origin's storage worker, as a port.
 *
 * A `SharedWorker` is identified by its script URL, which is the whole reason one worker can serve
 * every tab. Two tabs constructing one from the same URL get the same instance, and a tab whose
 * worker the browser stopped gets it started again by constructing one more.
 */
function defaultConnect(url: URL | string): WorkerLike {
  const constructor = (
    globalThis as {
      SharedWorker?: new (url: URL | string, options?: { type: "module" }) => { readonly port: WorkerLike };
    }
  ).SharedWorker;
  if (constructor === undefined) {
    throw new WeftOpenError(
      "no-worker",
      "this environment has no SharedWorker constructor. weftdb keeps its database in one, so that " +
        "every tab of an origin reads and writes through a single client and a single outbox. Pass " +
        "`connect` to supply a port of your own.",
    );
  }
  return new constructor(url, { type: "module" }).port;
}
