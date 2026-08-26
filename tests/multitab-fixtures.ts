// The one thing every multi-tab test needs and neither Node nor vitest provides: a port in the
// shape both halves of the worker protocol expect.
//
// A `node:worker_threads` port is a real port — messages cross a channel and are delivered on a
// later turn of the loop — so what a test built on this exercises is the shipped protocol with the
// process boundary taken out.
import { type MessagePort, type TransferListItem } from "node:worker_threads";

/**
 * A `node:worker_threads` port in the shape a `SharedWorker`'s port and a worker's own connection
 * are each expected to have.
 *
 * `postMessage` takes a transfer list, because a demo hands its relay over as one: a `MessagePort`
 * cannot be cloned, so it reaches the worker only by being moved into it.
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

  addEventListener(type: "message" | "close", listener: (event: MessageEvent<Incoming>) => void): void {
    const wrapped = (event: unknown): void => {
      listener(event as MessageEvent<Incoming>);
    };
    this.#wrapped.set(listener, wrapped);
    this.port.addEventListener(type, wrapped);
  }

  removeEventListener(type: "message" | "close", listener: (event: MessageEvent<Incoming>) => void): void {
    const wrapped = this.#wrapped.get(listener);
    if (wrapped === undefined) return;
    this.#wrapped.delete(listener);
    this.port.removeEventListener(type, wrapped);
  }

  start(): void {
    this.port.start();
  }

  close(): void {
    this.port.close();
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
