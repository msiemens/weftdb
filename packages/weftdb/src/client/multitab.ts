// Which tab of an origin holds the storage worker.
//
// Nothing about the *data path* is here. A tab that is not the leader reaches the worker over a
// `MessagePort` of its own (see `./broker.ts`), so there is no proxy to run and no traffic to relay.
// What is left is the one question a port cannot answer: only one document may hold the OPFS
// synchronous access handle, so exactly one tab may create the worker, and when that tab goes
// exactly one other must take over. That is a Web Lock, and this is it.
//
// Telling the *other* tabs is not here either. A Web Lock grant reaches the next waiter and nobody
// else, so the tabs further back in the queue need to hear about a succession from somewhere; they
// hear it from the broker, which holds a connection to every tab of the origin and which a successor
// must register with before it can serve anyone. This file speaks to no other tab at all.
//
// The election itself does not move, and must not. The broker sees a connection close but cannot
// tell a tab that has gone from one the browser has frozen, and treating the second as the first is
// how two documents come to hold one OPFS access handle. A browser-owned lock is released on a
// crash; a connection is not evidence.
//
// There is no third state for a browser that has no Web Locks. Web Locks is available strictly
// earlier than everything else this design needs — Safari 15.4, against 16.4 for `SharedWorker` and
// 17 for OPFS synchronous access handles — so a browser that can hold the database at all can hold
// the lock, and one that cannot is refused at the front door (see `openWeftDatabase`) rather than
// run without an election.
//
// One lock per database, and a database is a namespace and a scope together (see
// `./database-key.ts`). Two scopes elect separately because they are two databases; so do two
// namespaces of one scope, which is one browser running two applications over one origin.
import { weftDatabaseKey } from "./database-key.ts";

export type TabRole = "leader" | "follower";

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
  /**
   * Which application in this origin the scope belongs to. `"weft"` by default, and part of the
   * lock's name: an election is per database, and a database is this and the scope together.
   */
  readonly namespace?: string;
  /** Required: there is no election without one, and no tab may create a worker without an election. */
  readonly locks: LockManagerLike;
}

/**
 * Told to this tab, and to this tab alone, when the browser grants it the lock it was standing in
 * line for. It takes no argument because there is only one thing it can mean.
 *
 * The other tabs of the scope are told nothing from here. They need to hear about a succession —
 * the worker they were talking to died with the document that created it — but that is a message,
 * and a message may never be the reason a tab believes it leads. So it travels the one path that
 * cannot be mistaken for a grant: the successor registers with the port broker, and the broker tells
 * every tab connected to it that somebody new is providing (see `WeftBrokerClient.onProvider`).
 * Only the lock promotes, and only the lock is here.
 */
export type LeadershipListener = () => void;

export class MultiTabCoordinator {
  readonly scopeId: string;
  /**
   * The Web Lock this election runs on, `weft:<database key>:opfs`.
   *
   * Composed once here rather than at each request, and named on the instance because it is the one
   * thing about a coordinator another party may need to say out loud — a diagnostic, or a test
   * arranging a lock that is already held.
   */
  readonly lockName: string;
  readonly locks: LockManagerLike;
  /** A tab leads only once the browser has granted it the lock, so this is where every tab starts. */
  role: TabRole = "follower";
  /** Resolved to hand the lock back; held for as long as this tab is the leader. */
  #release: (() => void) | undefined;
  /** Aborts the queued succession request, so a tab that closes stops standing in line. */
  #standby: AbortController | undefined;
  readonly #listeners = new Set<LeadershipListener>();
  #closed = false;

  constructor(options: MultiTabOptions) {
    this.scopeId = options.scopeId;
    this.lockName = `weft:${weftDatabaseKey(options.scopeId, options.namespace)}:opfs`;
    this.locks = options.locks;
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
    if (this.role === "leader") return this.role;
    const locks = this.locks;
    return new Promise<TabRole>((resolveRole, rejectRole) => {
      const held = locks.request(this.lockName, { ifAvailable: true }, (lock) => {
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
   * Registers a listener for this tab being granted the lock, and returns a way to stop listening.
   *
   * Register before calling `watchLeader`: succession can be granted in the same turn the previous
   * leader lets go, and a listener attached afterwards would miss the one event it exists for.
   */
  onPromotion(listener: LeadershipListener): () => void {
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
   * That is why it is a queued lock rather than a heartbeat between tabs. A heartbeat needs an
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
   * Idempotent, and a no-op for a tab that already leads.
   */
  watchLeader(): void {
    if (this.#closed) return;
    if (this.role !== "follower") return;
    if (this.#standby !== undefined) return;
    const controller = new AbortController();
    this.#standby = controller;
    const locks = this.locks;
    const held = locks.request(this.lockName, { signal: controller.signal }, (lock) => {
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
    // Back to where every tab starts. This tab holds nothing now, and a page reading the role on
    // its way out is told what is true rather than what was.
    this.role = "follower";
    // A tab that is closing has no use for its own listeners, and telling them leadership had moved
    // would have the page rebuild itself on the way out.
    this.#listeners.clear();
  }

  /**
   * Takes over from a leader that has gone.
   *
   * All of it is the lock, and that is the whole point. This tab leads because the browser handed
   * it the lock, which it does for one waiter at a time and only once the previous holder's
   * document is gone — no agreement between tabs, nothing to time out, and nothing a peer could
   * say that would produce the same effect.
   *
   * The other followers still have to hear that their worker died, and they hear it from the
   * broker once this tab registers as the new provider. That path is deliberately incapable of
   * promoting anybody: it carries "somebody else is serving now", which costs a tab a reconnect and
   * a re-hydrate, and there is no message anywhere that means "you are the leader".
   */
  #succeed(): void {
    this.role = "leader";
    for (const listener of [...this.#listeners]) listener();
  }
}
