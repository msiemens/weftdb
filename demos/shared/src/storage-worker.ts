// The storage worker every demo ships, minus the one thing that differs between them: the schema.
//
// A demo's own worker module is two lines — its schema, its SQLite build — because everything
// interesting here is the same for all three. What that is: this worker's relay is not at a URL.
// It is a `WeftServer` in a second `SharedWorker` of the same browser (`relay-worker.ts`), reachable
// only over a `MessagePort`, and the page is the only side that can construct a `SharedWorker` and
// get one. So the port is transferred in from the page over its own connection to this worker, and
// turned into the transport the sync session runs over.
//
// One line per database. Each tab of a demo opens under a namespace of its own (`open.ts`), so this
// one `SharedWorker` holds several clients, each of them a device with a port of its own to the
// relay and a switch of its own on it. The relay factories are told which database they are being
// built for, which is what a line is found by.
//
// Three messages arriving on each connecting port are read here. Two are the demo's own and are
// tagged so that `WeftStorageWorker`'s listener drops them: the relay port, before anything else on
// that port, and the online switch whenever somebody clicks it. The third is the library's own
// `hydrate`, which is where the port says which database it is for — the demo messages arrive
// before it, so what they carry is held until there is a line to put it on. The switch is here
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

/** The page's online switch. Cuts and restores the four calls this tab's session makes. */
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
  /** Serves one arriving port, and reads the demo's two messages and the routing off it. */
  connect(port: WorkerHostPortLike): void;
  /** Every database this worker has open, by key. For a test to read. */
  readonly serving: readonly string[];
  stop(): Promise<void>;
}

/**
 * Serves every database this demo's origin opens, each over the relay port its own tab handed in.
 *
 * A line exists before its port does, and reports itself unreachable until one arrives, so a
 * session started by a tab that signed in before the relay was transferred is a device that is
 * offline for a moment rather than one with no session at all.
 */
export function serveDemoStorageWorker(options: DemoStorageWorkerOptions): DemoStorageWorker {
  const lines = new Map<string, DemoRelayLine>();
  const lineFor = (namespace: string): DemoRelayLine => {
    const existing = lines.get(namespace);
    if (existing !== undefined) return existing;
    const line = new DemoRelayLine();
    lines.set(namespace, line);
    return line;
  };
  const worker: WeftStorageWorker = serveWeftStorageWorker({
    schema: options.schema,
    sqlite: options.sqlite,
    relay: {
      transport: (_token, database) => lineFor(database.namespace),
      openSocket: (handlers: SocketHandlers, _token, database) =>
        lineFor(database.namespace).listen(database.scopeId, handlers.onWake),
      pollWhileBlindMs: options.pollWhileBlindMs ?? 1_000,
    },
  });
  return {
    get serving() {
      return worker.serving;
    },
    connect: (port) => {
      const tab = new DemoConnection(lineFor);
      // Attached before the library's, so this listener sees the demo's own messages and the
      // routing on a port the library is about to take over reading.
      port.addEventListener("message", (event: MessageEvent<unknown>) => {
        tab.read(event.data);
      });
      worker.connect(port);
    },
    stop: () => worker.stop(),
  };
}

/**
 * One tab's connection, from the port arriving to the database it turns out to be for.
 *
 * The relay port and the switch reach this worker before the `hydrate` that names the database, so
 * both are held until there is a line to put them on. Every connection carries a port of its own,
 * because a worker the browser restarted holds none of the ports the tabs it lost handed in.
 */
class DemoConnection {
  readonly #lineFor: (namespace: string) => DemoRelayLine;
  #line: DemoRelayLine | undefined;
  #relay: RelayPortLike | undefined;
  #online = true;

  constructor(lineFor: (namespace: string) => DemoRelayLine) {
    this.#lineFor = lineFor;
  }

  read(message: unknown): void {
    if (isRelayMessage(message)) {
      this.#relay = message.port;
      this.#line?.adopt(message.port);
    } else if (isOnlineMessage(message)) {
      this.#online = message.online;
      this.#line?.setOnline(message.online);
    } else if (isHydrateRequest(message)) {
      const line = this.#lineFor(message.namespace);
      this.#line = line;
      line.adopt(this.#relay);
      line.setOnline(this.#online);
    }
  }
}

/**
 * The line one device syncs over, with that device's switch on it.
 *
 * One `RelayPortTransport` per port, wrapped rather than rebuilt per session: two transports over
 * one port would number their calls from one apiece and each would settle the other's replies. A
 * session's teardown closes the socket it was handed, which puts down that session's wake handler
 * and leaves the port open for the next one.
 *
 * `connected` is what a session reads to decide whether it has a live connection, so the switch
 * turns it off: an offline device polls, fails, and shows its work as unsent.
 */
class DemoRelayLine implements AsyncSyncTransport {
  online = true;
  #relay: RelayPortTransport | undefined;
  /** scope -> the session watching it. The relay tells every port about every scope it serves. */
  readonly #wake = new Map<string, () => void>();

  get connected(): boolean {
    return this.online && this.#relay !== undefined && this.#relay.connected;
  }

  /**
   * Takes a port to the relay, and lets go of the one it was holding.
   *
   * The newest is the one known to be live. A port whose relay the browser stopped stays open at
   * this end and answers nothing, and `RelayPortTransport.connected` cannot see that — so a tab
   * that has just built a fresh connection is the only evidence there is.
   */
  adopt(port: RelayPortLike | undefined): void {
    if (port === undefined) return;
    this.#relay?.close();
    this.#relay = new RelayPortTransport({
      port,
      onWake: (advanced) => {
        // Dropped while the line is cut, because acting on it would be a sync that cannot happen —
        // and this device is meant to hear nothing at all while it is offline.
        if (this.online) this.#wake.get(advanced.scopeId)?.();
      },
    });
  }

  setOnline(online: boolean): void {
    this.online = online;
  }

  /** Points the line at a session's wake handler and hands it back as that session's socket. */
  listen(scopeId: string, onWake: () => void): SocketTransport {
    this.#wake.set(scopeId, onWake);
    return new DemoRelaySocket(this, scopeId);
  }

  /** Ends one session's use of the line. The port itself outlives every session on it. */
  release(scopeId: string): void {
    this.#wake.delete(scopeId);
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

  async #reachable<T>(call: (relay: RelayPortTransport) => Promise<T>): Promise<T> {
    if (!this.online) throw new Error("this device is offline, so the relay was not reached");
    const relay = this.#relay;
    if (relay === undefined) throw new Error("this device has no line to the relay yet");
    return call(relay);
  }
}

/**
 * One session's socket onto its device's line.
 *
 * A `SocketTransport`, because the relay says when a scope has moved and a session that hears it
 * syncs there and then. The four calls are the line's, and closing puts down this session's wake
 * handler alone: a line outlives the sessions on it, and a namespace with two scopes open has two
 * of them.
 */
class DemoRelaySocket implements SocketTransport {
  readonly #line: DemoRelayLine;
  readonly #scopeId: string;

  constructor(line: DemoRelayLine, scopeId: string) {
    this.#line = line;
    this.#scopeId = scopeId;
  }

  get connected(): boolean {
    return this.#line.connected;
  }

  async handshake(request: HandshakeRequest): Promise<HandshakeResponse> {
    return this.#line.handshake(request);
  }

  async push(scopeId: ScopeId, ops: WeftOp[]): Promise<PushOutcome> {
    return this.#line.push(scopeId, ops);
  }

  async pull(scopeId: ScopeId, lastServerSeq: number): Promise<PullBatch> {
    return this.#line.pull(scopeId, lastServerSeq);
  }

  async snapshot(scopeId: ScopeId): Promise<Snapshot> {
    return this.#line.snapshot(scopeId);
  }

  close(): void {
    this.#line.release(this.#scopeId);
  }
}

function isRelayMessage(value: unknown): value is DemoRelayMessage {
  return tagged(value) === DEMO_RELAY_MESSAGE;
}

function isOnlineMessage(value: unknown): value is DemoOnlineMessage {
  return tagged(value) === DEMO_ONLINE_MESSAGE && typeof (value as DemoOnlineMessage).online === "boolean";
}

/** The routing the library reads off this same port: which database the tab that owns it wants. */
function isHydrateRequest(value: unknown): value is { readonly namespace: string } {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { readonly type?: unknown; readonly namespace?: unknown };
  return message.type === "hydrate" && typeof message.namespace === "string";
}

/** The `weft` tag, since the worker protocol's own traffic arrives on this same port. */
function tagged(value: unknown): unknown {
  return typeof value === "object" && value !== null ? (value as { readonly weft?: unknown }).weft : undefined;
}
