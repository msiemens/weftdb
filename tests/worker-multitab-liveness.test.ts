// §8.7 liveness: how a tab finds out that the tab holding the OPFS access handle is gone.
//
// The failure this covers is silent by construction. A dedicated worker dies with the document that
// created it, so when that tab closes, crashes or is killed, every other tab's port breaks and its
// mirror renders the rows it last held for ever — no error, no type error, and a request that was
// in flight at that moment never settles. So every assertion here is on something *happening*
// within a bound, and each test is written so that removing the mechanism it covers turns it red
// rather than slow.
//
// The mechanism is a Web Lock request made without `ifAvailable`. The browser answers it only when
// the lock is free, and the browser frees the lock when the holding tab dies — so a grant is a
// browser-guaranteed death notice with no timeout to tune. The half of this file that matters most
// is therefore the one asserting the *absence* of a signal: a leader inside a slow commit, and a
// tab throttled in the background, are alive, and a mechanism that called either of them dead would
// put two workers on one access handle, which is worse than the freeze it was trying to fix.
//
// What this file does *not* cover is what a tab then does about it — creating a worker, or asking
// the broker for a port to the tab that did, and reloading through it. That is the whole assembly
// and it is in `open-database.test.ts`, where the lock, the broker and the workers are all real.
// Nor does it cover how the *other* followers hear about a succession: the lock says nothing to
// them by design, and what tells them is the port broker (`worker-port-broker.test.ts`).
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import { MultiTabCoordinator, weftDatabaseKey, type LockManagerLike, type LockRequestOptionsLike } from "weftdb/client";
import { SCENARIO_RUNS } from "./property-model.ts";
import { delay, QueuedLocks, uniqueName, waitFor, outcome as settle } from "./multitab-fixtures.ts";

test("§8.7 a tab whose leader lets go of the lock is told, and takes over", async () => {
  // The signal itself: the tab holding the worker goes away, and another learns it from the lock
  // rather than from a timer. What the successor then does about it — create a worker and register
  // as the tab ports are delivered to — is `open-database.test.ts`; what is asserted here is that
  // exactly one tab is told to, and that it is told at all.
  const world = new TabWorld("succession");
  try {
    const leader = world.tab();
    const follower = world.tab();
    assert.equal(await leader.coordinator.elect(), "leader");
    assert.equal(await follower.coordinator.elect(), "follower");

    follower.watch();
    assert.deepEqual(world.locks.queued, [world.lockName], "the follower never stood in line for the lock");

    // What a tab closing looks like from the outside. A crash is covered separately; the lock
    // cannot tell them apart, which is exactly why it is the signal.
    leader.coordinator.close();

    await waitFor(() => follower.promotions > 0, "the follower was never told its leader had gone");
    assert.equal(follower.promotions, 1, "the follower was promoted more than once");
    assert.equal(follower.coordinator.role, "leader");

    // A tab opening after the succession elects against the successor's lock rather than the dead
    // tab's, so it is a follower — which is what makes the handover complete rather than merely
    // announced.
    const onlooker = world.tab();
    assert.equal(await onlooker.coordinator.elect(), "follower");
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
    follower.watch();
    // Guards the test against passing vacuously: a follower that never queued would also never
    // hear anything, and would prove nothing about false positives.
    assert.deepEqual(world.locks.queued, [world.lockName], "the follower never stood in line for the lock");

    // A request the leader's worker has taken and not answered — a long commit, or a tab the
    // browser has throttled. The tab is alive and holding the lock throughout.
    let answer: ((value: string) => void) | undefined;
    const pending = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const settled = settle(pending);

    // Long enough to be a person's whole patience, and far longer than any heartbeat interval that
    // would also have to sit above the slowest commit.
    await delay(300);
    assert.equal(follower.promotions, 0, "a busy leader was reported dead");
    assert.equal(follower.coordinator.role, "follower", "a follower promoted itself while its leader was alive");
    assert.equal(leader.coordinator.role, "leader", "the leader lost the lock it was still holding");
    assert.equal(await Promise.race([settled, delay(25).then(() => "pending" as const)]), "pending");

    // And the slow answer, when it comes, is an answer rather than a failure.
    answer?.("rows:select 1");
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
          () => racers.some((tab) => tab.promotions > 0),
          "no follower was ever told that leadership had moved",
        );
        await delay(25);

        const led = racers.filter((tab) => tab.coordinator.role === "leader");
        assert.equal(led.length, 1, "succession produced more than one leader");
        assert.equal(led[0]?.promotions, 1);
        // And the lock says nothing at all to the losers, which is exactly why the announcement
        // they do get is the broker's. They are not next in line, so the queue will never reach
        // them; a coordinator that promoted them here would be the second leader this whole design
        // is arranged to make impossible.
        for (const loser of racers.filter((tab) => tab !== led[0])) {
          assert.equal(loser.coordinator.role, "follower");
          assert.equal(loser.promotions, 0, "a losing follower was promoted by a succession it did not win");
        }
      } finally {
        world.close();
      }
    }),
    { numRuns: Math.min(SCENARIO_RUNS, 20) },
  );
});

test("§8.7 a follower that closes leaves the queue rather than inheriting the handle", async () => {
  // A tab that has gone must not be handed the lock: the successor is chosen by who is still in
  // line, and a closed coordinator holding it would strand the scope on a leader with no worker,
  // no connection to the broker and nobody to hand it on to.
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

    await waitFor(() => staying.promotions > 0, "the remaining follower never succeeded the leader");
    assert.equal(staying.coordinator.role, "leader");
    assert.equal(leaving.promotions, 0, "a closed tab was told it had become the leader");
    assert.notEqual(leaving.coordinator.role, "leader", "a closed tab took the OPFS access handle");
  } finally {
    world.close();
  }
});

test("§8.7 a lock manager that refuses a queued request has not made this tab the leader", async () => {
  // `null` is what `ifAvailable` answers with when the lock is busy, and a queued request is never
  // answered that way — but a shim, a polyfill, or a browser this library has not met might. Taking
  // it for a grant would put a second worker on the access handle on the strength of a value that
  // says the opposite, so it is checked rather than assumed.
  const coordinator = new MultiTabCoordinator({
    scopeId: uniqueName("scope-null-grant"),
    locks: new AlwaysBusyLocks(),
  });
  let promotions = 0;

  try {
    assert.equal(await coordinator.elect(), "follower");
    coordinator.onPromotion(() => {
      promotions += 1;
    });
    coordinator.watchLeader();
    await delay(50);

    assert.equal(coordinator.role, "follower", "a refused lock request promoted a tab to leader");
    assert.equal(promotions, 0, "a refused lock request was reported as succession");
  } finally {
    coordinator.close();
  }
});

/**
 * One scope's worth of tabs over one lock manager.
 *
 * Everything a tab needs is built together because the arrangement is the thing under test: tabs
 * that queued on different locks would pass a test about succession by never contending for
 * anything.
 */
class TabWorld {
  readonly scopeId: string;
  readonly locks = new QueuedLocks();
  readonly lockName: string;
  readonly #tabs: Tab[] = [];

  constructor(label: string) {
    this.scopeId = uniqueName(`scope-${label}`);
    // The name a coordinator composes for this database, written out because a world has to be able
    // to hold and kill the lock before any tab of it exists. A database is a namespace and a scope
    // together, and every tab here is in the default namespace.
    this.lockName = `weft:${weftDatabaseKey(this.scopeId)}:opfs`;
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

/** One tab: its coordinator, and every time it was granted the lock. */
class Tab {
  readonly coordinator: MultiTabCoordinator;
  /**
   * How many times this tab has been granted the lock. The signal under test, recorded rather than
   * polled.
   *
   * Only a grant lands here. The other tabs of a scope are told about a succession by the port
   * broker rather than by their coordinator, and `worker-port-broker.test.ts` is where that is
   * covered — what this file is about is that nothing but the lock ever reaches this counter.
   */
  promotions = 0;
  #closed = false;

  constructor(world: TabWorld) {
    this.coordinator = new MultiTabCoordinator({ scopeId: world.scopeId, locks: world.locks });
  }

  /**
   * What `openWeftDatabase` does: listen first, then queue. Registering afterwards would race a
   * succession that is granted in the same turn the previous leader lets go.
   */
  watch(): void {
    this.coordinator.onPromotion(() => {
      this.promotions += 1;
    });
    this.coordinator.watchLeader();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.coordinator.close();
  }
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
