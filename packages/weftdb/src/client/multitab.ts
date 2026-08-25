import {
  withRequestId,
  type WorkerPush,
  type WorkerPushHandler,
  type WorkerRequest,
  type WorkerRequestBody,
  type WorkerResponse,
} from "./worker.ts";

export type TabRole = "leader" | "follower" | "degraded";

/**
 * The subset of `LockOptions` this module uses. `ifAvailable` is how an election asks without
 * waiting; `signal` is how a tab that is closing leaves the queue it stood in.
 *
 * Both are optional because the absence of `ifAvailable` is the whole liveness mechanism: a request
 * made without it is not answered until the lock is free, which — since the browser owns the lock
 * and releases it when the holding tab dies, crashes or is killed — is exactly "the leader is gone".
 */
export interface LockRequestOptionsLike {
  readonly ifAvailable?: boolean;
  readonly signal?: AbortSignal;
}

export interface LockManagerLike {
  request<T>(
    name: string,
    options: LockRequestOptionsLike,
    callback: (lock: object | null) => T | Promise<T>,
  ): Promise<T>;
}

export interface MultiTabOptions {
  readonly scopeId: string;
  readonly locks?: LockManagerLike;
  readonly channel?: BroadcastChannel;
}

/** Told to every tab of a scope by whichever one has just taken the lock. See `#announce`. */
export interface LeadershipAnnouncement {
  readonly weft: "leader";
  readonly scopeId: string;
}

/**
 * What a tab is told when leadership moves: the part this tab is playing now.
 *
 * A successor hears `"leader"`. Every other tab of the scope hears `"follower"` — the same role it
 * already had, and that is not a redundant call: the leader it was talking to has gone, so whatever
 * it had in flight is never going to be answered and whatever it had registered no longer exists.
 * `"degraded"` is never announced; a tab reaches it only by closing.
 */
export type LeadershipListener = (role: TabRole) => void;

export class MultiTabCoordinator {
  readonly scopeId: string;
  readonly locks: LockManagerLike | undefined;
  readonly channel: BroadcastChannel;
  role: TabRole = "degraded";
  /** Resolved to hand the lock back; held for as long as this tab is the leader. */
  #release: (() => void) | undefined;
  /** Aborts the queued succession request, so a tab that closes stops standing in line. */
  #standby: AbortController | undefined;
  readonly #listeners = new Set<LeadershipListener>();
  #closed = false;

  constructor(options: MultiTabOptions) {
    this.scopeId = options.scopeId;
    this.locks = options.locks;
    this.channel = options.channel ?? new BroadcastChannel(`weft:${options.scopeId}`);
    this.channel.addEventListener("message", this.#onMessage);
  }

  /**
   * Web Locks holds a lock for exactly as long as the callback's returned promise is pending, so
   * a callback that returns immediately gives the lock straight back and leaves every tab in
   * turn believing it leads. The callback here returns a promise that stays pending until
   * `close`, and election waits on being told which way it went rather than on the request.
   *
   * A tab that comes back a follower learns nothing more from this call. `watchLeader` is what
   * turns "somebody else has it" into "and this tab will be told when they no longer do".
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
        // Nothing is announced. An election is this tab asking who leads, and the answer is what
        // it returns; the tabs that would hear an announcement are each getting their own answer
        // from their own election, and there is no incumbent whose followers need re-pointing.
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

  /**
   * Registers a listener for leadership moving, and returns a way to stop listening.
   *
   * Register before calling `watchLeader`: succession can be granted in the same turn the previous
   * leader lets go, and a listener attached afterwards would miss the one event it exists for.
   */
  onLeadershipChange(listener: LeadershipListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Stands this tab in line behind the leader, so that it is told — and takes over — when the
   * leader is gone.
   *
   * The whole mechanism is one Web Lock request made *without* `ifAvailable`. The browser answers
   * it when the lock is free and not before, and the browser releases the lock when the holding tab
   * closes, crashes, is killed for memory, or is discarded from the bfcache. So being granted this
   * request is a browser-guaranteed statement that the previous leader is gone, and there is no
   * timeout to tune and nothing to mistake a slow tab for.
   *
   * That is why it is a queued lock rather than a heartbeat on the channel. A heartbeat needs an
   * interval longer than the slowest SQLite commit and shorter than a person's patience, and no
   * such interval exists: a tab throttled in the background misses beats for minutes while being
   * perfectly alive, and concluding it had died would put two workers on one OPFS access handle.
   * Leadership is therefore only ever concluded from holding the lock — never from a message,
   * never from silence.
   *
   * Being granted the lock is also what makes succession exclusive without any agreement between
   * tabs: the queue is the browser's, it hands the lock to one waiter at a time, and every other
   * waiter simply stays in line for the next death.
   *
   * Idempotent, and a no-op for a tab that already leads or that has no Web Locks to wait on.
   */
  watchLeader(): void {
    if (this.locks === undefined || this.#closed) return;
    if (this.role !== "follower") return;
    if (this.#standby !== undefined) return;
    const controller = new AbortController();
    this.#standby = controller;
    const locks = this.locks;
    const held = locks.request(`weft:${this.scopeId}:opfs`, { signal: controller.signal }, (lock) => {
      // A queued request is granted or it is not. `null` is what `ifAvailable` answers with, so an
      // implementation that returned it here is saying the lock was busy — and taking that for a
      // grant is precisely the second leader this class exists to prevent.
      if (lock === null) return undefined;
      this.#standby = undefined;
      // Handed back immediately if this tab closed while it was in the queue, so the lock goes to
      // whoever is behind it rather than to a coordinator nobody is holding any more.
      if (this.#closed || controller.signal.aborted) return undefined;
      this.#succeed();
      return new Promise<void>((releaseLock) => {
        this.#release = releaseLock;
      });
    });
    // An aborted request rejects, and so does one the manager refuses. Neither is leadership, so
    // neither is announced — the queue is simply no longer being stood in.
    held.catch(() => {
      if (this.#standby === controller) this.#standby = undefined;
    });
  }

  close(): void {
    this.#closed = true;
    // Before the lock is handed back, so the queue this tab was standing in is left before the
    // lock it was standing in line for becomes free.
    this.#standby?.abort();
    this.#standby = undefined;
    this.#release?.();
    this.#release = undefined;
    if (this.role === "leader") this.role = "degraded";
    // Nothing is announced. A tab that is closing has no use for its own listeners, and telling
    // them leadership had moved would have the page rebuild itself on the way out.
    this.#listeners.clear();
    this.channel.removeEventListener("message", this.#onMessage);
    this.channel.close();
  }

  /**
   * Takes over from a leader that has gone, and says so.
   *
   * The announcement is the only part of this that is not the lock, and it exists for the tabs the
   * lock will never reach: the other followers, who are still in the queue behind this tab and
   * would otherwise never learn that the leader they were talking to has died. It is posted only
   * by a tab that is holding the lock at the moment it posts, and no tab ever concludes from
   * hearing one that *it* leads — see `#onMessage`. A spurious announcement therefore costs a
   * follower a re-hydrate; a spurious grant would cost a second worker, and only the browser can
   * issue one of those.
   */
  #succeed(): void {
    this.role = "leader";
    this.channel.postMessage({ weft: "leader", scopeId: this.scopeId } satisfies LeadershipAnnouncement);
    this.#announce("leader");
  }

  #announce(role: TabRole): void {
    for (const listener of [...this.#listeners]) listener(role);
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    if (this.#closed || this.role !== "follower") return;
    const message = event.data;
    if (!isLeadershipAnnouncement(message) || message.scopeId !== this.scopeId) return;
    // Still a follower — of somebody else. Said out loud because the leader this tab was talking to
    // has gone, so its in-flight requests and its registered watches went with it.
    this.#announce("follower");
  };
}

function isLeadershipAnnouncement(value: unknown): value is LeadershipAnnouncement {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { readonly weft?: unknown; readonly scopeId?: unknown };
  return message.weft === "leader" && typeof message.scopeId === "string";
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

/**
 * A worker push, relayed by the leader to every tab at once.
 *
 * It carries no `client`, and that absence is the whole design. A push is not an answer to anyone:
 * the worker recomputes every watched statement after every mutation, whichever tab caused it, so
 * the delta is addressed to the channel rather than to a tab. Naming the field `broadcast` — where
 * a request has `request` and a response has `response` — also means the two existing structural
 * guards reject it untouched: both demand a string `client`, and this envelope has none. A leader
 * therefore cannot mistake a relayed push for a follower's request and try to run it, and a
 * follower cannot mistake one for a reply and settle a request out of it.
 */
export interface ProxyPush {
  readonly broadcast: WorkerPush;
}

export interface BroadcastDbProxyOptions {
  /**
   * A deadline on every request, in milliseconds. Off by default, and deliberately so.
   *
   * The leader going away is answered by `failInFlight`, driven by the Web Lock, which cannot
   * produce a false positive — so a timer here is not the liveness mechanism and must not be
   * mistaken for one. What it covers is the case the lock cannot see: a leader that is alive and
   * holding the lock while its worker is wedged. Any value chosen for that has to exceed the
   * slowest commit an application can produce, which is why the library will not choose one.
   */
  readonly requestTimeoutMs?: number;
}

export class BroadcastDbProxy {
  readonly channel: BroadcastChannel;
  readonly #client = crypto.randomUUID();
  readonly #requestTimeoutMs: number | undefined;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  readonly #pushHandlers = new Set<WorkerPushHandler>();
  /**
   * How many live watches this tab has per cache key, counted from the traffic going past. The
   * proxy is otherwise a pipe and would rather not read what it forwards — but the leader's host
   * has no way to notice that a follower went away, so a tab that closes has to hand its own
   * registrations back. See `dispose`.
   */
  readonly #watching = new Map<string, number>();

  constructor(channel: BroadcastChannel, options: BroadcastDbProxyOptions = {}) {
    this.channel = channel;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.channel.addEventListener("message", this.#onMessage);
  }

  /**
   * Sends a request to the leader and resolves with what the worker answered — or rejects with what
   * it refused, exactly as `OpfsWorkerTransport.request` does.
   *
   * Unwrapped rather than handing back the `WorkerResponse` envelope, because that is the whole
   * difference between structurally satisfying `MirrorTransport` and actually being one. A mirror
   * handed `{ id, ok, value }` where it expected a delta would find no `rows` on it and call the
   * worker malformed, and a refusal that arrived as a resolved `{ ok: false }` would look to a
   * mutator like an edit that quietly did nothing.
   */
  request(message: WorkerRequestBody): Promise<unknown> {
    this.#note(message);
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const timeoutMs = this.#requestTimeoutMs;
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.#settle(id)?.reject(new Error(`the leader did not answer within ${timeoutMs}ms`));
            }, timeoutMs);
      // Node keeps its loop alive for a pending timer, and a page waiting on a database is not a
      // reason to keep a process running; a browser has no `unref` and does not care.
      (timer as { unref?: () => void } | undefined)?.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      const envelope: ProxyRequest = { client: this.#client, request: withRequestId(id, message) };
      this.channel.postMessage(envelope);
    });
  }

  /**
   * Subscribes to the deltas the leader relays. This, plus `request`, is the whole `MirrorTransport`
   * shape, which is what lets one `WeftClientMirror` run over a worker port in the leader and over
   * the channel in a follower.
   *
   * A subscription rather than a constructor option: the proxy is built when the tab learns it is a
   * follower and the mirror is built when the application asks for one, so the proxy would have to
   * exist without a handler for a while either way — and a returned unsubscribe is what lets a
   * mirror be disposed and rebuilt against a proxy that outlives it.
   */
  onPush(handler: WorkerPushHandler): () => void {
    this.#pushHandlers.add(handler);
    return () => {
      this.#pushHandlers.delete(handler);
    };
  }

  /**
   * Stops listening and settles what was in flight. Dropping the entries instead would leave
   * every caller awaiting a promise that nothing is left to resolve, which is a tab that closed
   * its database and then hung on the next query rather than reporting that it had.
   *
   * It also hands back every watch this tab still holds. The leader's host reference-counts its
   * registrations but only ever hears about a watch ending from an `unwatch`, so a follower that
   * simply went away would leave the worker re-running its statements after every mutation any tab
   * makes, forever. This covers the orderly exit — a `pagehide` handler calling `dispose`. It does
   * not cover a tab that crashes or is killed: nothing runs there to send anything, and the leader
   * has no liveness signal to notice it by. That leak is real and is left standing; the cost is a
   * SQLite query per mutation per abandoned statement, not incorrect results.
   */
  /**
   * Settles everything in flight, because the leader they were addressed to is gone.
   *
   * This is the other half of `MultiTabCoordinator.watchLeader`: a `BroadcastChannel` post is not a
   * connection, so nothing about a request tells the proxy that the tab it was posted to has died,
   * and without this a request issued a moment before the leader vanished stays pending for the
   * life of the page. Called with what the coordinator learned — never on a guess.
   *
   * The proxy stays usable. Leadership moving does not close the channel, and a successor is
   * already serving on it by the time this runs, so the tab re-hydrates through this same proxy
   * rather than building another.
   *
   * The watch counts go with the requests. They were references held by a host that no longer
   * exists; handing them back to the successor would decrement registrations it never made, and
   * keeping them would have a later `dispose` do exactly that.
   */
  failInFlight(reason = "the leader tab went away"): void {
    this.#watching.clear();
    const pending = [...this.#pending.keys()];
    for (const id of pending) this.#settle(id)?.reject(new Error(reason));
  }

  dispose(): void {
    for (const [cacheKey, count] of this.#watching) {
      // Once per outstanding watch, because the host counts them: a tab that watched a statement
      // twice and released it once released one reference, and only matching that leaves the count
      // where it would have been had the tab never existed.
      for (let index = 0; index < count; index += 1) this.#post({ type: "unwatch", cacheKey });
    }
    this.#watching.clear();
    this.channel.removeEventListener("message", this.#onMessage);
    this.#pushHandlers.clear();
    const pending = [...this.#pending.keys()];
    for (const id of pending) this.#settle(id)?.reject(new Error("the database proxy was disposed"));
  }

  /**
   * Takes a request out of the pending table and stops its deadline, if it is still there.
   *
   * Every path that settles a request goes through here, and that is what keeps a timer from
   * rejecting a request that was answered — and, under Node, from holding the loop open past the
   * answer it was waiting for.
   */
  #settle(
    id: number,
  ): { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void } | undefined {
    const entry = this.#pending.get(id);
    if (entry === undefined) return undefined;
    this.#pending.delete(id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    return entry;
  }

  /** Posts a request nobody is waiting on an answer to. Used only by `dispose`. */
  #post(message: WorkerRequestBody): void {
    const id = this.#nextId;
    this.#nextId += 1;
    this.channel.postMessage({ client: this.#client, request: withRequestId(id, message) } satisfies ProxyRequest);
  }

  #note(message: WorkerRequestBody): void {
    if (message.type === "watch") this.#watching.set(message.cacheKey, (this.#watching.get(message.cacheKey) ?? 0) + 1);
    else if (message.type === "unwatch") {
      const count = (this.#watching.get(message.cacheKey) ?? 0) - 1;
      if (count > 0) this.#watching.set(message.cacheKey, count);
      else this.#watching.delete(message.cacheKey);
    }
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    // Pushes first, and by their own guard: they are the one thing on this channel addressed to
    // nobody in particular, so the `client` test below would drop every one of them.
    if (isProxyPush(message)) {
      for (const handler of [...this.#pushHandlers]) handler(message.broadcast);
      return;
    }
    if (!isProxyResponse(message) || message.client !== this.#client) return;
    const { response } = message;
    const pending = this.#settle(response.id);
    if (pending === undefined) return;
    // The error crossed as text, because an `Error` does not survive a structured clone with its
    // prototype intact. Rebuilt here, so a caller sees the same rejection it would from a worker on
    // this thread.
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new Error(response.error));
  };
}

/**
 * What a leader runs a follower's request against.
 *
 * One method, not the three database verbs it used to name. A follower is now a full client of the
 * worker — it hydrates, mutates and watches through here — and enumerating seven methods would mean
 * every verb added to the protocol has to be added in three places and can be forgotten in one.
 * `OpfsWorkerTransport.request` has this exact signature, so a leader that already holds a transport
 * still passes it straight in; a test passes a double.
 */
export interface ProxyTarget {
  request(body: WorkerRequestBody): Promise<unknown>;
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

/** The running leader half. Both halves of what a leader does with the channel, in one handle. */
export interface BroadcastDbProxyServer {
  /**
   * Puts a worker push on the channel for every follower to apply.
   *
   * Called by the leader, not by this module: the responder is given a target it can ask things of,
   * and nothing that tells it when the worker volunteers something. Wiring it explicitly —
   * `transport.onPush((push) => server.relayPush(push))` — keeps the leader's one subscription to
   * its worker port visible where the leader is assembled, instead of having the responder reach
   * into a target it was only ever handed as a request sink.
   */
  relayPush(push: WorkerPush): void;
  /** Stops answering and stops relaying. */
  stop(): void;
}

/**
 * The leader half of `BroadcastDbProxy`: it takes what a follower puts on the channel, runs it
 * against the target, and addresses the reply back to the tab that asked. It also relays the
 * worker's unsolicited deltas to every tab, when the leader feeds them to `relayPush`.
 *
 * A reply produced after stopping is dropped rather than posted, and so is a push. Stopping is how
 * a tab abdicates, and an abdicated leader that still answers is the two-leader case `isLeader`
 * exists to prevent — a stale delta from the old leader's worker is that same case with rows in it.
 */
export function serveBroadcastDbProxy(options: BroadcastDbProxyServerOptions): BroadcastDbProxyServer {
  const { channel, target } = options;
  let serving = true;
  const leading = (): boolean => serving && (options.isLeader === undefined || options.isLeader());

  const reply = (client: string, response: WorkerResponse): void => {
    if (!serving) return;
    channel.postMessage({ client, response } satisfies ProxyResponse);
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    const envelope = event.data;
    // The guard is what keeps a leader from answering its own traffic: a `ProxyResponse` carries
    // `response` and a `ProxyPush` carries `broadcast` where a request carries `request`, and all
    // three ride the same channel.
    if (!isProxyRequest(envelope) || !leading()) return;
    const { id } = envelope.request;
    void target.request(envelope.request).then(
      (value) => {
        reply(envelope.client, { id, ok: true, value });
      },
      (error: unknown) => {
        reply(envelope.client, { id, ok: false, error: describeError(error) });
      },
    );
  };

  channel.addEventListener("message", onMessage);
  return {
    relayPush: (push) => {
      if (!leading()) return;
      channel.postMessage({ broadcast: push } satisfies ProxyPush);
    },
    stop: () => {
      serving = false;
      channel.removeEventListener("message", onMessage);
    },
  };
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
  return typeof request.type === "string" && REQUEST_TYPES.has(request.type);
}

/**
 * Every verb the protocol has, and the leader forwards all seven. The set stays because it is what
 * separates a request from noise: a message with a `type` nobody defined is somebody else's traffic
 * or a tab running a version this one does not speak, and running it against the worker would turn
 * either into an error the follower is left to interpret.
 */
const REQUEST_TYPES: ReadonlySet<string> = new Set<WorkerRequestBody["type"]>([
  "open",
  "execute",
  "close",
  "hydrate",
  "mutate",
  "watch",
  "unwatch",
]);

function isProxyResponse(value: unknown): value is ProxyResponse {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as { readonly client?: unknown; readonly response?: unknown };
  if (typeof envelope.client !== "string" || typeof envelope.response !== "object" || envelope.response === null)
    return false;
  const response = envelope.response as { readonly id?: unknown; readonly ok?: unknown };
  return typeof response.id === "number" && typeof response.ok === "boolean";
}

/**
 * A relayed delta. The inner `push: "delta"` is checked as well as the wrapper, because a follower
 * hands whatever comes out of here straight to a mirror that will start deleting rows by the keys
 * it names — so a message that merely happens to carry a field called `broadcast` must not get that
 * far.
 */
function isProxyPush(value: unknown): value is ProxyPush {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as { readonly broadcast?: unknown };
  if (typeof envelope.broadcast !== "object" || envelope.broadcast === null) return false;
  const push = envelope.broadcast as { readonly push?: unknown; readonly rows?: unknown; readonly removed?: unknown };
  return push.push === "delta" && Array.isArray(push.rows) && Array.isArray(push.removed);
}
