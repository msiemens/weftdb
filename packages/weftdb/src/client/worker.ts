import type { WireValue } from "weftdb/core";
import type { CompiledQuery } from "./query.ts";
import type { SessionStatus } from "./session.ts";

/**
 * A change the page asks the worker to carry out. Only the intent crosses, never the result: the
 * `WeftClient` lives in the worker, beside the database it writes itself through to, so the page
 * has nothing to apply the mutation to. What comes back is the rows that moved, as a `WorkerPush`.
 *
 * `delete` and `restore` carry no values. A delete has none to carry, and a restore un-deletes a
 * row the scope still holds, so its fields come back on the next pull rather than being guessed
 * at here.
 */
export type WorkerMutation =
  | {
      readonly kind: "create" | "append" | "update";
      readonly tableName: string;
      readonly rowId: string;
      readonly txnId: string;
      readonly values: Readonly<Record<string, WireValue>>;
    }
  | { readonly kind: "delete" | "restore"; readonly tableName: string; readonly rowId: string; readonly txnId: string };

/**
 * What a page can ask for, without the correlation id. `execute` and `close` drive the database
 * alone; the rest drive the client the worker host owns.
 */
export type WorkerRequestBody =
  | { readonly type: "execute"; readonly query: CompiledQuery }
  | { readonly type: "close" }
  /**
   * This port is going away, and whatever it registered goes with it.
   *
   * It exists because a `MessagePort` has no liveness signal the host can rely on: the `close`
   * event is young enough that not every browser weftdb runs in fires it, and a tab that is killed
   * fires nothing anywhere. So an orderly exit says so, and the host releases that port's watches
   * rather than recomputing statements for a tab that has gone.
   *
   * A `SharedWorker` outlives every tab of its origin, so a registration nobody released is a
   * statement recomputed after every mutation for the rest of the browser's life. This is what
   * stops that, and `WeftWorkerHost.watching` is what makes the leak visible when it does not.
   *
   * Distinct from `close`, which closes the *database*. One tab leaving must not take the database
   * away from the tabs that are staying.
   */
  | { readonly type: "disconnect" }
  /**
   * Every row of a scope. The first thing any tab sends, and the message that says which database
   * this port is for: a `SharedWorker` is identified by its script URL alone, so one instance
   * serves every tab of the origin and a port arrives carrying no statement of what it wants.
   *
   * `schemaHash` comes back in the reply rather than being checked here, because the page is where
   * a mismatch is refused and `WeftOpenError` lives.
   */
  | {
      readonly type: "hydrate";
      readonly scopeId: string;
      readonly deviceId: string;
      /** Which application in this origin these rows belong to. See `./database-key.ts`. */
      readonly namespace: string;
    }
  | { readonly type: "mutate"; readonly mutation: WorkerMutation }
  | { readonly type: "watch"; readonly cacheKey: string; readonly tableName: string; readonly query: CompiledQuery }
  | { readonly type: "unwatch"; readonly cacheKey: string }
  /**
   * The credential the sync session runs under. It crosses because the session runs beside the
   * client, in the worker, where there is no `localStorage` to read it from and no page to ask.
   *
   * A new token is not a setting to update in place: a socket presents its token once, when it
   * connects, so the session is rebuilt around the new credential and the socket reopened. `null`
   * signs the device out and leaves the outbox exactly as it is, because unsent work belongs to
   * the device rather than to the session that would have pushed it (§4.1).
   */
  | { readonly type: "auth"; readonly token: string | null }
  /** Sync now, rather than at the next poll or debounce. Answers when that sync has finished. */
  | { readonly type: "sync" }
  /** Drops this device's diverged work and re-derives its rows from the relay (§5.5). */
  | { readonly type: "discardQuarantine" };

/**
 * Written as an intersection rather than as a second hand-maintained union: a second union has to
 * be edited for every verb added here, and drifts from this one the moment it is not. Narrowing on
 * `.type` still works, because an intersection over a union distributes into a union of
 * intersections.
 */
export type WorkerRequest = WorkerRequestBody & { readonly id: number };

export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string; readonly errorName?: string };

/** A row as it crosses the boundary. Maps do not survive a structured clone with their key order
 * stated, and a `LocalRow`'s sync internals — per-field HLCs, diff3 ancestors — are the worker's
 * business, so only what the page renders from is sent.
 *
 * `rev` is the row's revision exactly as the worker holds it. It is not decoration: `RowIdentityCache`
 * treats it as the row's identity, so a mirror that renumbered it would hand React a new object for
 * an unchanged row on every push — or, worse, an old object for a row that changed.
 */
export interface WireRow {
  readonly tableName: string;
  readonly id: string;
  readonly scopeId: string;
  readonly created: string;
  readonly fields: readonly (readonly [string, WireValue])[];
  readonly rev: number;
  readonly dirty: number;
}

/**
 * What changed, and what the statements *this port* registered now answer. Rows are only those that
 * moved — the mirror keeps the rest, which is what preserves their object identity — and `removed`
 * names the `${tableName}\0${id}` keys the worker no longer holds.
 *
 * Rows and results are scoped differently. A row belongs to the scope, so every port
 * serving that scope is told about it; a result belongs to whoever asked for the statement, and one
 * tab's list is nothing to the tab beside it.
 */
export interface WorkerDelta {
  /** Rows added or changed. */
  readonly rows: readonly WireRow[];
  /** `${tableName}\0${id}` keys the worker no longer holds. */
  readonly removed: readonly string[];
  /**
   * cacheKey -> the ids that statement matched, in order. Only the statements the port this delta
   * is addressed to registered: see `WeftWorkerHost.#push`.
   */
  readonly results: readonly (readonly [string, readonly string[]])[];
}

/**
 * A delta the worker sends without being asked. Every other message on this port answers a
 * request; this one is the echo half of a mutation the page has already returned from.
 */
export interface WorkerDeltaPush extends WorkerDelta {
  readonly push: "delta";
}

/**
 * What the sync session in the worker is doing, on its way to whatever the page renders from it.
 *
 * Sent only when something in it has actually moved: the session compares each status against the
 * last one it published and tells nobody when they match, so this is one message per real change
 * rather than one per poll. That comparison is also what lets the mirror hold the object it was
 * given and hand it to `useSyncExternalStore` unchanged.
 */
export interface WorkerStatusPush {
  readonly push: "status";
  readonly status: SessionStatus;
}

export type WorkerPush = WorkerDeltaPush | WorkerStatusPush;

export type WorkerMessage = WorkerResponse | WorkerPush;

/**
 * What a `hydrate` is answered with: the scope's rows, and the schema the worker serves.
 *
 * The hash rides along because a page and a worker built from different schemas have to be refused
 * rather than left selecting columns the other has never had. A tab is already sending this and
 * already waiting for its reply, so carrying it here costs a field rather than a round trip.
 */
export interface WorkerHydrated extends WorkerDelta {
  readonly schemaHash: string;
}

/** Reads a `hydrate` reply that crossed a structured clone, which types as `unknown` on arrival. */
export function isWorkerHydrated(value: unknown): value is WorkerHydrated {
  if (typeof value !== "object" || value === null) return false;
  const reply = value as Partial<WorkerHydrated>;
  if (typeof reply.schemaHash !== "string") return false;
  return Array.isArray(reply.rows) && Array.isArray(reply.removed) && Array.isArray(reply.results);
}

/**
 * Which of the two a message is. A response carries `id` and a push carries `push`, so this is the
 * whole test — and it has to be made, because a transport that read `id` off every message would
 * settle request number `undefined` for each push that went by.
 */
function isWorkerPush(message: WorkerMessage): message is WorkerPush {
  return "push" in message;
}

/**
 * Narrows to the row half of a push, which is the only one that carries a delta to apply. Takes a
 * whole `WorkerMessage` rather than a `WorkerPush`, so a caller holding everything that crossed the
 * port can pick the deltas out of it without narrowing twice.
 */
export function isDeltaPush(message: WorkerMessage): message is WorkerDeltaPush {
  return "push" in message && message.push === "delta";
}

/**
 * The far end of the protocol as the page holds it: a `SharedWorker`'s `port`, which is a
 * `MessagePort`.
 *
 * `start` is required of a `MessagePort` reached through `addEventListener`, which delivers nothing
 * until it is started, and `close` is what tells the worker this connection has gone. Both are
 * optional so that a test can serve a `MessageChannel` end or a `node:worker_threads` port, whose
 * shapes differ in exactly these two.
 */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void;
  /**
   * The far end of this port has gone. `node:worker_threads` raises it; no browser raises it on a
   * `MessagePort` yet, which is the gap `REQUEST_DEADLINE_MS` covers.
   */
  addEventListener(type: "close", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void;
  start?(): void;
  close?(): void;
}

export type WorkerPushHandler = (push: WorkerPush) => void;

export interface WorkerPortTransportOptions {
  /** How long a request waits before the worker counts as gone. */
  readonly deadlineMs?: number | undefined;
}

/**
 * How long a request waits for the worker before the page treats the worker as gone.
 *
 * A silence is what stands in for the port's `close` event, which no browser fires: Chrome 151 and
 * Firefox 152 both answer `"onclose" in new MessageChannel().port1` with `false`, and closing one
 * end of a channel raises nothing on the other. Without this a page whose `SharedWorker` the
 * browser stopped waits for ever on every write it makes.
 *
 * A running worker answers in milliseconds and a stopped one answers never, so this has only to
 * clear the slowest true answer — a hydrate of a large database against a cold WebAssembly module.
 */
const REQUEST_DEADLINE_MS = 20_000;

/**
 * A correlated request/response transport over a port that speaks the worker protocol: it numbers
 * each request, settles the reply that carries the same number, and hands the pushes that carry
 * none to whoever subscribed.
 *
 * Nothing in it knows what the port is made of. A `SharedWorker`'s port in a browser, a
 * `MessageChannel` end under Node, and the same class serves either.
 */
export class WorkerPortTransport {
  readonly #worker: WorkerLike;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly deadline: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #pushHandlers = new Set<WorkerPushHandler>();
  readonly #closedHandlers = new Set<() => void>();
  readonly #deadlineMs: number;
  #closed = false;

  constructor(worker: WorkerLike, options: WorkerPortTransportOptions = {}) {
    this.#worker = worker;
    this.#deadlineMs = options.deadlineMs ?? REQUEST_DEADLINE_MS;
    this.#worker.addEventListener("message", this.#onMessage);
    this.#worker.addEventListener("close", this.#announceClosed);
    // A `MessagePort` reached through `addEventListener` queues what arrives and delivers none of
    // it until it is started, so a tab would post a hydrate and wait for an answer already sitting
    // in its own queue.
    this.#worker.start?.();
  }

  execute(query: CompiledQuery): Promise<unknown> {
    return this.request({ type: "execute", query });
  }

  close(): Promise<unknown> {
    return this.request({ type: "close" });
  }

  /**
   * Any request, correlated. The two named methods above are conveniences over this one;
   * everything the worker host adds goes through here rather than growing a method apiece, so
   * correlation stays in one place.
   */
  request(message: WorkerRequestBody): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => this.#giveUpOn(id), this.#deadlineMs);
      this.#pending.set(id, { resolve, reject, deadline });
      this.#worker.postMessage(withRequestId(id, message));
    });
  }

  /** Fires once the worker at the far end has gone, however the page came to know it. */
  onClosed(handler: () => void): void {
    this.#closedHandlers.add(handler);
  }

  /**
   * Subscribes to the deltas the worker sends unasked. A set rather than a single handler because a
   * mirror outlives the transport under it — a worker the browser stopped is replaced beneath a
   * page that carries on — and a returned unsubscribe is what makes the two independent.
   */
  onPush(handler: WorkerPushHandler): () => void {
    this.#pushHandlers.add(handler);
    return () => {
      this.#pushHandlers.delete(handler);
    };
  }

  /**
   * Stops listening and settles what was in flight.
   *
   * The reason is a parameter because the two callers mean different things by it. A tab closing
   * its own database is one; a tab whose worker the browser stopped is the other, and a caller
   * awaiting a write deserves to be told which — dropping the entries instead would leave it
   * awaiting a promise nothing is left to settle.
   *
   * Closing the port is what tells the worker at the far end that this connection has gone.
   */
  dispose(reason = "worker transport disposed"): void {
    this.#worker.removeEventListener("message", this.#onMessage);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.deadline);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
    this.#pushHandlers.clear();
    this.#closedHandlers.clear();
    this.#worker.close?.();
  }

  /**
   * Gives up on one request, and takes the silence as the worker having gone.
   *
   * Reconnecting builds a `SharedWorker` at the same URL, which joins one that is running as
   * readily as it wakes one that is not, so a worker that was only slow costs a reconnect and
   * nothing besides. Its answer arrives for an id nothing is waiting on and is dropped.
   */
  #giveUpOn(id: number): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    pending.reject(new Error(`the worker did not answer in ${String(this.#deadlineMs)}ms`));
    this.#announceClosed();
  }

  /** Once per transport: every request outstanding when a worker goes times out separately. */
  readonly #announceClosed = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    for (const handler of [...this.#closedHandlers]) handler();
  };

  readonly #onMessage = (event: MessageEvent<WorkerMessage>): void => {
    const message = event.data;
    // The worker also posts unsolicited deltas on this port, and they carry no request id. Reading
    // one as a response would look `undefined` up in the pending map on a good day and mis-settle
    // whichever request happened to be numbered like the push on a bad one.
    if (isWorkerPush(message)) {
      // Over a copy: a handler is allowed to unsubscribe from inside itself — the mirror's does, by
      // way of `dispose` — and mutating the set mid-iteration would skip whoever came after it.
      for (const handler of [...this.#pushHandlers]) handler(message);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.deadline);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(named(message.error, message.errorName));
  };
}

/** The worker's rejection, with the name it carried, so a caller can tell which failure it was. */
function named(message: string, name: string | undefined): Error {
  const error = new Error(message);
  if (name !== undefined) error.name = name;
  return error;
}

function withRequestId(id: number, message: WorkerRequestBody): WorkerRequest {
  return { ...message, id };
}
