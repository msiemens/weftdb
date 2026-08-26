// The storage worker every demo ships, minus the one thing that differs between them: the schema.
//
// A demo's own worker module is two lines — its schema, its SQLite build — because everything
// interesting here is the same for all three. What that is: this worker's relay is not at a URL.
// It is a `WeftServer` in a `SharedWorker` of the same browser (`relay-worker.ts`), reachable only
// over a `MessagePort`, and the page is the only side that can construct a `SharedWorker` and get
// one. So the port is handed in from the page, transferred into this worker in the same breath as
// the worker is constructed, and turned into the transport `serveWeftWorkerDefaults` runs its
// session over.
//
// Two messages arrive here that are not part of the worker protocol, and both are tagged so that
// `serveWeftWorker`'s own listener on this same global drops them: the relay port, once, before
// anything else; and the demo's online switch, whenever somebody clicks it. The switch is here
// rather than on the page because the session is here — cutting the line where the calls are made
// is what makes an offline tab an offline *device*, with its work piling up in the outbox exactly
// as it would with the network gone.
import type { ScopeId, WeftOp } from "weftdb/core";
import type { SchemaDefinition } from "weftdb/schema";
import type { HandshakeRequest, HandshakeResponse, PullBatch, PushOutcome, Snapshot } from "weftdb/server";
import type { AsyncSyncTransport, SocketHandlers, SocketTransport, WorkerHostPortLike } from "weftdb/client";
import type { Sqlite3Module } from "weftdb/client/wasm-sqlite";
import { serveWeftWorkerDefaults } from "weftdb/client/worker-entry";
import { RelayPortTransport, type RelayPortLike } from "./port-transport.ts";

/**
 * The page handing this worker its line to the relay. Sent exactly once, immediately after the
 * worker is constructed and before anything else is said to it, so this module can wait for it
 * rather than guess how long to listen. A `port` of `undefined` is a browser with no `SharedWorker`
 * to run a relay in: the database is served all the same, with no session at all.
 */
export const DEMO_RELAY_MESSAGE = "weft-demo-relay";

/** The page's online switch. Cuts and restores the four calls this worker's session makes. */
export const DEMO_ONLINE_MESSAGE = "weft-demo-online";

export interface DemoRelayMessage {
  readonly weft: typeof DEMO_RELAY_MESSAGE;
  readonly port: RelayPortLike | undefined;
}

export interface DemoOnlineMessage {
  readonly weft: typeof DEMO_ONLINE_MESSAGE;
  readonly online: boolean;
}

/** The worker's own global, as much of it as this module uses. */
export interface DemoWorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

export interface DemoStorageWorkerOptions {
  readonly schema: SchemaDefinition;
  /** The `@sqlite.org/sqlite-wasm` default export, uncalled. */
  readonly sqlite3InitModule: () => Promise<Sqlite3Module>;
  /**
   * The global to listen on for the two messages above, and the port to serve the worker protocol
   * on. Both default to the worker's own global, which is what a real worker wants and what makes
   * them one thing; a test drives the shipped module over a `MessageChannel` by passing the far end
   * as each.
   */
  readonly scope?: DemoWorkerScope;
  readonly port?: WorkerHostPortLike;
  /** How long a blind device waits between polls. Short, because a relay in this browser is near. */
  readonly pollWhileBlindMs?: number;
}

/**
 * Waits for the page's relay port, then opens this device's database and serves it.
 *
 * The listener is attached before the first `await`, which is what makes the wait raceless: a
 * dedicated worker queues what the page posted while its module was still evaluating, and delivers
 * it only once evaluation has finished.
 */
export async function serveDemoStorageWorker(options: DemoStorageWorkerOptions): Promise<void> {
  const scope: DemoWorkerScope = options.scope ?? (globalThis as Partial<DemoWorkerScope> as DemoWorkerScope);
  // The switch, and the line it is on once there is one. Kept as a value rather than acted on
  // straight away, so a toggle that arrives before the port does — or before the module has
  // finished opening a database — is still the state the line comes up in. It also outlives every
  // session the worker builds: a token change rebuilds the session around the same line, and a page
  // that had gone offline must not come back online by signing in again.
  const state: { online: boolean; line: DemoRelayLine | undefined } = { online: true, line: undefined };
  let arrived: (port: RelayPortLike | undefined) => void = () => undefined;
  const arrival = new Promise<RelayPortLike | undefined>((resolve) => {
    arrived = resolve;
  });

  scope.addEventListener("message", (event) => {
    const message: unknown = event.data;
    if (isRelayMessage(message)) arrived(message.port);
    else if (isOnlineMessage(message)) {
      state.online = message.online;
      state.line?.setOnline(message.online);
    }
  });

  const port = await arrival;
  const served = {
    schema: options.schema,
    sqlite3InitModule: options.sqlite3InitModule,
    ...(options.port === undefined ? {} : { port: options.port }),
  };
  if (port === undefined) {
    // No relay in this browser, and therefore no session. Everything else works: the database
    // opens, statements answer, and writes queue in the outbox for a device that never syncs.
    await serveWeftWorkerDefaults(served);
    return;
  }

  const opened = new DemoRelayLine(port);
  opened.setOnline(state.online);
  state.line = opened;
  await serveWeftWorkerDefaults({
    ...served,
    relay: {
      transport: () => opened,
      openSocket: (handlers: SocketHandlers) => opened.listen(handlers.onWake),
      pollWhileBlindMs: options.pollWhileBlindMs ?? 1_000,
    },
  });
}

/**
 * The line to the relay, with a switch on it.
 *
 * One `RelayPortTransport` for the life of the worker, wrapped rather than rebuilt per session:
 * two transports over one port would number their calls from one apiece and each would settle the
 * other's replies. So `close()` — which a session's teardown calls — puts down the wake handler and
 * leaves the port open, and the next session picks it up again.
 *
 * A `SocketTransport` rather than a plain `AsyncSyncTransport`, because the relay says when a scope
 * has moved and that is what a session needs to hear to sync on being told rather than on a timer.
 * `connected` is what a session reads to decide whether it has a live connection, so the switch
 * turns it off: an offline device polls, fails, and shows its work as unsent.
 */
class DemoRelayLine implements SocketTransport, AsyncSyncTransport {
  online = true;
  readonly #relay: RelayPortTransport;
  #wake: (() => void) | undefined;

  constructor(port: RelayPortLike) {
    this.#relay = new RelayPortTransport({
      port,
      onWake: () => {
        // Dropped while the line is cut, because acting on it would be a sync that cannot happen —
        // and this device is meant to hear nothing at all while it is offline.
        if (this.online) this.#wake?.();
      },
    });
  }

  get connected(): boolean {
    return this.online && this.#relay.connected;
  }

  setOnline(online: boolean): void {
    this.online = online;
  }

  /** Points the line at a session's wake handler and hands it back as that session's socket. */
  listen(onWake: () => void): SocketTransport {
    this.#wake = onWake;
    return this;
  }

  async handshake(request: HandshakeRequest): Promise<HandshakeResponse> {
    return this.#reachable(async () => this.#relay.handshake(request));
  }

  async push(scopeId: ScopeId, ops: WeftOp[]): Promise<PushOutcome> {
    return this.#reachable(async () => this.#relay.push(scopeId, ops));
  }

  async pull(scopeId: ScopeId, lastServerSeq: number): Promise<PullBatch> {
    return this.#reachable(async () => this.#relay.pull(scopeId, lastServerSeq));
  }

  async snapshot(scopeId: ScopeId): Promise<Snapshot> {
    return this.#reachable(async () => this.#relay.snapshot(scopeId));
  }

  /** Ends this session's use of the line. The port itself outlives every session on it. */
  close(): void {
    this.#wake = undefined;
  }

  async #reachable<T>(call: () => Promise<T>): Promise<T> {
    if (!this.online) throw new Error("this device is offline, so the relay was not reached");
    return call();
  }
}

function isRelayMessage(value: unknown): value is DemoRelayMessage {
  return tagged(value) === DEMO_RELAY_MESSAGE;
}

function isOnlineMessage(value: unknown): value is DemoOnlineMessage {
  return tagged(value) === DEMO_ONLINE_MESSAGE && typeof (value as DemoOnlineMessage).online === "boolean";
}

/** The `weft` tag, since the worker protocol's own traffic arrives on this same global. */
function tagged(value: unknown): unknown {
  return typeof value === "object" && value !== null ? (value as { readonly weft?: unknown }).weft : undefined;
}
