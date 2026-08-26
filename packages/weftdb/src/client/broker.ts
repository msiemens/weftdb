// How a tab that may not touch OPFS gets a `MessagePort` straight to the one worker that may.
//
// The obstacle is small and absolute: a `MessagePort` cannot be cloned, only transferred, and
// `BroadcastChannel.postMessage` takes no transfer list. So the tabs of an origin can say anything
// to each other except the one thing wanted here — "have this port" — and something that *can*
// carry a transferable between two documents has to stand between them.
//
// A `SharedWorker` is that something, and it is the only thing in a browser that is. Every tab of
// an origin connects to the same one, `postMessage` on a `SharedWorker` port does take a transfer
// list, and a port received on one connection can be sent on again down another. This module is
// that relay and nothing else: it touches no storage, holds no database, and understands not one
// word of the worker protocol whose ports it moves.
//
// That last part is why the restriction which rules a `SharedWorker` out as the *database* host
// does not rule it out here. Firefox refuses `createSyncAccessHandle()` inside a
// `SharedWorkerGlobalScope` — correctly; the specification confines it to dedicated workers — so the
// database cannot live in one (see `bench/browser/src/shared-worker-host.ts` for the measurement).
// Constructing a `SharedWorker` at all is a different question, and the same measurement answers it:
// Firefox 152 and Safari 26.6 both do it. A broker that stores nothing needs nothing that is
// refused.
//
// The shape is a provider and its consumers. The tab holding the worker registers as the provider
// for a database; every other tab makes a `MessageChannel`, keeps one end, and asks the broker to
// give the other end to whoever is providing. From then on that tab and the worker talk directly,
// and the tab that owns the worker is not on the path at all.
//
// Being a per-origin rendezvous with a live connection to every tab also makes this the right place
// for the one thing a Web Lock cannot say. A lock wakes the next waiter and tells nobody else, so
// when a successor takes over, the followers behind it in the queue hear nothing and go on holding
// ports into a document that has gone. A successor has to register here before it can serve anyone,
// so the broker tells every other connection that somebody new is providing. That is a reconnect
// notice and nothing more: leadership is still concluded from the lock alone, and there is no
// message in this file that means "you are the leader".
import { weftDatabaseKey } from "./database-key.ts";
import type { WorkerLike } from "./worker.ts";

/**
 * What crosses a `SharedWorker` connection, in both directions.
 *
 * `weft` tags every one of them because a `SharedWorker` is per origin rather than per library: an
 * application is free to connect to the same broker for its own purposes, and a message that is not
 * ours has to be recognisable as not ours rather than acted on.
 *
 * `database` is on every message because one broker serves every database the origin has open, and
 * a database is a namespace and a scope together (see `./database-key.ts`). A tab signed into two
 * scopes runs two workers, as do two applications sharing an origin, and a port meant for one of
 * them delivered to another is a tab reading a database it never asked for.
 */
export type BrokerMessage =
  /** A tab saying it holds this database's worker. The most recent claim is the one that stands. */
  | { readonly weft: "broker"; readonly type: "provide"; readonly database: string }
  /**
   * Told to every *other* connected tab when a `provide` lands: somebody new is holding this
   * database's worker.
   *
   * This is the succession announcement, and the whole of it. A Web Lock wakes the next waiter and
   * nobody else, so the tabs further back in the queue would otherwise go on talking to a port
   * whose worker died with the document that created it. The broker already knows — a successor
   * must register with it before it can serve anyone — and it already holds a connection to every
   * tab of the origin.
   *
   * What it cannot do is promote. It says that somebody else is providing, never that the receiver
   * is; a tab that hears one reconnects and re-hydrates, and only being granted the lock makes a tab
   * the leader. So a spurious one costs a reconnect, where a spurious grant would cost a second
   * worker on one access handle — and only the browser can issue a grant.
   */
  | { readonly weft: "broker"; readonly type: "provided"; readonly database: string }
  /** A provider standing down, on an orderly close. */
  | { readonly weft: "broker"; readonly type: "withdraw"; readonly database: string }
  /** A tab asking for its port to be given to the provider. `port` is transferred alongside. */
  | {
      readonly weft: "broker";
      readonly type: "request";
      readonly database: string;
      readonly id: number;
      readonly port: unknown;
    }
  /** A port arriving at the provider, to be forwarded into its worker. */
  | { readonly weft: "broker"; readonly type: "deliver"; readonly database: string; readonly port: unknown }
  /** Told to a requester the broker had nowhere to send the port. Named by request, so a tab that
   * asked twice can tell which attempt was refused. */
  | { readonly weft: "broker"; readonly type: "unavailable"; readonly database: string; readonly id: number };

/**
 * One end of a connection to the broker: a `SharedWorker`'s `port` on the page, and a port from
 * `onconnect` inside the broker.
 *
 * Deliberately not `MessagePort`: this package is typechecked without the DOM library, the same
 * shape has to describe the `node:worker_threads` port the tests use, and the only two things asked
 * of it are a `postMessage` that takes a transfer list and an `addEventListener` that does not.
 */
export interface BrokerPortLike {
  postMessage(message: BrokerMessage, transfer?: readonly unknown[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  start?(): void;
  close?(): void;
}

/**
 * The broker as it runs inside the `SharedWorker`.
 *
 * Split from the entry point that binds it to `onconnect` for one reason: `SharedWorker` does not
 * exist under Node, and a relay that could only be reached by constructing one would be a relay no
 * test ever ran. `connect` takes a port, so the tests connect ordinary `MessageChannel` ends to the
 * real thing and the code under test is the code that ships.
 */
export interface WeftPortBroker {
  /** Serves one connected document. Called once per `onconnect`. */
  connect(port: BrokerPortLike): void;
  /** The key of each database somebody is providing, for a test to read. */
  providers(): readonly string[];
  stop(): void;
}

/**
 * Starts a broker.
 *
 * There is no liveness in here, and that is on purpose. A provider that dies leaves its
 * registration standing, and the port a consumer asks for goes to a document that no longer exists —
 * which the consumer finds out by asking the worker something over it and being answered by nobody.
 * Consumers therefore probe rather than trust, and succession replaces the registration when the
 * new provider registers — which is also when every other tab is told to reconnect, since that is
 * the one moment the broker knows something the tabs do not. A broker that tried to notice death
 * instead would need a signal it does not have: a `SharedWorker` sees a connection close, but not
 * the difference between a tab that has gone and one the browser has frozen, and treating the
 * second as the first is how two documents come to hold one OPFS access handle. The Web Lock the
 * election runs on is the only thing that can tell them apart, and it already does.
 */
export function serveWeftPortBroker(): WeftPortBroker {
  /** database key -> the connection of the tab that last claimed to hold that database's worker. */
  const providers = new Map<string, BrokerPortLike>();
  const connections = new Map<BrokerPortLike, (event: MessageEvent<unknown>) => void>();
  let serving = true;

  const onMessage = (port: BrokerPortLike, event: MessageEvent<unknown>): void => {
    if (!serving) return;
    const message = event.data;
    if (!isBrokerMessage(message)) return;
    switch (message.type) {
      case "provide": {
        providers.set(message.database, port);
        // And every other tab is told, which is how a succession reaches the followers the Web Lock
        // will never wake. To every connection rather than to the ones known to care: the broker
        // keeps no register of who is watching which database, each client drops what is not its
        // own, and the alternative is a second registry to be wrong.
        //
        // Not back to the provider. A tab that heard its own claim would tear down the worker it
        // had just built. Nothing here promotes anybody either way — see the message's own note.
        for (const other of connections.keys()) {
          if (other !== port) other.postMessage({ weft: "broker", type: "provided", database: message.database });
        }
        return;
      }
      case "withdraw":
        // Only if this port is the one registered. A provider that stood down after being replaced
        // would otherwise deregister its successor, and every tab opened next would be told there
        // is nobody holding a worker that is running.
        if (providers.get(message.database) === port) providers.delete(message.database);
        return;
      case "request": {
        const provider = providers.get(message.database);
        if (provider === undefined || provider === port) {
          // `provider === port` is a tab asking itself for a port. It cannot happen through
          // `openWeftDatabase` — a tab that provides never requests — and answering it would hand a
          // tab a channel whose two ends it holds, which deadlocks quietly rather than loudly.
          port.postMessage({ weft: "broker", type: "unavailable", database: message.database, id: message.id });
          return;
        }
        // The whole point of this module, in one line: a port that arrived here transferred is sent
        // on transferred, and neither this thread nor the page that asked keeps a usable copy.
        provider.postMessage({ weft: "broker", type: "deliver", database: message.database, port: message.port }, [
          message.port,
        ]);
        return;
      }
      // The broker's own output, travelling back the way it came. Not addressed to the broker, and
      // dropped rather than relayed.
      case "deliver":
      case "provided":
      case "unavailable":
        return;
    }
  };

  return {
    connect: (port) => {
      if (!serving) return;
      const listener = (event: MessageEvent<unknown>): void => {
        onMessage(port, event);
      };
      connections.set(port, listener);
      port.addEventListener("message", listener);
      port.start?.();
    },
    providers: () => [...providers.keys()],
    stop: () => {
      serving = false;
      for (const [port, listener] of connections) port.removeEventListener("message", listener);
      connections.clear();
      providers.clear();
    },
  };
}

/** A `MessageChannel`, in the shape this module uses it. */
interface ChannelLike {
  readonly port1: BrokerPortLike;
  readonly port2: BrokerPortLike;
}

/**
 * A port this tab asked the broker to deliver, and the one way it can learn that it did not.
 *
 * `refused` settles only on a refusal. There is no "delivered" to wait for: the broker forwards the
 * port into another document and hears nothing back, so the only evidence that the far end is
 * really serving is the far end answering something — which is the caller's to ask, and is what
 * `openWeftDatabase` does with an `open` request against a deadline.
 */
export interface BrokeredPort {
  /** This tab's end. The other end was sent to whichever tab is providing the database. */
  readonly port: WorkerLike;
  /** Resolves if the broker had no provider to give the other end to. Otherwise never settles. */
  readonly refused: Promise<void>;
  /** Closes this end. For a request that went nowhere, and for one whose provider has since died. */
  discard(): void;
}

/**
 * The page's side of the broker: whichever half of the exchange this tab is playing.
 *
 * One object for both roles rather than two, because a tab plays both over its life. A follower
 * granted leadership stops requesting and starts providing without anything above it being rebuilt,
 * and the connection to the broker — which is per document, not per role — survives the change.
 */
export class WeftBrokerClient {
  readonly #port: BrokerPortLike;
  /** The `(namespace, scope)` pair this tab's traffic is about, as one key. */
  readonly #database: string;
  readonly #deliveries = new Set<(port: unknown) => void>();
  readonly #successions = new Set<() => void>();
  readonly #refusals = new Map<number, () => void>();
  #nextId = 1;
  #providing = false;
  #disposed = false;

  /**
   * `namespace` is which application in this origin the scope belongs to, `"weft"` by default. It
   * is composed with the scope here rather than left to the caller, because getting the two into
   * one key is the whole of what keeps two applications' workers apart — see `./database-key.ts`.
   */
  constructor(port: BrokerPortLike, scopeId: string, namespace?: string) {
    this.#port = port;
    this.#database = weftDatabaseKey(scopeId, namespace);
    this.#port.addEventListener("message", this.#onMessage);
    this.#port.start?.();
  }

  /**
   * Says this tab holds the database's worker, so ports asked for are sent here.
   *
   * Idempotent, and re-announcing costs nothing: the broker keeps the last claim per database,
   * which is what makes succession a matter of the new leader saying so rather than of the old one
   * being noticed to have stopped.
   *
   * It is also what tells the other tabs. The broker passes each claim on to every other connection
   * as a `provided`, which is how a follower nowhere near the front of the lock queue learns that
   * the worker it was talking to has gone. Call it *after* the worker is ready to serve, or a tab
   * that reconnects on hearing it arrives before there is anything to answer.
   */
  provide(): void {
    if (this.#disposed) return;
    this.#providing = true;
    this.#port.postMessage({ weft: "broker", type: "provide", database: this.#database });
  }

  /** Where a delivered port arrives. The leader forwards each into its worker. */
  onPort(handler: (port: unknown) => void): () => void {
    this.#deliveries.add(handler);
    return () => {
      this.#deliveries.delete(handler);
    };
  }

  /**
   * Where another tab taking over this database arrives: a successor called `provide`, so the
   * worker this tab was talking to is not the one serving the database any more.
   *
   * This is what a Web Lock cannot say. A lock wakes the next waiter and tells nobody else, so
   * every follower further back in the queue would otherwise hold a port into a document that has
   * gone — no error, no rejection, just a page whose lists stop moving. The broker has a connection
   * to each of them and hears the successor register, so it is the one thing in the origin that can
   * tell them all.
   *
   * It says nothing about *this* tab's role, and there is no message that could. A handler here
   * reconnects and re-hydrates; a tab becomes the leader only by being granted the lock.
   */
  onProvider(handler: () => void): () => void {
    this.#successions.add(handler);
    return () => {
      this.#successions.delete(handler);
    };
  }

  /**
   * Mints a channel, sends one end to whoever is providing, and hands back the other.
   *
   * Synchronous, because there is nothing to await: the broker either has a provider or it does
   * not, and if it does the port has left this document by the time this returns. What the caller
   * awaits is `refused` against its own probe of the port — see `BrokeredPort`.
   */
  requestPort(): BrokeredPort {
    const channel = newChannel();
    const id = this.#nextId;
    this.#nextId += 1;
    const refused = new Promise<void>((resolve) => {
      this.#refusals.set(id, resolve);
    });
    this.#port.postMessage({ weft: "broker", type: "request", database: this.#database, id, port: channel.port2 }, [
      channel.port2,
    ]);
    // Started here rather than left to whoever is handed it. A browser's `MessagePort` queues what
    // arrives and delivers none of it until `start`, and `addEventListener` does not start one — so
    // an unstarted port is a follower that asks the worker something and waits for ever, with the
    // worker having answered. Node's ports start themselves when a listener is attached, which is
    // why no test can see this: the worker host already starts the ports it is given, and this is
    // the same rule on the other side of the same channel.
    channel.port1.start?.();
    return {
      // Both faces of one `MessageChannel` end. It reaches the broker as a transferable and is read
      // by this tab as the worker protocol; nothing converts between the two.
      port: channel.port1 as unknown as WorkerLike,
      refused,
      discard: () => {
        this.#refusals.delete(id);
        channel.port1.close?.();
      },
    };
  }

  /** Stops providing and stops listening. The connection to the broker is closed with it. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#providing) this.#port.postMessage({ weft: "broker", type: "withdraw", database: this.#database });
    this.#providing = false;
    this.#port.removeEventListener("message", this.#onMessage);
    this.#deliveries.clear();
    this.#successions.clear();
    // Whatever was waiting on a refusal is settled rather than dropped: a caller awaiting one is
    // waiting for a port that is never going to arrive now.
    for (const resolve of [...this.#refusals.values()]) resolve();
    this.#refusals.clear();
    this.#port.close?.();
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (!isBrokerMessage(message) || message.database !== this.#database) return;
    if (message.type === "deliver") {
      for (const handler of [...this.#deliveries]) handler(message.port);
      return;
    }
    if (message.type === "provided") {
      // Only if this tab is not the one providing. The broker already spares a provider its own
      // claim; this covers the tab that has since become the provider itself, whose worker is the
      // one now serving the database and must not be torn down on the strength of a message.
      if (this.#providing) return;
      for (const handler of [...this.#successions]) handler();
      return;
    }
    if (message.type !== "unavailable") return;
    const resolve = this.#refusals.get(message.id);
    if (resolve === undefined) return;
    this.#refusals.delete(message.id);
    resolve();
  };
}

/**
 * The message every broker guard is built on. Structural, because it arrived over a connection an
 * application may be putting its own traffic on.
 */
export function isBrokerMessage(value: unknown): value is BrokerMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { readonly weft?: unknown; readonly type?: unknown; readonly database?: unknown };
  if (message.weft !== "broker" || typeof message.database !== "string") return false;
  return (
    message.type === "provide" ||
    message.type === "provided" ||
    message.type === "withdraw" ||
    message.type === "request" ||
    message.type === "deliver" ||
    message.type === "unavailable"
  );
}

/**
 * A `MessageChannel`, from wherever this is running.
 *
 * Read off the global rather than imported so that one line of source serves a browser and Node
 * alike, and refused loudly rather than worked around: without a channel there is no port to hand
 * over, and no way for a tab to reach a database another tab is holding.
 */
function newChannel(): ChannelLike {
  const constructor = (globalThis as { MessageChannel?: new () => ChannelLike }).MessageChannel;
  if (constructor === undefined) {
    throw new Error("this environment has no MessageChannel, so no tab can be given a port to the storage worker");
  }
  return new constructor();
}
