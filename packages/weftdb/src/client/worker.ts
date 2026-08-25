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
 * What the page can ask for, without the correlation id. `open`, `execute` and `close` drive the
 * database alone; the rest drive the client the worker host owns. A follower tab speaks all seven,
 * because `BroadcastDbProxy` forwards the whole vocabulary to the leader rather than a subset of
 * it — a follower that could only `execute` had no way to drive a mirror.
 */
export type WorkerRequestBody =
  | { readonly type: "open"; readonly scopeId: string }
  | { readonly type: "execute"; readonly query: CompiledQuery }
  | { readonly type: "close" }
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
 * What changed, and what every watched statement now answers. Rows are only those that moved —
 * the mirror keeps the rest, which is what preserves their object identity — and `removed` names
 * the `${tableName}\0${id}` keys the worker no longer holds.
 */
export interface WorkerDelta {
  /** Rows added or changed. */
  readonly rows: readonly WireRow[];
  /** `${tableName}\0${id}` keys the worker no longer holds. */
  readonly removed: readonly string[];
  /** cacheKey -> the ids that statement matched, in order. */
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
 * The one thing a worker says before it is asked anything: whether it managed to open the database
 * at all, and which schema it opened.
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
 * `OpfsWorkerTransport`, `WeftWorkerHost` and both halves of `BroadcastDbProxy` drop it untouched.
 */
export type WeftWorkerReady =
  | {
      readonly weft: "ready";
      readonly ok: true;
      /** The schema the worker serves, so a page cannot open against a worker built from another. */
      readonly schemaHash: string;
    }
  | { readonly weft: "ready"; readonly ok: false; readonly error: string };

export function isWeftWorkerReady(value: unknown): value is WeftWorkerReady {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { readonly weft?: unknown; readonly ok?: unknown };
  return message.weft === "ready" && typeof message.ok === "boolean";
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

export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void;
}

export type WorkerPushHandler = (push: WorkerPush) => void;

/**
 * Everything `WeftClientMirror` needs of whatever stands between it and the worker: a correlated
 * request, and a subscription to the deltas that arrive unasked.
 *
 * Two things satisfy it. `OpfsWorkerTransport` does, for a leader tab that holds the worker port
 * itself; `BroadcastDbProxy` does, for a follower tab whose traffic goes over a BroadcastChannel to
 * the one tab that may hold the OPFS access handle. Which one a tab got is settled where the tab is
 * built, so the mirror — and every component reading it — has no idea which role it is running in.
 */
export interface MirrorTransport {
  request(body: WorkerRequestBody): Promise<unknown>;
  /** Returns the function that unsubscribes; calling it twice is harmless. */
  onPush(handler: WorkerPushHandler): () => void;
}

export class OpfsWorkerTransport {
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
  }

  open(scopeId: string): Promise<unknown> {
    return this.request({ type: "open", scopeId });
  }

  execute(query: CompiledQuery): Promise<unknown> {
    return this.request({ type: "execute", query });
  }

  close(): Promise<unknown> {
    return this.request({ type: "close" });
  }

  /**
   * Any request, correlated. The three named methods above are conveniences over this one;
   * everything the worker host adds goes through here rather than growing a method apiece, so
   * correlation stays in one place — and one method is all `ProxyTarget` and `MirrorTransport` ask
   * for, which is why this class satisfies both without being told about either.
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
   * leader tab has two interested parties on one port — its own mirror, and the relay that puts the
   * push on the BroadcastChannel for the follower tabs — and neither should have to know the other
   * exists.
   */
  onPush(handler: WorkerPushHandler): () => void {
    this.#pushHandlers.add(handler);
    return () => {
      this.#pushHandlers.delete(handler);
    };
  }

  dispose(): void {
    this.#worker.removeEventListener("message", this.#onMessage);
    for (const pending of this.#pending.values()) pending.reject(new Error("worker transport disposed"));
    this.#pending.clear();
    this.#pushHandlers.clear();
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
