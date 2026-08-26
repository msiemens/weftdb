// The storage worker every demo ships, minus the one thing that differs between them: the schema.
//
// A demo's own worker module is two lines — its schema, its SQLite build — because everything
// interesting here is the same for all three. What that is: this worker's relay is not at a URL.
// It is a `WeftServer` in a second `SharedWorker` of the same browser (`relay-worker.ts`), reachable
// only over a `MessagePort`, and the page is the only side that can construct a `SharedWorker` and
// get one. So the port is transferred in from the page over its own connection to this worker, and
// turned into the transport the sync session runs over.
//
// Two messages arrive on each connecting port that are not part of the worker protocol, and both are
// tagged so that `WeftStorageWorker`'s own listener drops them: the relay port, from whichever tab
// connects first; and the demo's online switch, whenever somebody clicks it. The switch is here
// rather than on the page because the session is here — cutting the line where the calls are made is
// what makes an offline tab an offline *device*, with its work piling up in the outbox exactly as it
// would with the network gone.
import type { ScopeId, WeftOp } from "weftdb/core";
import type { SchemaDefinition } from "weftdb/schema";
import type { HandshakeRequest, HandshakeResponse, PullBatch, PushOutcome, Snapshot } from "weftdb/server";
import type { AsyncSyncTransport, SocketHandlers, SocketTransport, WorkerHostPortLike } from "weftdb/client";
import type { WaSqliteBuild } from "weftdb/client/wasm-sqlite";
import { serveWeftStorageWorker, type WeftStorageWorker } from "weftdb/client/worker-entry";
import { RelayPortTransport, type RelayPortLike } from "./port-transport.ts";

/**
 * A tab handing this worker its line to the relay. Sent on the tab's own connection port, before
 * anything else on it. A `port` of `undefined` is a browser with no `SharedWorker` to run a relay
 * in: the database is served all the same, with no session at all.
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

export interface DemoStorageWorkerOptions {
  readonly schema: SchemaDefinition;
  /** This demo's wa-sqlite build, uninitialised. */
  readonly sqlite: () => Promise<WaSqliteBuild>;
  /** How long a blind device waits between polls. Short, because a relay in this browser is near. */
  readonly pollWhileBlindMs?: number;
}

/** A demo's storage worker: the library's, plus the line to the relay and the switch on it. */
export interface DemoStorageWorker {
  /** Serves one arriving port, and reads the two demo messages off it. */
  connect(port: WorkerHostPortLike): void;
  /** Every database this worker has open, by key. For a test to read. */
  readonly serving: readonly string[];
  stop(): Promise<void>;
}

/**
 * Serves every database this demo's origin opens, over a relay handed in on the first port.
 *
 * The line exists before the port does, and reports itself unreachable until one arrives, so a
 * session started by a tab that signed in before the relay was transferred is a device that is
 * offline for a moment rather than one with no session at all.
 */
export function serveDemoStorageWorker(options: DemoStorageWorkerOptions): DemoStorageWorker {
  const line = new DemoRelayLine();
  const worker: WeftStorageWorker = serveWeftStorageWorker({
    schema: options.schema,
    sqlite: options.sqlite,
    relay: {
      transport: () => line,
      openSocket: (handlers: SocketHandlers) => line.listen(handlers.onWake),
      pollWhileBlindMs: options.pollWhileBlindMs ?? 1_000,
    },
  });
  return {
    get serving() {
      return worker.serving;
    },
    connect: (port) => {
      // Attached before the library's, so this listener sees the demo's own messages on a port the
      // library is about to take over reading.
      port.addEventListener("message", (event: MessageEvent<unknown>) => {
        const message: unknown = event.data;
        if (isRelayMessage(message)) line.adopt(message.port);
        else if (isOnlineMessage(message)) line.setOnline(message.online);
      });
      worker.connect(port);
    },
    stop: () => worker.stop(),
  };
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
  #relay: RelayPortTransport | undefined;
  #wake: (() => void) | undefined;

  get connected(): boolean {
    return this.online && this.#relay !== undefined && this.#relay.connected;
  }

  /** Takes the port the first connecting tab transferred in. Later tabs bring one this already has. */
  adopt(port: RelayPortLike | undefined): void {
    if (port === undefined || this.#relay !== undefined) return;
    this.#relay = new RelayPortTransport({
      port,
      onWake: () => {
        // Dropped while the line is cut, because acting on it would be a sync that cannot happen —
        // and this device is meant to hear nothing at all while it is offline.
        if (this.online) this.#wake?.();
      },
    });
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
    return this.#reachable(async (relay) => relay.handshake(request));
  }

  async push(scopeId: ScopeId, ops: WeftOp[]): Promise<PushOutcome> {
    return this.#reachable(async (relay) => relay.push(scopeId, ops));
  }

  async pull(scopeId: ScopeId, lastServerSeq: number): Promise<PullBatch> {
    return this.#reachable(async (relay) => relay.pull(scopeId, lastServerSeq));
  }

  async snapshot(scopeId: ScopeId): Promise<Snapshot> {
    return this.#reachable(async (relay) => relay.snapshot(scopeId));
  }

  /** Ends this session's use of the line. The port itself outlives every session on it. */
  close(): void {
    this.#wake = undefined;
  }

  async #reachable<T>(call: (relay: RelayPortTransport) => Promise<T>): Promise<T> {
    if (!this.online) throw new Error("this device is offline, so the relay was not reached");
    const relay = this.#relay;
    if (relay === undefined) throw new Error("this device has no line to the relay yet");
    return call(relay);
  }
}

function isRelayMessage(value: unknown): value is DemoRelayMessage {
  return tagged(value) === DEMO_RELAY_MESSAGE;
}

function isOnlineMessage(value: unknown): value is DemoOnlineMessage {
  return tagged(value) === DEMO_ONLINE_MESSAGE && typeof (value as DemoOnlineMessage).online === "boolean";
}

/** The `weft` tag, since the worker protocol's own traffic arrives on this same port. */
function tagged(value: unknown): unknown {
  return typeof value === "object" && value !== null ? (value as { readonly weft?: unknown }).weft : undefined;
}
