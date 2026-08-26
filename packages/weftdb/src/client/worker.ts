import type { WireValue } from "weftdb/core";
import type { CompiledQuery } from "./query.ts";
import type { SessionStatus } from "./session.ts";

/**
 * A change the page asks the worker to carry out. Only the intent crosses, never the result: the
 * `WeftClient` lives in the worker under OPFS — `SqlExecutor` is synchronous and
 * `ClientPersistence.save` takes the live client — so the page has nothing to apply the mutation
 * to. What comes back is the rows that moved, as a `WorkerPush`.
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
 * alone; the rest drive the client the worker host owns. Every tab speaks the whole vocabulary,
 * because every tab holds a port straight to the worker — a follower that could only `execute` had
 * no way to drive a mirror.
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
   * Distinct from `close`, which closes the *database*. One tab leaving must not take the OPFS
   * access handle away from the tabs that are staying.
   */
  | { readonly type: "disconnect" }
  /**
   * Every row of a scope, and what kind of database they are in. The first thing any tab sends.
   *
   * It doubles as a tab's proof that the port it was handed reached a document that is still there.
   * The broker forwards a port and hears nothing back, and a registration left by a tab that has
   * gone is indistinguishable from a live one, so the test is not whether the port was accepted but
   * whether anything answers over it — and this is the answer a tab needs anyway.
   */
  | { readonly type: "hydrate"; readonly scopeId: string; readonly deviceId: string }
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
 * Written as an intersection rather than as a second hand-maintained union: the two drifted apart
 * every time a verb was added, and narrowing on `.type` still works because an intersection over a
 * union distributes into a union of intersections.
 */
export type WorkerRequest = WorkerRequestBody & { readonly id: number };

export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

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
 * Rows and results are scoped differently on purpose. A row belongs to the scope, so every port
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
 * Whether the database this worker opened outlives the window it was opened in.
 *
 * `"durable"` is OPFS: the file is still there on the next visit, which is what every other part of
 * this design assumes. `"ephemeral"` is a browser that declined the synchronous access handle pool —
 * private browsing is the case that matters — and was served an in-memory SQLite instead. Rows, the
 * outbox and the quarantine all go when the window does, a reload included.
 *
 * It crosses the port because it cannot be worked out on the page: which of the two a device got is
 * decided inside the worker, by what the browser was willing to hand out. An application that wants
 * to tell the person this window will not remember has no other source for it.
 */
export type WeftDurability = "durable" | "ephemeral";

/**
 * The one thing a worker says before it is asked anything: whether it managed to open the database
 * at all, which schema it opened, and whether what it opened will still be there next time.
 *
 * It exists because the answer cannot be got any other way. Whether OPFS will hand out a synchronous
 * access handle pool is a property of the worker — Safari's private mode has no pool, and the page
 * has no way to find that out from where it stands — so the worker has to try and report. A
 * rejection thrown inside the worker reaches the page as an `error` event with no detail, which is
 * why this is an ordinary message rather than an unhandled one.
 *
 * It is announced rather than answered, because a request cannot be made yet: a dedicated worker
 * that spends its first turns awaiting a WebAssembly module has no `message` listener attached, and
 * anything the page posted before `serveWeftWorker` ran would be delivered to nobody.
 *
 * The `weft` tag is what keeps it inert to everything already on these ports. It carries neither the
 * numeric `id` a `WorkerResponse` is recognised by nor the `push` a `WorkerPush` is, so
 * `WorkerPortTransport` and `WeftWorkerHost` alike drop it untouched.
 */
export type WeftWorkerReady =
  | {
      readonly weft: "ready";
      readonly ok: true;
      /** The schema the worker serves, so a page cannot open against a worker built from another. */
      readonly schemaHash: string;
      /** Absent means `"durable"`: a worker that says nothing about it opened an OPFS database. */
      readonly durability?: WeftDurability;
    }
  | { readonly weft: "ready"; readonly ok: false; readonly error: string };

/**
 * What a `hydrate` is answered with: the scope's rows, and what kind of database they are in.
 *
 * The durability rides along because this is the second path it has to travel, and it is not
 * decoration. A follower is never present for the announcement above — it is handed a `MessagePort`
 * to a worker another tab created — so without this the same database would be reported durable in
 * one tab and ephemeral in the next. A tab is already sending this and already waiting for its
 * reply, so carrying it here costs a field rather than a round trip.
 */
export interface WorkerHydrated extends WorkerDelta {
  readonly durability: WeftDurability;
}

/** Reads a `hydrate` reply that crossed a structured clone, which types as `unknown` on arrival. */
export function isWorkerHydrated(value: unknown): value is WorkerHydrated {
  if (typeof value !== "object" || value === null) return false;
  const durability: unknown = (value as { readonly durability?: unknown }).durability;
  return durability === "durable" || durability === "ephemeral";
}

export function isWeftWorkerReady(value: unknown): value is WeftWorkerReady {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { readonly weft?: unknown; readonly ok?: unknown };
  return message.weft === "ready" && typeof message.ok === "boolean";
}

/**
 * Another tab's end of a `MessageChannel`, handed to the worker to be served like the port the
 * worker was made with. It is how a tab that may not touch OPFS gets a connection of its own rather
 * than a proxy through the tab that may.
 *
 * The port travels *in the message* as well as in the transfer list, and that is deliberate. A
 * browser populates both `event.data` and `event.ports` for a transferred port; Node's
 * `worker_threads` populates only `event.data`, and the whole multi-tab assembly is tested under
 * Node. Reading it out of the message is therefore the one way that works in both, and reading
 * `event.ports` would have been a path exercised by nothing.
 *
 * Tagged `weft` for the same reason `WeftWorkerReady` is: it carries neither a numeric `id` nor a
 * `push`, so a transport that happens to see one drops it untouched.
 */
export interface WeftWorkerConnect {
  readonly weft: "connect";
  /** A `MessagePort`. Untyped here because only the host, which serves it, needs its shape. */
  readonly port: unknown;
}

export function isWeftWorkerConnect(value: unknown): value is WeftWorkerConnect {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { readonly weft?: unknown; readonly port?: unknown };
  return message.weft === "connect" && typeof message.port === "object" && message.port !== null;
}

/**
 * Which of the two a message is. A response carries `id` and a push carries `push`, so this is the
 * whole test — and it has to be made, because a transport that read `id` off every message would
 * settle request number `undefined` for each push that went by.
 */
export function isWorkerPush(message: WorkerMessage): message is WorkerPush {
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
 * The far end of the protocol as the page holds it: a dedicated `Worker` in the tab that made one,
 * and a `MessagePort` straight to that worker in every other tab.
 *
 * `transfer` is what makes the second case possible: a port cannot be cloned, only moved, so the
 * tab holding the worker forwards an incoming port with `postMessage(connect, [port])`. It is
 * optional because nothing else on this protocol transfers anything.
 *
 * `start` is optional for the same reason it is optional on a `MessagePort`: a port reached through
 * `addEventListener` rather than through `onmessage` does not begin delivering until it is started,
 * and a `Worker` has nothing to start. `close` is a `MessagePort`'s, `terminate` a `Worker`'s, and
 * both are optional because a tab holds one or the other and never both — the page that made the
 * worker stops it, and the page that was handed a port closes that.
 */
export interface WorkerLike {
  postMessage(message: WorkerRequest | WeftWorkerConnect, transfer?: readonly unknown[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void;
  start?(): void;
  close?(): void;
  terminate?(): void;
}

export type WorkerPushHandler = (push: WorkerPush) => void;

/**
 * A correlated request/response transport over a port that speaks the worker protocol: it numbers
 * each request, settles the reply that carries the same number, and hands the pushes that carry
 * none to whoever subscribed.
 *
 * Nothing about it is OPFS, which is what the name it used to have claimed. The port underneath is
 * a dedicated `Worker` in the tab that made one and a bare `MessagePort` to that worker in every
 * other tab, and this class cannot tell the two apart — which is precisely what lets one mirror run
 * in either kind of tab without knowing which it is in.
 */
export class WorkerPortTransport {
  readonly #worker: WorkerLike;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  readonly #pushHandlers = new Set<WorkerPushHandler>();

  constructor(worker: WorkerLike) {
    this.#worker = worker;
    this.#worker.addEventListener("message", this.#onMessage);
    // A `MessagePort` reached through `addEventListener` queues what arrives and delivers none of
    // it until it is started, so a follower tab handed a port would post a hydrate and wait for an
    // answer already sitting in its own queue. A `Worker` has no `start` and does not care.
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
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage(withRequestId(id, message));
    });
  }

  /**
   * Subscribes to the deltas the worker sends unasked. A set rather than a single handler because a
   * mirror is disposed and rebuilt against a transport that outlives it — leadership moving is
   * exactly that — and a returned unsubscribe is what makes the two independent.
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
   * its own database is one; a tab whose worker went with the tab that owned it is the other, and a
   * caller awaiting a write deserves to be told which — dropping the entries instead would leave it
   * awaiting a promise nothing is left to settle.
   *
   * The port is closed if it has a `close`, which a `MessagePort` does and a `Worker` does not.
   * That is what tells the worker at the far end that this connection has gone.
   */
  dispose(reason = "worker transport disposed"): void {
    this.#worker.removeEventListener("message", this.#onMessage);
    for (const pending of this.#pending.values()) pending.reject(new Error(reason));
    this.#pending.clear();
    this.#pushHandlers.clear();
    this.#worker.close?.();
  }

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
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error));
  };
}

export function withRequestId(id: number, message: WorkerRequestBody): WorkerRequest {
  return { ...message, id };
}
