import type { CompiledQuery } from "./query.ts";
import type { WorkerRequest, WorkerRequestBody, WorkerResponse } from "./worker.ts";

export type TabRole = "leader" | "follower" | "degraded";

export interface LockManagerLike {
  request<T>(
    name: string,
    options: { readonly ifAvailable: true },
    callback: (lock: object | null) => T | Promise<T>,
  ): Promise<T>;
}

export interface MultiTabOptions {
  readonly scopeId: string;
  readonly locks?: LockManagerLike;
  readonly channel?: BroadcastChannel;
}

export class MultiTabCoordinator {
  readonly scopeId: string;
  readonly locks: LockManagerLike | undefined;
  readonly channel: BroadcastChannel;
  role: TabRole = "degraded";
  /** Resolved to hand the lock back; held for as long as this tab is the leader. */
  #release: (() => void) | undefined;

  constructor(options: MultiTabOptions) {
    this.scopeId = options.scopeId;
    this.locks = options.locks;
    this.channel = options.channel ?? new BroadcastChannel(`weft:${options.scopeId}`);
  }

  /**
   * Web Locks holds a lock for exactly as long as the callback's returned promise is pending, so
   * a callback that returns immediately gives the lock straight back and leaves every tab in
   * turn believing it leads. The callback here returns a promise that stays pending until
   * `close`, and election waits on being told which way it went rather than on the request.
   */
  async elect(): Promise<TabRole> {
    if (this.locks === undefined) {
      this.role = "degraded";
      return this.role;
    }
    if (this.role === "leader") return this.role;
    const locks = this.locks;
    return new Promise<TabRole>((resolveRole, rejectRole) => {
      const held = locks.request(`weft:${this.scopeId}:opfs`, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          this.role = "follower";
          resolveRole(this.role);
          return undefined;
        }
        this.role = "leader";
        resolveRole(this.role);
        return new Promise<void>((releaseLock) => {
          this.#release = releaseLock;
        });
      });
      // The leader's request stays pending for as long as it leads, so this only ever fires for
      // a request that failed outright — in which case the election has no answer to give.
      held.catch(rejectRole);
    });
  }

  close(): void {
    this.#release?.();
    this.#release = undefined;
    if (this.role === "leader") this.role = "degraded";
    this.channel.close();
  }
}

/**
 * What a follower puts on the channel. The sender is named because every tab on the channel
 * hears every message: request ids are only unique within the tab that issued them, so without
 * a sender two followers both counting from one would each answer to the other's traffic.
 */
export interface ProxyRequest {
  readonly client: string;
  readonly request: WorkerRequest;
}

/** What the leader puts back, addressed to the follower that asked. */
export interface ProxyResponse {
  readonly client: string;
  readonly response: WorkerResponse;
}

export class BroadcastDbProxy {
  readonly channel: BroadcastChannel;
  readonly #client = crypto.randomUUID();
  #nextId = 1;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (response: WorkerResponse) => void;
      readonly reject: (error: Error) => void;
    }
  >();

  constructor(channel: BroadcastChannel) {
    this.channel = channel;
    this.channel.addEventListener("message", this.#onMessage);
  }

  request(message: WorkerRequestBody): Promise<WorkerResponse> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const envelope: ProxyRequest = { client: this.#client, request: withRequestId(id, message) };
      this.channel.postMessage(envelope);
    });
  }

  /**
   * Stops listening and settles what was in flight. Dropping the entries instead would leave
   * every caller awaiting a promise that nothing is left to resolve, which is a tab that closed
   * its database and then hung on the next query rather than reporting that it had.
   */
  dispose(): void {
    this.channel.removeEventListener("message", this.#onMessage);
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.reject(new Error("the database proxy was disposed"));
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (!isProxyResponse(message) || message.client !== this.#client) return;
    const pending = this.#pending.get(message.response.id);
    if (pending === undefined) return;
    this.#pending.delete(message.response.id);
    pending.resolve(message.response);
  };
}

/**
 * What a leader runs a follower's request against. `OpfsWorkerTransport` satisfies this
 * structurally, so a leader that already holds one passes it straight in; a test passes a double.
 */
export interface ProxyTarget {
  open(scopeId: string): Promise<unknown>;
  execute(query: CompiledQuery): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface BroadcastDbProxyServerOptions {
  readonly channel: BroadcastChannel;
  readonly target: ProxyTarget;
  /**
   * Consulted once per request. A tab that has lost the lock must stop answering before a
   * successor starts, or two leaders answer one request and the follower settles on whichever
   * reply arrived first.
   */
  readonly isLeader?: () => boolean;
}

/**
 * The leader half of `BroadcastDbProxy`: it takes what a follower puts on the channel, runs it
 * against the target, and addresses the reply back to the tab that asked. Returns the function
 * that stops it.
 *
 * A reply produced after stopping is dropped rather than posted. Stopping is how a tab abdicates,
 * and an abdicated leader that still answers is the two-leader case `isLeader` exists to prevent.
 */
export function serveBroadcastDbProxy(options: BroadcastDbProxyServerOptions): () => void {
  const { channel, target } = options;
  let serving = true;

  const reply = (client: string, response: WorkerResponse): void => {
    if (!serving) return;
    channel.postMessage({ client, response } satisfies ProxyResponse);
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    const envelope = event.data;
    // The guard is what keeps a leader from answering its own replies: a `ProxyResponse` carries
    // `response` where a request carries `request`, and both ride the same channel.
    if (!serving || !isProxyRequest(envelope)) return;
    if (options.isLeader !== undefined && !options.isLeader()) return;
    const { id } = envelope.request;
    void dispatch(target, envelope.request).then(
      (value) => {
        reply(envelope.client, { id, ok: true, value });
      },
      (error: unknown) => {
        reply(envelope.client, { id, ok: false, error: describeError(error) });
      },
    );
  };

  channel.addEventListener("message", onMessage);
  return () => {
    serving = false;
    channel.removeEventListener("message", onMessage);
  };
}

function dispatch(target: ProxyTarget, request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case "open":
      return target.open(request.scopeId);
    case "execute":
      return target.execute(request.query);
    case "close":
      return target.close();
  }
}

/**
 * A rejection crosses the channel as text, because an `Error` does not survive structured clone
 * with its prototype intact and the follower rebuilds one from the message anyway.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProxyRequest(value: unknown): value is ProxyRequest {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as { readonly client?: unknown; readonly request?: unknown };
  if (typeof envelope.client !== "string" || typeof envelope.request !== "object" || envelope.request === null)
    return false;
  const request = envelope.request as { readonly id?: unknown; readonly type?: unknown };
  if (typeof request.id !== "number") return false;
  return request.type === "open" || request.type === "execute" || request.type === "close";
}

function isProxyResponse(value: unknown): value is ProxyResponse {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as { readonly client?: unknown; readonly response?: unknown };
  if (typeof envelope.client !== "string" || typeof envelope.response !== "object" || envelope.response === null)
    return false;
  const response = envelope.response as { readonly id?: unknown; readonly ok?: unknown };
  return typeof response.id === "number" && typeof response.ok === "boolean";
}

function withRequestId(id: number, message: WorkerRequestBody): WorkerRequest {
  switch (message.type) {
    case "open":
      return { ...message, id };
    case "execute":
      return { ...message, id };
    case "close":
      return { ...message, id };
  }
}
