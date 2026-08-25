// The transport layer under §8.7: the worker boundary, the follower-to-leader proxy, and
// Web Locks leader election. These are all correlation and lifetime problems — a reply must
// reach the request that asked for it, and nothing may be left pending when a tab dies — so
// they are checked against generated interleavings rather than one happy path each.
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import {
  BroadcastDbProxy,
  isDeltaPush,
  MultiTabCoordinator,
  OpfsWorkerTransport,
  serveBroadcastDbProxy,
  type LockManagerLike,
  type MirrorTransport,
  type ProxyPush,
  type ProxyRequest,
  type ProxyTarget,
  type TabRole,
  type WorkerPush,
  type WorkerRequest,
  type WorkerRequestBody,
  type WorkerResponse,
} from "weftdb/client";
import { PROPERTY_RUNS, SCENARIO_RUNS } from "./property-model.ts";

test("§8 the worker transport correlates replies to requests, whatever order they arrive in", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 8 }),
      fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 8, maxLength: 8 }),
      async (payloads, keys) => {
        const worker = new DeferredWorker();
        const transport = new OpfsWorkerTransport(worker);
        const pending = payloads.map((payload) => transport.execute({ sql: payload, parameters: [] }));

        // The worker answers in a generated order, so a transport that matched replies by
        // arrival rather than by id would hand back another request's result.
        for (const request of permute(worker.received, keys)) {
          worker.reply(request.id, `result:${sqlOf(request)}`);
        }

        assert.deepEqual(
          await Promise.all(pending),
          payloads.map((payload) => `result:${payload}`),
        );
        transport.dispose();
      },
    ),
    { numRuns: Math.min(PROPERTY_RUNS, 200) },
  );
});

test("§8 a worker error rejects only the request it belongs to", async () => {
  const worker = new DeferredWorker();
  const transport = new OpfsWorkerTransport(worker);
  const failing = transport.execute({ sql: "boom", parameters: [] });
  const succeeding = transport.execute({ sql: "fine", parameters: [] });

  const [first, second] = worker.received;
  if (first === undefined || second === undefined) throw new Error("the worker never received the requests");
  worker.fail(first.id, "disk is on fire");
  worker.reply(second.id, "ok");

  await assert.rejects(failing, /disk is on fire/u);
  assert.equal(await succeeding, "ok");
  transport.dispose();
});

test("§8 disposing the transport rejects everything still in flight", async () => {
  const worker = new DeferredWorker();
  const transport = new OpfsWorkerTransport(worker);
  const pending = [transport.open("scope"), transport.execute({ sql: "select 1", parameters: [] })];

  transport.dispose();

  for (const promise of pending) await assert.rejects(promise, /disposed/u);
  // A late reply after disposal must not throw into the void.
  const [first] = worker.received;
  if (first !== undefined) worker.reply(first.id, "too late");
  assert.equal(worker.listeners, 0, "the transport left a listener attached");
});

test("§8.7 the follower proxy correlates replies and ignores traffic that is not its own", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 6 }),
      fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 8, maxLength: 8 }),
      async (count, keys) => {
        const channelName = `weft-proxy-${count}-${keys[0] ?? 0}-${Math.trunc(performance.now() * 1000)}`;
        const followerChannel = new BroadcastChannel(channelName);
        const leaderChannel = new BroadcastChannel(channelName);
        const proxy = new BroadcastDbProxy(followerChannel);
        const seen: ProxyRequest[] = [];

        // An open BroadcastChannel keeps Node's event loop alive, so a failing run that skipped
        // the close would hang the whole file rather than report a failure.
        try {
          leaderChannel.addEventListener("message", (event: MessageEvent<ProxyRequest>) => {
            seen.push(event.data);
          });

          const pending = Array.from({ length: count }, () => proxy.request({ type: "close" }));
          await waitFor(() => seen.length === count, "the leader never received the proxied requests");

          const client = seen[0]?.client ?? "";
          // Noise on the same channel: a reply for an id nobody asked about, and one addressed to
          // a tab that is not this one.
          leaderChannel.postMessage({ client, response: { id: 9_999, ok: true, value: "not yours" } });
          leaderChannel.postMessage({
            client: "another-tab",
            response: { id: 1, ok: true, value: "not yours either" },
          });
          for (const envelope of permute(
            seen.map((entry) => entry.request),
            keys,
          )) {
            leaderChannel.postMessage({
              client,
              response: { id: envelope.id, ok: true, value: `answer:${envelope.id}` } satisfies WorkerResponse,
            });
          }

          const answers = await Promise.all(pending);
          assert.deepEqual(
            answers,
            seen.map((entry) => `answer:${entry.request.id}`),
            "a reply reached the wrong request",
          );
        } finally {
          proxy.dispose();
          followerChannel.close();
          leaderChannel.close();
        }
      },
    ),
    { numRuns: Math.min(SCENARIO_RUNS, 40) },
  );
});

test("§8.7 follower proxies ignore peer requests with colliding ids", async () => {
  // Every tab on the channel hears every message, and two followers both counting their requests
  // from one issue the same ids. A proxy that matched on the id alone would answer to its peer's
  // traffic: a request would settle as if it were a reply, and the leader's reply to one tab
  // would settle the other's.
  const channelName = `weft-proxy-peer-${Math.trunc(performance.now() * 1000)}`;
  const firstChannel = new BroadcastChannel(channelName);
  const secondChannel = new BroadcastChannel(channelName);
  const leaderChannel = new BroadcastChannel(channelName);
  const first = new BroadcastDbProxy(firstChannel);
  const second = new BroadcastDbProxy(secondChannel);

  const seen: ProxyRequest[] = [];
  leaderChannel.addEventListener("message", (event: MessageEvent<ProxyRequest>) => {
    if (!("request" in event.data)) return;
    seen.push(event.data);
    leaderChannel.postMessage({
      client: event.data.client,
      response: { id: event.data.request.id, ok: true, value: `answer:${seen.length}` },
    });
  });

  try {
    const firstPending = first.request({ type: "close" });
    const answers = [await firstPending, await second.request({ type: "close" })];

    assert.deepEqual(
      seen.map((envelope) => envelope.request.id),
      [1, 1],
      "the two followers did not collide on an id",
    );
    assert.notEqual(seen[0]?.client, seen[1]?.client, "two proxies shared a client id");
    assert.deepEqual(answers, ["answer:1", "answer:2"], "a proxy resolved from another follower's traffic");
  } finally {
    first.dispose();
    second.dispose();
    firstChannel.close();
    secondChannel.close();
    leaderChannel.close();
  }
});

test("§8.7 disposing the follower proxy rejects everything still in flight", async () => {
  const channel = new BroadcastChannel(`weft-proxy-dispose-${Math.trunc(performance.now() * 1000)}`);
  const proxy = new BroadcastDbProxy(channel);

  try {
    const pending = proxy.request({ type: "close" });
    proxy.dispose();

    const result = await Promise.race([
      pending.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      delay(25).then(() => "timeout" as const),
    ]);
    assert.equal(result, "rejected", "disposing the proxy left an in-flight request pending");
  } finally {
    proxy.dispose();
    channel.close();
  }
});

test("§8.7 exactly one tab holds the handle, and succession is exclusive too", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (tabs) => {
      const locks = new ExclusiveLocks();
      const coordinators = Array.from(
        { length: tabs },
        (_, index) =>
          new MultiTabCoordinator({ scopeId: "tabs", locks, channel: new BroadcastChannel(`weft-tabs-${index}`) }),
      );

      try {
        const roles: TabRole[] = [];
        for (const coordinator of coordinators) roles.push(await coordinator.elect());
        assert.equal(roles.filter((role) => role === "leader").length, 1, "leadership was not exclusive");
        assert.equal(roles.filter((role) => role === "follower").length, tabs - 1);

        // Re-electing while the leader is alive must not produce a second leader.
        const reElected: TabRole[] = [];
        for (const coordinator of coordinators.slice(1)) reElected.push(await coordinator.elect());
        assert.equal(
          reElected.every((role) => role === "follower"),
          true,
          "a second tab took the handle",
        );

        locks.releaseAll();
        const successors: TabRole[] = [];
        for (const coordinator of coordinators.slice(1)) successors.push(await coordinator.elect());
        assert.equal(successors.filter((role) => role === "leader").length, 1, "succession was not exclusive");
      } finally {
        for (const coordinator of coordinators) coordinator.close();
      }
    }),
    { numRuns: Math.min(SCENARIO_RUNS, 25) },
  );
});

test("§8.7 leadership stays exclusive under Web Locks callback lifetime semantics", async () => {
  const locks = new ReleasingLocks();
  const first = new MultiTabCoordinator({
    scopeId: "web-locks",
    locks,
    channel: new BroadcastChannel("weft-web-locks-a"),
  });
  const second = new MultiTabCoordinator({
    scopeId: "web-locks",
    locks,
    channel: new BroadcastChannel("weft-web-locks-b"),
  });

  try {
    assert.equal(await first.elect(), "leader");
    assert.equal(await second.elect(), "follower", "a second tab became leader after the first election returned");
  } finally {
    first.close();
    second.close();
  }
});

test("§8.7 a tab with no Web Locks support runs degraded rather than pretending to lead", async () => {
  const coordinator = new MultiTabCoordinator({ scopeId: "no-locks", channel: new BroadcastChannel("weft-degraded") });
  assert.equal(await coordinator.elect(), "degraded");
  assert.equal(coordinator.role, "degraded");
  coordinator.close();
});

test("§8.7 the leader answers a follower's request without an application-written responder", async () => {
  const channelName = `weft-serve-${Math.trunc(performance.now() * 1000)}`;
  const followerChannel = new BroadcastChannel(channelName);
  const leaderChannel = new BroadcastChannel(channelName);
  const proxy = new BroadcastDbProxy(followerChannel);
  const target = new RecordingTarget();
  const leader = serveBroadcastDbProxy({ channel: leaderChannel, target });

  try {
    // Each request kind has to reach the target carrying its own argument, or the proxy is
    // forwarding into a responder that answers everything the same way.
    assert.equal(await proxy.request({ type: "open", scopeId: "scope" }), "opened:scope");
    assert.equal(await proxy.request({ type: "execute", query: { sql: "select 1", parameters: [] } }), "rows:select 1");
    assert.equal(await proxy.request({ type: "close" }), "closed");
    assert.deepEqual(target.calls, ["open:scope", "execute:select 1", "close"]);
  } finally {
    leader.stop();
    proxy.dispose();
    followerChannel.close();
    leaderChannel.close();
  }
});

test("§8.7 a target that throws reaches the follower as a failed response", async () => {
  const channelName = `weft-serve-fail-${Math.trunc(performance.now() * 1000)}`;
  const followerChannel = new BroadcastChannel(channelName);
  const leaderChannel = new BroadcastChannel(channelName);
  const proxy = new BroadcastDbProxy(followerChannel);
  const target = new RecordingTarget();
  target.failWith = "no such table: todos";
  const leader = serveBroadcastDbProxy({ channel: leaderChannel, target });

  try {
    // A rejection has to survive the channel as text and come back out as a rejection: dropping it
    // would hang the follower on a request the leader had already given up on, and resolving it
    // would make a refused mutation look to a mutator like one that quietly did nothing.
    await assert.rejects(proxy.request({ type: "close" }), /^Error: no such table: todos$/u);
  } finally {
    leader.stop();
    proxy.dispose();
    followerChannel.close();
    leaderChannel.close();
  }
});

test("§8.7 the leader treats a reply on the channel as noise rather than as a request", async () => {
  // Every tab on the channel hears every message, another leader's replies included. A responder
  // that took a `ProxyResponse` for a request would answer an answer, and two of them would feed
  // each other forever.
  const channelName = `weft-serve-noise-${Math.trunc(performance.now() * 1000)}`;
  const leaderChannel = new BroadcastChannel(channelName);
  const noiseChannel = new BroadcastChannel(channelName);
  const watcherChannel = new BroadcastChannel(channelName);
  const target = new RecordingTarget();
  // Counting what crosses the channel is what makes this a test of the guard. Asserting only that
  // the target went untouched would also pass for a responder that let the noise through and threw
  // on the way, which still puts a reply on the channel for a peer to trip over.
  let seen = 0;
  watcherChannel.addEventListener("message", () => {
    seen += 1;
  });
  const leader = serveBroadcastDbProxy({ channel: leaderChannel, target });

  try {
    const noise = [
      { client: "somebody", response: { id: 1, ok: true, value: "an answer" } },
      { client: "somebody", request: { id: 2, type: "nonsense" } },
      "not an envelope at all",
    ];
    for (const message of noise) noiseChannel.postMessage(message);
    await waitFor(() => seen >= noise.length, "the watcher never heard the noise");
    await delay(25);

    assert.deepEqual(target.calls, [], "the leader ran something that was not a request");
    assert.equal(seen, noise.length, "the leader put a reply on the channel in answer to noise");
  } finally {
    leader.stop();
    leaderChannel.close();
    noiseChannel.close();
    watcherChannel.close();
  }
});

test("§8.7 a tab that has lost the lock stops answering", async () => {
  const channelName = `weft-serve-abdicate-${Math.trunc(performance.now() * 1000)}`;
  const followerChannel = new BroadcastChannel(channelName);
  const leaderChannel = new BroadcastChannel(channelName);
  const proxy = new BroadcastDbProxy(followerChannel);
  const target = new RecordingTarget();
  let leading = true;
  const leader = serveBroadcastDbProxy({ channel: leaderChannel, target, isLeader: () => leading });

  try {
    assert.equal(await proxy.request({ type: "close" }), "closed");

    // Losing the lock has to take effect before the successor takes it, or one request is run by
    // two leaders against two handles.
    leading = false;
    const pending = proxy.request({ type: "close" });
    const result = await Promise.race([
      pending.then(() => "answered" as const),
      delay(50).then(() => "silent" as const),
    ]);
    assert.equal(result, "silent", "a tab that had lost the lock still answered");
    assert.deepEqual(target.calls, ["close"], "a tab that had lost the lock still touched the database");
  } finally {
    leader.stop();
    proxy.dispose();
    followerChannel.close();
    leaderChannel.close();
  }
});

test("§8.7 stopping the leader drops a reply it had not yet posted", async () => {
  const channelName = `weft-serve-stop-${Math.trunc(performance.now() * 1000)}`;
  const followerChannel = new BroadcastChannel(channelName);
  const leaderChannel = new BroadcastChannel(channelName);
  const proxy = new BroadcastDbProxy(followerChannel);
  let release: (() => void) | undefined;
  const target: ProxyTarget = {
    request: () =>
      new Promise((resolve) => {
        release = () => {
          resolve("late");
        };
      }),
  };
  const leader = serveBroadcastDbProxy({ channel: leaderChannel, target });

  try {
    const pending = proxy.request({ type: "close" });
    await waitFor(() => release !== undefined, "the leader never began the request");
    leader.stop();
    release?.();

    const result = await Promise.race([
      pending.then(() => "answered" as const),
      delay(50).then(() => "silent" as const),
    ]);
    assert.equal(result, "silent", "a stopped leader posted a reply it had started before stopping");
  } finally {
    proxy.dispose();
    followerChannel.close();
    leaderChannel.close();
  }
});

test("§8.7 one served channel answers every follower's every request", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 5 }), async (followers, each) => {
      const channelName = `weft-serve-many-${followers}-${each}-${Math.trunc(performance.now() * 1000)}`;
      const leaderChannel = new BroadcastChannel(channelName);
      const channels = Array.from({ length: followers }, () => new BroadcastChannel(channelName));
      const proxies = channels.map((channel) => new BroadcastDbProxy(channel));
      const leader = serveBroadcastDbProxy({ channel: leaderChannel, target: new RecordingTarget() });

      try {
        // Every request carries its own statement, so a reply that reached the wrong follower or
        // the wrong request inside one follower shows up as a mismatched answer rather than as a
        // hang that a timeout would have to catch.
        const issued = proxies.flatMap((proxy, tab) =>
          Array.from({ length: each }, (_, index) => {
            const sql = `select ${tab}-${index}`;
            return proxy
              .request({ type: "execute", query: { sql, parameters: [] } })
              .then((value) => ({ sql, value }))
              .catch((error: unknown) => ({ sql, value: `error:${String(error)}` }));
          }),
        );

        for (const answer of await Promise.all(issued)) {
          assert.equal(answer.value, `rows:${answer.sql}`, "a reply reached the wrong follower or request");
        }
      } finally {
        leader.stop();
        for (const proxy of proxies) proxy.dispose();
        for (const channel of channels) channel.close();
        leaderChannel.close();
      }
    }),
    { numRuns: Math.min(SCENARIO_RUNS, 25) },
  );
});

test("§8.7 the leader forwards every verb of the protocol, not only the database three", async () => {
  // The four client verbs used to be refused here by name, which left a follower tab unable to
  // drive a mirror at all — the whole reason multi-tab did not work on OPFS. A leader that has
  // regressed to the old `dispatch` answers these with "the database proxy cannot serve", so the
  // assertion is on the value coming back rather than merely on the promise settling.
  const channelName = `weft-serve-verbs-${Math.trunc(performance.now() * 1000)}`;
  const followerChannel = new BroadcastChannel(channelName);
  const leaderChannel = new BroadcastChannel(channelName);
  const proxy = new BroadcastDbProxy(followerChannel);
  const target = new RecordingTarget();
  const leader = serveBroadcastDbProxy({ channel: leaderChannel, target });

  try {
    const hydrated = await proxy.request({ type: "hydrate", scopeId: "scope-1", deviceId: "device-1" });
    assert.deepEqual(hydrated, { rows: [], removed: [], results: [] });
    const watched = await proxy.request({
      type: "watch",
      cacheKey: "todos:all",
      tableName: "todos",
      query: { sql: "select 1", parameters: [] },
    });
    assert.deepEqual(watched, ["id-for:todos:all"]);
    await proxy.request({
      type: "mutate",
      mutation: { kind: "delete", tableName: "todos", rowId: "todo-1", txnId: "txn-1" },
    });
    await proxy.request({ type: "unwatch", cacheKey: "todos:all" });

    assert.deepEqual(target.calls, ["hydrate:scope-1", "watch:todos:all", "mutate:delete:todo-1", "unwatch:todos:all"]);
  } finally {
    leader.stop();
    proxy.dispose();
    followerChannel.close();
    leaderChannel.close();
  }
});

test("§8.7 a relayed push is not a request to the leader nor a reply to a follower", async () => {
  // Three envelope shapes now ride one channel, and each side's guard has to reject the other two.
  // A leader that took a push for a request would run `broadcast` against the worker; a follower
  // that took one for a reply would settle whichever request was numbered like it. Both go wrong
  // silently, so this counts what each side actually saw.
  const channelName = `weft-push-guards-${Math.trunc(performance.now() * 1000)}`;
  const followerChannel = new BroadcastChannel(channelName);
  const leaderChannel = new BroadcastChannel(channelName);
  const noiseChannel = new BroadcastChannel(channelName);
  // A channel does not deliver to the port that posted, so counting what crossed needs a port that
  // only listens. Asserting on the target alone would also pass for a leader that let the push
  // through and threw on the way, which still puts a reply on the channel for a peer to trip over.
  const watcherChannel = new BroadcastChannel(channelName);
  const proxy = new BroadcastDbProxy(followerChannel);
  const target = new RecordingTarget();
  const leader = serveBroadcastDbProxy({ channel: leaderChannel, target });
  const pushes: WorkerPush[] = [];
  const offPush = proxy.onPush((push) => pushes.push(push));
  let seen = 0;
  watcherChannel.addEventListener("message", () => {
    seen += 1;
  });

  try {
    const push: WorkerPush = { push: "delta", rows: [], removed: ["todos\0todo-1"], results: [] };
    leader.relayPush(push);
    // Noise shaped enough like a push to reach a lax guard: an envelope whose payload is a bare
    // string, and one whose payload has no `push` tag at all. Either would have the mirror deleting
    // rows out of `removed` it never read.
    noiseChannel.postMessage({ broadcast: "delta" });
    noiseChannel.postMessage({ broadcast: { rows: [], removed: ["todos\0todo-2"], results: [] } });
    await waitFor(() => seen >= 3, "the watcher never heard the relay and the noise");
    await delay(25);

    assert.deepEqual(pushes, [push], "the follower applied something that was not a relayed push");
    assert.deepEqual(target.calls, [], "the leader ran a relayed push as if a follower had asked for it");
    // Exactly what was posted and nothing more: a leader answering the push would put a reply on
    // the channel, and a follower answering it would put a request on.
    assert.equal(seen, 3, "somebody answered a push");
  } finally {
    offPush();
    leader.stop();
    proxy.dispose();
    followerChannel.close();
    leaderChannel.close();
    noiseChannel.close();
    watcherChannel.close();
  }
});

test("§8.7 a tab that has lost the lock relays nothing", async () => {
  // Abdication has to stop the deltas as well as the answers. The old leader's worker keeps a
  // hydrated client and keeps pushing at it for as long as its port is open, and a relay that
  // outlived the lock would feed every follower rows from a database the successor has already
  // reopened — two leaders, with row contents rather than a duplicated reply.
  const channelName = `weft-relay-abdicate-${Math.trunc(performance.now() * 1000)}`;
  const followerChannel = new BroadcastChannel(channelName);
  const leaderChannel = new BroadcastChannel(channelName);
  const proxy = new BroadcastDbProxy(followerChannel);
  let leading = true;
  const leader = serveBroadcastDbProxy({
    channel: leaderChannel,
    target: new RecordingTarget(),
    isLeader: () => leading,
  });
  const pushes: WorkerPush[] = [];
  const offPush = proxy.onPush((push) => pushes.push(push));

  try {
    leader.relayPush({ push: "delta", rows: [], removed: ["todos\0first"], results: [] });
    await waitFor(() => pushes.length === 1, "the leader never relayed while it was leading");

    leading = false;
    leader.relayPush({ push: "delta", rows: [], removed: ["todos\0second"], results: [] });
    // And once more after stopping outright, which is the other way a tab gives up the handle.
    leading = true;
    leader.stop();
    leader.relayPush({ push: "delta", rows: [], removed: ["todos\0third"], results: [] });
    await delay(50);

    assert.deepEqual(
      pushes.filter(isDeltaPush).flatMap((push) => [...push.removed]),
      ["todos\0first"],
      "a tab that had given up the lock kept relaying its worker's deltas",
    );
  } finally {
    offPush();
    leader.stop();
    proxy.dispose();
    followerChannel.close();
    leaderChannel.close();
  }
});

test("§8.7 a disposed follower hands its watches back rather than leaving them running", async () => {
  // Nothing tells the leader's host that a follower went away: there is no liveness signal on a
  // BroadcastChannel and the host reference-counts its registrations. A follower that closed
  // without unwatching would leave the worker re-running its statements after every mutation any
  // tab makes, for the rest of the session. An orderly `dispose` — what a `pagehide` handler calls
  // — has to be the follower giving back exactly what it took.
  const channelName = `weft-follower-leak-${Math.trunc(performance.now() * 1000)}`;
  const followerChannel = new BroadcastChannel(channelName);
  const leaderChannel = new BroadcastChannel(channelName);
  const proxy = new BroadcastDbProxy(followerChannel);
  const target = new RecordingTarget();
  const leader = serveBroadcastDbProxy({ channel: leaderChannel, target });

  try {
    const query = { sql: "select 1", parameters: [] };
    await proxy.request({ type: "watch", cacheKey: "todos:all", tableName: "todos", query });
    await proxy.request({ type: "watch", cacheKey: "todos:done", tableName: "todos", query });
    // Released before the tab closed, so `dispose` must not release it a second time: the host
    // counts references, and one too many would retire a statement another tab is still reading.
    await proxy.request({ type: "unwatch", cacheKey: "todos:done" });

    proxy.dispose();
    await waitFor(() => target.calls.length >= 4, "the follower never handed its watch back");
    await delay(25);

    assert.deepEqual(target.calls, ["watch:todos:all", "watch:todos:done", "unwatch:todos:done", "unwatch:todos:all"]);
  } finally {
    leader.stop();
    proxy.dispose();
    followerChannel.close();
    leaderChannel.close();
  }
});

test("§8.7 a relayed push crosses the channel intact", async () => {
  // The envelope is structured-cloned, and the mirror rebuilds rows and revisions straight out of
  // what comes through. A shape that survived the guard but lost `results` — an array of tuples,
  // which is exactly what a Map would have failed to clone as — would leave every watched list
  // stuck on the ids it last had.
  const channelName = `weft-relay-shape-${Math.trunc(performance.now() * 1000)}`;
  const followerChannel = new BroadcastChannel(channelName);
  const leaderChannel = new BroadcastChannel(channelName);
  const proxy = new BroadcastDbProxy(followerChannel);
  const leader = serveBroadcastDbProxy({ channel: leaderChannel, target: new RecordingTarget() });
  const pushes: WorkerPush[] = [];
  const offPush = proxy.onPush((push) => pushes.push(push));

  try {
    const push: WorkerPush = {
      push: "delta",
      rows: [
        {
          tableName: "todos",
          id: "todo-1",
          scopeId: "scope-1",
          created: "2026-01-01T00:00:00.000Z",
          fields: [["title", "alpha"]],
          rev: 7,
          dirty: 1,
        },
      ],
      removed: ["todos\0todo-2"],
      results: [["todos:all", ["todo-1"]]],
    };
    leader.relayPush(push);
    await waitFor(() => pushes.length === 1, "the push never reached the follower");

    assert.deepEqual(pushes[0], push, "the relayed push lost something on the way across");
    // The envelope has to be the one the guards recognise, and be nothing the other two accept.
    const envelope: ProxyPush = { broadcast: push };
    assert.equal("client" in envelope, false, "the push envelope grew a client and became addressable");
  } finally {
    offPush();
    leader.stop();
    proxy.dispose();
    followerChannel.close();
    leaderChannel.close();
  }
});

test("§8.7 the worker transport is a leader-side target and a mirror transport as it stands", () => {
  const worker = new DeferredWorker();
  const transport = new OpfsWorkerTransport(worker);
  // A leader holding the worker passes it straight in, on both faces: as the thing a follower's
  // requests are run against, and as the thing its own mirror reads. If either stops compiling, the
  // two halves of the same protocol have drifted apart and the OPFS path has no working tab at all.
  const target: ProxyTarget = transport;
  const mirror: MirrorTransport = transport;
  assert.equal(typeof target.request, "function");
  assert.equal(typeof mirror.onPush, "function");
  transport.dispose();
});

/** A leader-side target that records what it was asked and answers with a value naming the call. */
class RecordingTarget implements ProxyTarget {
  readonly calls: string[] = [];
  failWith: string | undefined;

  request(body: WorkerRequestBody): Promise<unknown> {
    this.calls.push(describe(body));
    if (this.failWith !== undefined) return Promise.reject(new Error(this.failWith));
    return Promise.resolve(answerFor(body));
  }
}

/** What the target was asked, flattened to a string a test can assert on in order. */
function describe(body: WorkerRequestBody): string {
  switch (body.type) {
    case "open":
      return `open:${body.scopeId}`;
    case "execute":
      return `execute:${body.query.sql}`;
    case "hydrate":
      return `hydrate:${body.scopeId}`;
    case "mutate":
      return `mutate:${body.mutation.kind}:${body.mutation.rowId}`;
    case "watch":
      return `watch:${body.cacheKey}`;
    case "unwatch":
      return `unwatch:${body.cacheKey}`;
    case "auth":
      return `auth:${body.token ?? "signed-out"}`;
    case "sync":
      return "sync";
    case "discardQuarantine":
      return "discardQuarantine";
    case "close":
      return "close";
  }
}

/** A distinct answer per request, so a reply that reached the wrong request shows as a mismatch. */
function answerFor(body: WorkerRequestBody): unknown {
  switch (body.type) {
    case "open":
      return `opened:${body.scopeId}`;
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

/** Web Locks semantics: the holder keeps the lock until its tab goes away. */
class ExclusiveLocks implements LockManagerLike {
  readonly #held = new Set<string>();

  async request<T>(
    name: string,
    _options: { readonly ifAvailable: true },
    callback: (lock: object | null) => T | Promise<T>,
  ): Promise<T> {
    if (this.#held.has(name)) return callback(null);
    this.#held.add(name);
    return callback({});
  }

  releaseAll(): void {
    this.#held.clear();
  }
}

/** Web Locks release when the callback's returned promise settles. */
class ReleasingLocks implements LockManagerLike {
  readonly #held = new Set<string>();

  async request<T>(
    name: string,
    _options: { readonly ifAvailable: true },
    callback: (lock: object | null) => T | Promise<T>,
  ): Promise<T> {
    if (this.#held.has(name)) return callback(null);
    this.#held.add(name);
    try {
      return await callback({});
    } finally {
      this.#held.delete(name);
    }
  }
}

/** A worker that hands control of when — and in what order — replies come back. */
class DeferredWorker {
  readonly received: WorkerRequest[] = [];
  listeners = 0;
  #listener: ((event: MessageEvent<WorkerResponse>) => void) | undefined;

  postMessage(message: WorkerRequest): void {
    this.received.push(message);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<WorkerResponse>) => void): void {
    this.#listener = listener;
    this.listeners += 1;
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent<WorkerResponse>) => void): void {
    if (this.#listener === listener) {
      this.#listener = undefined;
      this.listeners -= 1;
    }
  }

  reply(id: number, value: unknown): void {
    this.#listener?.({ data: { id, ok: true, value } } as MessageEvent<WorkerResponse>);
  }

  fail(id: number, error: string): void {
    this.#listener?.({ data: { id, ok: false, error } } as MessageEvent<WorkerResponse>);
  }
}

function sqlOf(request: WorkerRequest): string {
  return request.type === "execute" ? request.query.sql : request.type;
}

function permute<T>(items: readonly T[], keys: readonly number[]): readonly T[] {
  return items
    .map((item, index) => ({ item, index, key: keys[index % keys.length] ?? index }))
    .sort((left, right) => left.key - right.key || left.index - right.index)
    .map((entry) => entry.item);
}

/**
 * BroadcastChannel delivery is asynchronous and takes an unspecified number of turns, so
 * tests wait on the condition rather than on a guessed number of ticks.
 */
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
