// The transport layer under §8.7: the worker boundary, the follower-to-leader proxy, and
// Web Locks leader election. These are all correlation and lifetime problems — a reply must
// reach the request that asked for it, and nothing may be left pending when a tab dies — so
// they are checked against generated interleavings rather than one happy path each.
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import {
  BroadcastDbProxy,
  MultiTabCoordinator,
  OpfsWorkerTransport,
  serveBroadcastDbProxy,
  type CompiledQuery,
  type LockManagerLike,
  type ProxyRequest,
  type ProxyTarget,
  type TabRole,
  type WorkerRequest,
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
            answers.map((response) => (response.ok ? response.value : "error")),
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
    assert.deepEqual(
      answers.map((answer) => (answer.ok ? answer.value : "error")),
      ["answer:1", "answer:2"],
      "a proxy resolved from another follower's traffic",
    );
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
  const stop = serveBroadcastDbProxy({ channel: leaderChannel, target });

  try {
    // Each of the three request kinds has to reach its own method with its own argument, or the
    // proxy is forwarding into a responder that answers everything the same way.
    assert.deepEqual(await proxy.request({ type: "open", scopeId: "scope" }), {
      id: 1,
      ok: true,
      value: "opened:scope",
    });
    assert.deepEqual(await proxy.request({ type: "execute", query: { sql: "select 1", parameters: [] } }), {
      id: 2,
      ok: true,
      value: "rows:select 1",
    });
    assert.deepEqual(await proxy.request({ type: "close" }), { id: 3, ok: true, value: "closed" });
    assert.deepEqual(target.calls, ["open:scope", "execute:select 1", "close"]);
  } finally {
    stop();
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
  const stop = serveBroadcastDbProxy({ channel: leaderChannel, target });

  try {
    const response = await proxy.request({ type: "close" });
    // A rejection has to survive the channel as text; dropping it would hang the follower on a
    // request the leader had already given up on.
    assert.equal(response.ok, false, "a throwing target answered as a success");
    assert.equal(response.ok ? "" : response.error, "no such table: todos");
  } finally {
    stop();
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
  const stop = serveBroadcastDbProxy({ channel: leaderChannel, target });

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
    stop();
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
  const stop = serveBroadcastDbProxy({ channel: leaderChannel, target, isLeader: () => leading });

  try {
    assert.deepEqual(await proxy.request({ type: "close" }), { id: 1, ok: true, value: "closed" });

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
    stop();
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
    open: () => Promise.resolve(undefined),
    execute: () => Promise.resolve(undefined),
    close: () =>
      new Promise((resolve) => {
        release = () => {
          resolve("late");
        };
      }),
  };
  const stop = serveBroadcastDbProxy({ channel: leaderChannel, target });

  try {
    const pending = proxy.request({ type: "close" });
    await waitFor(() => release !== undefined, "the leader never began the request");
    stop();
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
      const stop = serveBroadcastDbProxy({ channel: leaderChannel, target: new RecordingTarget() });

      try {
        // Every request carries its own statement, so a reply that reached the wrong follower or
        // the wrong request inside one follower shows up as a mismatched answer rather than as a
        // hang that a timeout would have to catch.
        const issued = proxies.flatMap((proxy, tab) =>
          Array.from({ length: each }, (_, index) => {
            const sql = `select ${tab}-${index}`;
            return proxy.request({ type: "execute", query: { sql, parameters: [] } }).then((response) => ({
              sql,
              value: response.ok ? response.value : `error:${response.error}`,
            }));
          }),
        );

        for (const answer of await Promise.all(issued)) {
          assert.equal(answer.value, `rows:${answer.sql}`, "a reply reached the wrong follower or request");
        }
      } finally {
        stop();
        for (const proxy of proxies) proxy.dispose();
        for (const channel of channels) channel.close();
        leaderChannel.close();
      }
    }),
    { numRuns: Math.min(SCENARIO_RUNS, 25) },
  );
});

test("§8.7 the worker transport is a leader-side target as it stands", () => {
  const worker = new DeferredWorker();
  const transport = new OpfsWorkerTransport(worker);
  // A leader holding the worker passes it straight in. If this stops compiling, the two halves of
  // the same protocol have drifted apart.
  const target: ProxyTarget = transport;
  assert.equal(typeof target.execute, "function");
  transport.dispose();
});

/** A leader-side target that records what it was asked and answers with a value naming the call. */
class RecordingTarget implements ProxyTarget {
  readonly calls: string[] = [];
  failWith: string | undefined;

  open(scopeId: string): Promise<unknown> {
    this.calls.push(`open:${scopeId}`);
    return this.#answer(`opened:${scopeId}`);
  }

  execute(query: CompiledQuery): Promise<unknown> {
    this.calls.push(`execute:${query.sql}`);
    return this.#answer(`rows:${query.sql}`);
  }

  close(): Promise<unknown> {
    this.calls.push("close");
    return this.#answer("closed");
  }

  #answer(value: string): Promise<unknown> {
    if (this.failWith !== undefined) return Promise.reject(new Error(this.failWith));
    return Promise.resolve(value);
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
