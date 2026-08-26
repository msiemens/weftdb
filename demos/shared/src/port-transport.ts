// The sync session over a `MessagePort`, so a demo on a static page has something to sync with.
//
// What this stands in for is a deployment, not a transport. The page still runs the real
// `WeftClient` and the real `WeftSession`, and at the far end of the port there is a real
// `WeftServer`: the same four calls, in the same order, with the same outcomes to reason about.
// Only the distance between them changes, from a network to a `postMessage` inside one browser.
// `httpTransport` and `connectSocketTransport` carry those same calls to a relay somewhere else,
// and either drops in wherever this is used — none of the three is a stand-in for the other two.
//
// A port has no framing of its own, so the correlation is this module's: every call is numbered,
// the reply carrying that number settles it, and anything else on the port is left alone. The
// numbers are per transport, which is per tab, so two tabs both have a call numbered 1 outstanding
// at once. That is harmless only because a reply is posted back down the port its call arrived on
// and is never broadcast — the same rule the worker host follows for the same reason.
//
// Two kinds of failure travel differently, and telling them apart is most of what this file is for.
// A relay that *threw* has no answer to give, so the caller's promise rejects. A push the relay
// *refused* is an answer: a `PushResult` carries the `Rejection` as a value, and the client's rebase
// and quarantine paths are built on receiving one. Rejecting the promise instead would report
// diverged work as a broken connection, and the edit would sit in the outbox rather than being
// surfaced to whoever has to decide about it.
//
// The relay also says, unasked, that a scope has moved. That is the whole of why a second tab
// updates without being touched: one tab pushes, the relay tells the others, and each of them runs
// the sync it would otherwise have run at its next poll. The notice carries the scope and the
// sequence and no records, so acting on it is an ordinary pull through the ordinary path.
import type { ScopeId, WeftOp } from "weftdb/core";
import type { HandshakeRequest, HandshakeResponse, PullBatch, PushOutcome, Snapshot } from "weftdb/server";
import { snapshotFromEnvelope, type SnapshotEnvelope } from "weftdb/server/snapshot";
import type { ScopeAdvanced, SocketTransport } from "weftdb/client";

/**
 * What each of the four calls carries. The scope is in every one of them because there is nothing
 * else here for it to come from: a deployed relay reads it off the token and this relay has no
 * tokens, so a tab names its own scope and device (see `relay-worker.ts`).
 */
export interface RelayCalls {
  readonly handshake: HandshakeRequest;
  readonly push: { readonly scopeId: ScopeId; readonly ops: readonly WeftOp[] };
  readonly pull: { readonly scopeId: ScopeId; readonly lastServerSeq: number };
  readonly snapshot: { readonly scopeId: ScopeId };
}

/**
 * What each answers with. `snapshot` answers with the envelope rather than the records: the digest
 * is checked on this side, so the content address is verified rather than taken on trust, exactly
 * as it is over HTTP and over the socket.
 */
export interface RelayResults {
  readonly handshake: HandshakeResponse;
  readonly push: PushOutcome;
  readonly pull: PullBatch;
  readonly snapshot: SnapshotEnvelope;
}

export type RelayCall = keyof RelayCalls;

/** One call, on the wire. Written as a union over the operations so the relay's switch narrows. */
export type RelayRequest = {
  [Op in RelayCall]: {
    readonly weft: "relay";
    readonly id: number;
    readonly op: Op;
    readonly argument: RelayCalls[Op];
  };
}[RelayCall];

/**
 * One answer, on the wire. `result` is `unknown` because the port carries every operation's answer
 * on one message type; which of them it is follows from the call the id belongs to, which is what
 * the transport tracked when it made it.
 */
export type RelayReply =
  | { readonly weft: "relay"; readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly weft: "relay"; readonly id: number; readonly ok: false; readonly error: string };

/** The relay saying a scope moved, to a tab that did not move it. */
export interface RelayAdvanced extends ScopeAdvanced {
  readonly weft: "relay";
}

export type RelayMessage = RelayRequest | RelayReply | RelayAdvanced;

/**
 * One end of a connection to the relay: a `SharedWorker`'s `port` on the page, and a port from
 * `onconnect` inside the worker.
 *
 * Structural rather than `MessagePort` so that the same source describes the `node:worker_threads`
 * port the tests drive it with. Nothing is ever transferred over this connection — the four calls
 * carry rows, not ports — so `postMessage` takes no transfer list.
 */
export interface RelayPortLike {
  postMessage(message: RelayMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  start?(): void;
  close?(): void;
}

export interface RelayPortTransportOptions {
  readonly port: RelayPortLike;
  /** Called when the relay says some scope moved. Every connected tab hears about every scope the
   * relay serves, so a caller with more than one open compares `scopeId` before syncing. */
  readonly onWake?: (advanced: ScopeAdvanced) => void;
}

/** A call that could not be carried out. Never a push the relay refused — that is a value. */
export class RelayPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayPortError";
  }
}

interface Pending {
  readonly op: RelayCall;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * The client's side of the port.
 *
 * A `SocketTransport` rather than a bare `AsyncSyncTransport`, and nothing in that interface is
 * about sockets: it is the four calls plus whether the far end is reachable and how to let it go.
 * Satisfying it is what lets a `WeftSession` take this as its live connection, so the relay's wake
 * drives the next sync and the fallback poll drops to its long interval. `connected` is true until
 * this transport is closed, because a relay running in the same browser is not something that can
 * be down: there is no connection between the two to fail, and a reply that never comes means the
 * worker holding the relay has gone, which takes every tab's data with it either way.
 */
export class RelayPortTransport implements SocketTransport {
  readonly #port: RelayPortLike;
  readonly #onWake: ((advanced: ScopeAdvanced) => void) | undefined;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;

  constructor(options: RelayPortTransportOptions) {
    this.#port = options.port;
    this.#onWake = options.onWake;
    this.#port.addEventListener("message", this.#onMessage);
    // A browser's `MessagePort` queues what arrives and delivers none of it until it is started,
    // and `addEventListener` does not start one — so a tab that skipped this would post a handshake
    // and wait for ever on an answer already sitting in its own queue. Node's ports start
    // themselves when a listener is attached, which is precisely why no test can see it missing.
    this.#port.start?.();
  }

  get connected(): boolean {
    return !this.#closed;
  }

  async handshake(request: HandshakeRequest): Promise<HandshakeResponse> {
    return this.#call("handshake", request);
  }

  async push(scopeId: ScopeId, ops: WeftOp[]): Promise<PushOutcome> {
    return this.#call("push", { scopeId, ops });
  }

  async pull(scopeId: ScopeId, lastServerSeq: number): Promise<PullBatch> {
    return this.#call("pull", { scopeId, lastServerSeq });
  }

  async snapshot(scopeId: ScopeId): Promise<Snapshot> {
    return snapshotFromEnvelope(await this.#call("snapshot", { scopeId }));
  }

  /** Stops listening and settles what was in flight, so nothing is left awaiting a dead port. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#port.removeEventListener("message", this.#onMessage);
    for (const pending of this.#pending.values()) {
      pending.reject(new RelayPortError(`the port to the relay closed before ${pending.op} was answered`));
    }
    this.#pending.clear();
    this.#port.close?.();
  }

  #call<Op extends RelayCall>(op: Op, argument: RelayCalls[Op]): Promise<RelayResults[Op]> {
    if (this.#closed)
      return Promise.reject(new RelayPortError(`the port to the relay is closed, so ${op} was not sent`));
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<RelayResults[Op]>((resolve, reject) => {
      this.#pending.set(id, { op, resolve: resolve as (value: unknown) => void, reject });
      // The cast is the union being rebuilt from a generic operation and its own argument type,
      // which the two are by construction; nothing about the value changes.
      this.#port.postMessage({ weft: "relay", id, op, argument } as RelayRequest);
    });
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (isRelayAdvanced(message)) {
      this.#onWake?.(message);
      return;
    }
    // Anything else on this port belongs to whoever else is using it. A `SharedWorker` connection
    // is per origin rather than per library, and reading a stranger's message as an answer would
    // settle whichever call happened to be numbered like it.
    if (!isRelayReply(message)) return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new RelayPortError(`the relay could not ${pending.op}: ${message.error}`));
  };
}

export function isRelayRequest(value: unknown): value is RelayRequest {
  if (!isRelayMessage(value)) return false;
  const message = value as { readonly id?: unknown; readonly op?: unknown };
  if (typeof message.id !== "number") return false;
  return message.op === "handshake" || message.op === "push" || message.op === "pull" || message.op === "snapshot";
}

export function isRelayReply(value: unknown): value is RelayReply {
  if (!isRelayMessage(value)) return false;
  const message = value as { readonly id?: unknown; readonly ok?: unknown };
  return typeof message.id === "number" && typeof message.ok === "boolean";
}

export function isRelayAdvanced(value: unknown): value is RelayAdvanced {
  if (!isRelayMessage(value)) return false;
  const message = value as { readonly type?: unknown; readonly serverSeq?: unknown; readonly scopeId?: unknown };
  return message.type === "advanced" && typeof message.scopeId === "string" && typeof message.serverSeq === "number";
}

/** The `weft` tag every guard above starts from, since these ports carry other traffic. */
function isRelayMessage(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { readonly weft?: unknown }).weft === "relay";
}
