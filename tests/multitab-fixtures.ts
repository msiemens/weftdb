// The two things every multi-tab test needs and neither Node nor vitest provides: a port in the
// shape both halves of the worker protocol expect, and a `SharedWorker` to broker ports between
// documents that are all really one process.
//
// The broker fake is the interesting one, and it is deliberately not a fake of the broker. Node has
// no `SharedWorker` at all, so a relay reachable only by constructing one would be a relay no test
// could run — and the relay is the piece of this design that is new. What stands in is the process
// boundary alone: `serveWeftPortBroker` runs here, in this process, and every "tab" connects to it
// over a `MessageChannel` exactly as a page connects over a `SharedWorker`'s port. The code under
// test is therefore the code that ships, and a `MessagePort` really is transferred from one end to
// the other rather than passed by reference.
import { MessageChannel, type MessagePort, type TransferListItem } from "node:worker_threads";
import {
  serveWeftPortBroker,
  type BrokerPortLike,
  type LockManagerLike,
  type LockRequestOptionsLike,
  type WeftPortBroker,
} from "weftdb/client";

/**
 * A `node:worker_threads` port in the shape a `Worker`, a worker's own global, and a broker
 * connection are each expected to have.
 *
 * `postMessage` takes a transfer list, because that is the whole mechanism: a `MessagePort` cannot
 * be cloned, so a tab's connection reaches the worker only by being moved into it.
 */
export class PortEndpoint<Incoming = unknown> {
  readonly port: MessagePort;
  readonly #wrapped = new Map<unknown, (event: unknown) => void>();

  constructor(port: MessagePort) {
    this.port = port;
    // A port reached through `addEventListener` rather than through its EventEmitter face does not
    // begin delivering on its own.
    this.port.start();
  }

  postMessage(message: unknown, transfer?: readonly unknown[]): void {
    this.port.postMessage(message, transfer as readonly TransferListItem[] | undefined);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<Incoming>) => void): void {
    const wrapped = (event: unknown): void => {
      listener(event as MessageEvent<Incoming>);
    };
    this.#wrapped.set(listener, wrapped);
    this.port.addEventListener("message", wrapped);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent<Incoming>) => void): void {
    const wrapped = this.#wrapped.get(listener);
    if (wrapped === undefined) return;
    this.#wrapped.delete(listener);
    this.port.removeEventListener("message", wrapped);
  }

  start(): void {
    this.port.start();
  }
}

/**
 * One origin's `SharedWorker`, as far as anything above it can tell: every tab connects to the same
 * broker, and the broker is the shipped one.
 *
 * `connect` is what a test passes as `openWeftDatabase`'s `createBroker`. Each call is one more
 * document connecting, which is what `onconnect` is in a browser.
 */
export class BrokerHub {
  readonly broker: WeftPortBroker = serveWeftPortBroker();
  readonly #ports: MessagePort[] = [];

  /** This document's end of a connection to the one broker. */
  connect(): BrokerPortLike {
    const channel = new MessageChannel();
    this.#ports.push(channel.port1, channel.port2);
    // A `node:worker_threads` port already has every method `BrokerPortLike` asks for, including a
    // `postMessage` that takes a transfer list; the cast is about the two type declarations, not
    // about the runtime.
    this.broker.connect(channel.port2 as unknown as BrokerPortLike);
    return channel.port1 as unknown as BrokerPortLike;
  }

  close(): void {
    this.broker.stop();
    // An open port keeps Node's event loop alive, so a failing run that skipped these would hang
    // the whole file rather than report a failure.
    for (const port of this.#ports) port.close();
    this.#ports.length = 0;
  }
}

/**
 * A `MessagePort` and a `BroadcastChannel` both deliver on a later turn of the loop, and a mirror's
 * mutators return before anything has crossed either — so a test waits on the condition rather than
 * on a guessed number of ticks.
 */
export async function settle(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("the tabs never reached the expected state");
    await delay(1);
  }
  // Two more turns, so a delta that arrives with the condition has finished crossing to the tab
  // that did not cause it before the assertions read either map.
  await delay(1);
  await delay(1);
}

export async function waitFor(condition: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(1);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How a promise settled, as a value, so a test can race it against a deadline without hanging. */
export function outcome(promise: Promise<unknown>): Promise<"resolved" | "rejected"> {
  return promise.then(
    () => "resolved" as const,
    () => "rejected" as const,
  );
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${Math.trunc(performance.now() * 1000)}-${Math.trunc(Math.random() * 1e6)}`;
}

/**
 * Web Locks as this feature depends on them, which is more than an `ifAvailable`-only fake models:
 * one holder at a time, a *queue* of blocking waiters served in order, a release that hands the
 * lock straight to whoever is next, and a way to take the lock off a holder that never gave it back.
 *
 * That last part is the whole point. A tab that crashes runs no code — its coordinator never
 * releases anything — and the browser hands the lock on regardless. `kill` is that, and it is the
 * only way to arrange the case every migration test is about.
 */
export class QueuedLocks implements LockManagerLike {
  /** Per name, the way to take the lock off whoever holds it. Presence is "held". */
  readonly #holders = new Map<string, () => void>();
  readonly #waiters = new Map<string, Waiter[]>();
  /** Every name a *blocking* request queued behind, so a test can prove one was actually made. */
  readonly queued: string[] = [];

  async request<T>(
    name: string,
    options: LockRequestOptionsLike,
    callback: (lock: object | null) => T | Promise<T>,
  ): Promise<T> {
    if (options.ifAvailable === true) {
      if (this.#holders.has(name)) return callback(null);
      return this.#grant(name, callback);
    }
    if (!this.#holders.has(name)) return this.#grant(name, callback);
    this.queued.push(name);
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          resolve(this.#grant(name, callback));
        },
      };
      const line = this.#waiters.get(name) ?? [];
      line.push(waiter);
      this.#waiters.set(name, line);
      options.signal?.addEventListener("abort", () => {
        const current = this.#waiters.get(name) ?? [];
        const index = current.indexOf(waiter);
        // Only while still waiting: a signal that fires after the grant changes nothing, exactly
        // as the Web Locks spec has it.
        if (index === -1) return;
        current.splice(index, 1);
        reject(new Error("the lock request was aborted"));
      });
    });
  }

  /** Takes a lock nobody hands back, so a test can make the next tab a follower of nothing. */
  hold(name: string): void {
    this.#holders.set(name, () => {
      this.#holders.delete(name);
    });
  }

  /** Takes the lock off its holder without the holder's cooperation. A tab that crashed. */
  kill(name: string): void {
    this.#holders.get(name)?.();
  }

  async #grant<T>(name: string, callback: (lock: object | null) => T | Promise<T>): Promise<T> {
    let kill = (): void => {};
    const killed = new Promise<T>((_resolve, reject) => {
      kill = () => {
        reject(new Error("the tab holding the lock went away"));
      };
    });
    this.#holders.set(name, kill);
    try {
      // The lock is held for exactly as long as the callback's promise is pending — or until the
      // browser takes it back, whichever happens first.
      return await Promise.race([callback({}), killed]);
    } finally {
      if (this.#holders.get(name) === kill) this.#holders.delete(name);
      this.#drain(name);
    }
  }

  #drain(name: string): void {
    if (this.#holders.has(name)) return;
    const next = this.#waiters.get(name)?.shift();
    // `#grant` marks the lock held before it awaits anything, so the tab behind this one sees a
    // held lock rather than a free one.
    next?.grant();
  }
}

interface Waiter {
  readonly grant: () => void;
}
