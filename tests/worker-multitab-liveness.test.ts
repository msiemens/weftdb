// §8.7 liveness: how a follower finds out that the tab holding the OPFS access handle is gone.
//
// The failure this covers is silent by construction. A leader that closes, crashes or is killed
// stops relaying deltas, and a follower's mirror renders the rows it last held for ever — no error,
// no type error, and a request that was in flight at that moment never settles. So every assertion
// here is on something *happening* within a bound, and each test is written so that removing the
// mechanism it covers turns it red rather than slow.
//
// The mechanism is a Web Lock request made without `ifAvailable`. The browser answers it only when
// the lock is free, and the browser frees the lock when the holding tab dies — so a grant is a
// browser-guaranteed death notice with no timeout to tune. The half of this file that matters most
// is therefore the one asserting the *absence* of a signal: a leader inside a slow commit, and a
// tab throttled in the background, are alive, and a mechanism that called either of them dead would
// put two workers on one access handle, which is worse than the freeze it was trying to fix.
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import {
  BroadcastDbProxy,
  MultiTabCoordinator,
  serveBroadcastDbProxy,
  type BroadcastDbProxyServer,
  type LockManagerLike,
  type LockRequestOptionsLike,
  type ProxyTarget,
  type TabRole,
  type WorkerRequestBody,
} from "weftdb/client";
import { SCENARIO_RUNS } from "./property-model.ts";

test("§8.7 a follower whose leader lets go of the lock is told, takes over, and serves", async () => {
  // The whole recovery in one arrangement: the leader goes away, the follower learns it from the
  // lock rather than from a timer, and the tab that won stands up a responder that a third tab's
  // proxy can actually get an answer out of. Asserting only on the role would pass for a tab that
  // called itself the leader and served nobody, which is the same freeze with a different banner.
  const world = new TabWorld("succession");
  try {
    const leader = world.tab();
    const follower = world.tab();
    assert.equal(await leader.coordinator.elect(), "leader");
    assert.equal(await follower.coordinator.elect(), "follower");
    leader.serve();

    follower.watch();
    assert.deepEqual(world.locks.queued, [world.lockName], "the follower never stood in line for the lock");

    // What a tab closing looks like from the outside. A crash is covered separately; the lock
    // cannot tell them apart, which is exactly why it is the signal.
    leader.coordinator.close();

    await waitFor(() => follower.roles.length > 0, "the follower was never told its leader had gone");
    assert.deepEqual(follower.roles, ["leader"], "the follower was told the wrong thing");
    assert.equal(follower.coordinator.role, "leader");

    // And it serves. The successor's responder is started from the listener, which is how the
    // integration is meant to be wired.
    const onlooker = world.tab();
    assert.equal(await onlooker.coordinator.elect(), "follower");
    assert.equal(
      await onlooker.proxy.request({ type: "execute", query: { sql: "select 1", parameters: [] } }),
      "rows:select 1",
    );
    assert.deepEqual(
      follower.target.calls,
      ["execute:select 1"],
      "the successor answered without touching its database",
    );
  } finally {
    world.close();
  }
});

test("§8.7 a request in flight when the leader vanishes rejects rather than hanging for ever", async () => {
  // The defect this file exists for. A BroadcastChannel post is not a connection, so nothing about
  // an unanswered request says whether the tab it went to is thinking or gone. The bound is what
  // is asserted: the request has to settle, and it has to settle as a rejection — resolving it
  // would tell a mutator that a write nobody performed had succeeded.
  const world = new TabWorld("in-flight");
  try {
    const leader = world.tab();
    const follower = world.tab();
    assert.equal(await leader.coordinator.elect(), "leader");
    assert.equal(await follower.coordinator.elect(), "follower");
    // A target that never answers: the leader took the request and then its tab died with it.
    leader.serve({ answer: "never" });
    follower.watch();

    const pending = follower.proxy.request({ type: "hydrate", scopeId: "scope-1", deviceId: "device-1" });
    const settled = settle(pending);
    await waitFor(() => leader.target.calls.length === 1, "the leader never began the request");

    // Killed rather than closed: nothing runs in a tab that crashes, so the coordinator never gets
    // to release anything and the browser hands the lock on by itself.
    world.locks.kill(world.lockName);

    assert.equal(
      await Promise.race([settled, delay(500).then(() => "pending" as const)]),
      "rejected",
      "a request in flight when the leader vanished never settled",
    );
    await assert.rejects(pending, /leader/u, "the rejection did not say the leader had gone");
  } finally {
    world.close();
  }
});

test("§8.7 a leader that is merely slow is alive, and nothing says otherwise", async () => {
  // The false positive that would be worse than the bug. A slow SQLite commit and a tab throttled
  // in the background both look exactly like a dead leader to anything counting elapsed time, and
  // a follower that concluded death from either would open a second worker on the one OPFS access
  // handle. Nothing here answers within the window, and nothing may be concluded from that.
  const world = new TabWorld("slow-leader");
  try {
    const leader = world.tab();
    const follower = world.tab();
    assert.equal(await leader.coordinator.elect(), "leader");
    assert.equal(await follower.coordinator.elect(), "follower");
    leader.serve({ answer: "deferred" });
    follower.watch();
    // Guards the test against passing vacuously: a follower that never queued would also never
    // hear anything, and would prove nothing about false positives.
    assert.deepEqual(world.locks.queued, [world.lockName], "the follower never stood in line for the lock");

    const pending = follower.proxy.request({ type: "execute", query: { sql: "select 1", parameters: [] } });
    const settled = settle(pending);
    await waitFor(() => leader.target.calls.length === 1, "the leader never began the request");

    // Long enough to be a person's whole patience, and far longer than any heartbeat interval that
    // would also have to sit above the slowest commit.
    await delay(300);
    assert.deepEqual(follower.roles, [], "a busy leader was reported dead");
    assert.equal(follower.coordinator.role, "follower", "a follower promoted itself while its leader was alive");
    assert.equal(leader.coordinator.role, "leader", "the leader lost the lock it was still holding");
    assert.equal(await Promise.race([settled, delay(25).then(() => "pending" as const)]), "pending");

    // And the slow answer, when it comes, is an answer.
    leader.target.answerNow();
    assert.equal(await pending, "rows:select 1", "the slow request did not settle with what the leader computed");
  } finally {
    world.close();
  }
});

test("§8.7 however many followers race to succeed one dead leader, exactly one leads", async () => {
  // Succession is the moment two tabs could both conclude they lead, and a second leader is a
  // second worker contending for one access handle. Nothing here agrees about anything: every
  // follower queues on the same lock and the browser hands it to one of them, so the property is
  // over the number of racers rather than over one arrangement of two.
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 5 }), async (followers) => {
      const world = new TabWorld(`race-${followers}`);
      try {
        const leader = world.tab();
        assert.equal(await leader.coordinator.elect(), "leader");
        const racers: Tab[] = [];
        for (let index = 0; index < followers; index += 1) {
          const tab = world.tab();
          assert.equal(await tab.coordinator.elect(), "follower");
          tab.watch();
          racers.push(tab);
        }

        world.locks.kill(world.lockName);
        await waitFor(
          () => racers.every((tab) => tab.roles.length > 0),
          "some follower was never told that leadership had moved",
        );
        await delay(25);

        const led = racers.filter((tab) => tab.coordinator.role === "leader");
        assert.equal(led.length, 1, "succession produced more than one leader");
        assert.deepEqual(led[0]?.roles, ["leader"]);
        // The losers are the reason the successor says so on the channel. They are not next in
        // line, so the lock will never tell them anything, and without the announcement they would
        // sit on a proxy pointed at a tab that no longer exists.
        for (const loser of racers.filter((tab) => tab !== led[0])) {
          assert.equal(loser.coordinator.role, "follower");
          assert.deepEqual(loser.roles, ["follower"], "a losing follower was not told leadership had moved");
        }
      } finally {
        world.close();
      }
    }),
    { numRuns: Math.min(SCENARIO_RUNS, 20) },
  );
});

test("§8.7 a losing follower settles what it had in flight with the leader that died", async () => {
  // The loser's requests were addressed to the dead tab as surely as the winner's, and the lock is
  // never going to tell it anything — it is not next in line. What reaches it is the successor's
  // announcement, and `failInFlight` is what it does with it.
  const world = new TabWorld("loser-in-flight");
  try {
    const leader = world.tab();
    const first = world.tab();
    const second = world.tab();
    assert.equal(await leader.coordinator.elect(), "leader");
    assert.equal(await first.coordinator.elect(), "follower");
    assert.equal(await second.coordinator.elect(), "follower");
    leader.serve({ answer: "never" });
    first.watch();
    second.watch();

    const pendings = [first, second].map((tab) => {
      const promise = tab.proxy.request({ type: "close" });
      return { tab, promise, settled: settle(promise) };
    });
    await waitFor(() => leader.target.calls.length === 2, "the leader never began both requests");

    world.locks.kill(world.lockName);
    await waitFor(() => pendings.every((entry) => entry.tab.roles.length > 0), "a follower heard nothing");

    for (const entry of pendings) {
      assert.equal(
        await Promise.race([entry.settled, delay(500).then(() => "pending" as const)]),
        "rejected",
        "a request outstanding with the dead leader never settled",
      );
      await assert.rejects(entry.promise, /leader/u);
    }
  } finally {
    world.close();
  }
});

test("§8.7 a follower that closes leaves the queue rather than inheriting the handle", async () => {
  // A tab that has gone must not be handed the lock: the successor is chosen by who is still in
  // line, and a closed coordinator holding it would strand the scope on a leader with no worker,
  // no channel and nobody to hand it on to.
  const world = new TabWorld("leaves-queue");
  try {
    const leader = world.tab();
    const leaving = world.tab();
    const staying = world.tab();
    assert.equal(await leader.coordinator.elect(), "leader");
    assert.equal(await leaving.coordinator.elect(), "follower");
    assert.equal(await staying.coordinator.elect(), "follower");
    leaving.watch();
    staying.watch();

    leaving.coordinator.close();
    world.locks.kill(world.lockName);

    await waitFor(() => staying.roles.length > 0, "the remaining follower never succeeded the leader");
    assert.equal(staying.coordinator.role, "leader");
    assert.deepEqual(leaving.roles, [], "a closed tab was told it had become the leader");
    assert.notEqual(leaving.coordinator.role, "leader", "a closed tab took the OPFS access handle");
  } finally {
    world.close();
  }
});

test("§8.7 leadership is concluded from the lock alone, never from a message on the channel", async () => {
  // The announcement exists to tell losers that leadership moved, and it must be able to do no
  // more than that. A tab that promoted itself on hearing one would be promotable by any peer —
  // including a stale post from a tab that has since lost the lock — which is the two-leader case
  // the whole design is arranged to make impossible.
  const world = new TabWorld("announcement-is-not-a-grant");
  try {
    const leader = world.tab();
    const follower = world.tab();
    assert.equal(await leader.coordinator.elect(), "leader");
    assert.equal(await follower.coordinator.elect(), "follower");
    follower.watch();

    const impostor = new BroadcastChannel(world.coordinatorChannelName);
    try {
      impostor.postMessage({ weft: "leader", scopeId: world.scopeId });
      impostor.postMessage({ weft: "leader", scopeId: "some-other-scope" });
      impostor.postMessage("not an announcement at all");
      await waitFor(() => follower.roles.length > 0, "the follower never heard the announcement");
      await delay(50);

      assert.deepEqual(follower.roles, ["follower"], "an announcement moved a tab to a role the lock had not given it");
      assert.equal(follower.coordinator.role, "follower");
      assert.equal(leader.coordinator.role, "leader", "the tab actually holding the lock lost it to a message");
    } finally {
      impostor.close();
    }
  } finally {
    world.close();
  }
});

test("§8.7 a lock manager that refuses a queued request has not made this tab the leader", async () => {
  // `null` is what `ifAvailable` answers with when the lock is busy, and a queued request is never
  // answered that way — but a shim, a polyfill, or a browser this library has not met might. Taking
  // it for a grant would put a second worker on the access handle on the strength of a value that
  // says the opposite, so it is checked rather than assumed.
  const scopeId = uniqueName("scope-null-grant");
  const channel = new BroadcastChannel(`weft:${scopeId}`);
  const heard = new BroadcastChannel(`weft:${scopeId}`);
  const announcements: unknown[] = [];
  heard.addEventListener("message", (event: MessageEvent<unknown>) => announcements.push(event.data));
  const coordinator = new MultiTabCoordinator({ scopeId, locks: new AlwaysBusyLocks(), channel });
  const roles: TabRole[] = [];

  try {
    assert.equal(await coordinator.elect(), "follower");
    coordinator.onLeadershipChange((role) => roles.push(role));
    coordinator.watchLeader();
    await delay(50);

    assert.equal(coordinator.role, "follower", "a refused lock request promoted a tab to leader");
    assert.deepEqual(roles, [], "a refused lock request was reported as succession");
    assert.deepEqual(announcements, [], "a tab that holds no lock told the scope it was leading");
  } finally {
    coordinator.close();
    heard.close();
  }
});

test("§8.7 a request deadline is opt-in, and does not fire for an answer that arrived", async () => {
  // Not the liveness mechanism, and the default proves it: a proxy given no deadline waits, because
  // the library has no way to know how long this application's slowest commit takes. The deadline
  // is for the one thing the lock cannot see — a leader that is alive and holding the lock while
  // its worker is wedged — and choosing the number is the application's.
  const channelName = uniqueName("weft-deadline");
  const patientChannel = new BroadcastChannel(channelName);
  const impatientChannel = new BroadcastChannel(channelName);
  const answeringChannel = new BroadcastChannel(channelName);
  const patient = new BroadcastDbProxy(patientChannel);
  const impatient = new BroadcastDbProxy(impatientChannel, { requestTimeoutMs: 40 });
  const target = new RecordingTarget();
  const server = serveBroadcastDbProxy({ channel: answeringChannel, target });

  try {
    target.answer = "never";
    const patientPending = settle(patient.request({ type: "close" }));
    const impatientPending = settle(impatient.request({ type: "close" }));

    // Raced rather than awaited outright. A deadline that never fires would leave a bare `await`
    // pending for the whole file's timeout, which is a hang rather than a failure — and a hang is
    // the very shape of the defect this file exists to catch, so no test in it may produce one.
    assert.equal(
      await Promise.race([impatientPending, delay(400).then(() => "pending" as const)]),
      "rejected",
      "a request with a deadline waited past it",
    );
    assert.equal(
      await Promise.race([patientPending, delay(120).then(() => "pending" as const)]),
      "pending",
      "a request with no deadline invented one",
    );

    // And an answered request keeps its answer: a deadline that fired anyway would turn a slow but
    // successful commit into a reported failure.
    target.answer = "immediate";
    assert.equal(
      await impatient.request({ type: "execute", query: { sql: "select 2", parameters: [] } }),
      "rows:select 2",
    );
    await delay(80);
  } finally {
    server.stop();
    patient.dispose();
    impatient.dispose();
    patientChannel.close();
    impatientChannel.close();
    answeringChannel.close();
  }
});

test("§8.7 failing in flight hands nothing back to a leader that never registered it", async () => {
  // The watches a follower is counting were references held by a host that has gone. Handing them
  // to the successor would decrement registrations it never made — retiring a statement another
  // tab is still reading — so they are dropped with the requests rather than replayed.
  const channelName = uniqueName("weft-fail-watches");
  const followerChannel = new BroadcastChannel(channelName);
  const leaderChannel = new BroadcastChannel(channelName);
  const proxy = new BroadcastDbProxy(followerChannel);
  const target = new RecordingTarget();
  const server = serveBroadcastDbProxy({ channel: leaderChannel, target });

  try {
    const query = { sql: "select 1", parameters: [] };
    await proxy.request({ type: "watch", cacheKey: "todos:all", tableName: "todos", query });
    proxy.failInFlight();
    proxy.dispose();
    await delay(50);

    assert.deepEqual(target.calls, ["watch:todos:all"], "a follower handed a dead leader's watches to its successor");
  } finally {
    server.stop();
    proxy.dispose();
    followerChannel.close();
    leaderChannel.close();
  }
});

/**
 * One scope's worth of tabs over one lock manager and one pair of channel names.
 *
 * Everything a tab needs is built together because the arrangement is the thing under test: a
 * coordinator whose channel nobody else is on hears no announcements, and a proxy on a different
 * channel from the responder is the composition mistake `openWeftDatabase` exists to remove.
 */
class TabWorld {
  readonly scopeId: string;
  readonly locks = new QueuedLocks();
  readonly coordinatorChannelName: string;
  readonly dbChannelName: string;
  readonly lockName: string;
  readonly #tabs: Tab[] = [];

  constructor(label: string) {
    this.scopeId = uniqueName(`scope-${label}`);
    this.coordinatorChannelName = `weft:${this.scopeId}`;
    this.dbChannelName = `weft:${this.scopeId}:db`;
    this.lockName = `weft:${this.scopeId}:opfs`;
  }

  tab(): Tab {
    const tab = new Tab(this);
    this.#tabs.push(tab);
    return tab;
  }

  close(): void {
    for (const tab of this.#tabs) tab.close();
  }
}

/** One tab: its coordinator, its proxy, and whatever it stood up on becoming the leader. */
class Tab {
  readonly coordinator: MultiTabCoordinator;
  readonly proxy: BroadcastDbProxy;
  readonly target = new RecordingTarget();
  /** Every role this tab was told it had, in order. The signal under test, recorded rather than polled. */
  readonly roles: TabRole[] = [];
  readonly #dbChannel: BroadcastChannel;
  #server: BroadcastDbProxyServer | undefined;
  #closed = false;

  constructor(world: TabWorld) {
    this.coordinator = new MultiTabCoordinator({
      scopeId: world.scopeId,
      locks: world.locks,
      channel: new BroadcastChannel(world.coordinatorChannelName),
    });
    this.#dbChannel = new BroadcastChannel(world.dbChannelName);
    this.proxy = new BroadcastDbProxy(this.#dbChannel);
  }

  /**
   * What `openWeftDatabase` will do: listen first, then queue. Registering afterwards would race a
   * succession that is granted in the same turn the previous leader lets go.
   */
  watch(): void {
    this.coordinator.onLeadershipChange((role) => {
      this.roles.push(role);
      // Both roles mean the same thing about what was outstanding: the tab it was addressed to is
      // gone. Only one of them also means this tab now holds the handle.
      this.proxy.failInFlight();
      if (role === "leader") this.serve();
    });
    this.coordinator.watchLeader();
  }

  serve(options: { readonly answer?: RecordingAnswer } = {}): void {
    if (options.answer !== undefined) this.target.answer = options.answer;
    this.#server ??= serveBroadcastDbProxy({
      channel: this.#dbChannel,
      target: this.target,
      isLeader: () => this.coordinator.role === "leader" || this.coordinator.role === "degraded",
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#server?.stop();
    this.proxy.dispose();
    this.coordinator.close();
    this.#dbChannel.close();
  }
}

type RecordingAnswer = "immediate" | "deferred" | "never";

/** A leader-side target whose answers can be withheld, so "slow" and "gone" can be told apart. */
class RecordingTarget implements ProxyTarget {
  readonly calls: string[] = [];
  answer: RecordingAnswer = "immediate";
  readonly #deferred: Array<() => void> = [];

  request(body: WorkerRequestBody): Promise<unknown> {
    this.calls.push(describe(body));
    const value = answerFor(body);
    if (this.answer === "immediate") return Promise.resolve(value);
    // "never" and "deferred" are the same promise; the difference is only whether a test ever
    // reaches in and settles it.
    return new Promise((resolve) => {
      this.#deferred.push(() => {
        resolve(value);
      });
    });
  }

  answerNow(): void {
    const waiting = [...this.#deferred];
    this.#deferred.length = 0;
    for (const settleOne of waiting) settleOne();
  }
}

function describe(body: WorkerRequestBody): string {
  switch (body.type) {
    case "execute":
      return `execute:${body.query.sql}`;
    case "watch":
      return `watch:${body.cacheKey}`;
    case "unwatch":
      return `unwatch:${body.cacheKey}`;
    case "hydrate":
      return `hydrate:${body.scopeId}`;
    case "open":
      return `open:${body.scopeId}`;
    default:
      return body.type;
  }
}

function answerFor(body: WorkerRequestBody): unknown {
  switch (body.type) {
    case "execute":
      return `rows:${body.query.sql}`;
    case "hydrate":
      return { rows: [], removed: [], results: [] };
    case "watch":
      return [`id-for:${body.cacheKey}`];
    default:
      return "closed";
  }
}

/**
 * Web Locks as this feature depends on them, which is more than the older fakes model: one holder
 * at a time, a *queue* of blocking waiters served in order, a release that hands the lock straight
 * to whoever is next, and a way to take the lock off a holder that never gave it back.
 *
 * That last part is the whole point. A tab that crashes runs no code — its coordinator never
 * releases anything — and the browser hands the lock on regardless. `kill` is that, and it is what
 * separates this fake from `ExclusiveLocks`, which can only model an orderly exit.
 */
class QueuedLocks implements LockManagerLike {
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

/** A lock manager that answers every request, queued or not, the way `ifAvailable` answers a busy lock. */
class AlwaysBusyLocks implements LockManagerLike {
  async request<T>(
    _name: string,
    _options: LockRequestOptionsLike,
    callback: (lock: object | null) => T | Promise<T>,
  ): Promise<T> {
    return callback(null);
  }
}

/** How a promise settled, as a value, so a test can race it against a deadline without hanging. */
function settle(promise: Promise<unknown>): Promise<"resolved" | "rejected"> {
  return promise.then(
    () => "resolved" as const,
    () => "rejected" as const,
  );
}

async function waitFor(condition: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Math.trunc(performance.now() * 1000)}-${Math.trunc(Math.random() * 1e6)}`;
}
