// §8.7 end to end across tabs: one worker, one leader tab holding it, and follower tabs reaching
// it over a BroadcastChannel.
//
// This is the case the two halves were built for and neither could show alone. `worker-bridge`
// proves a mirror works against a worker port; `worker-multitab` proves a request and a push cross
// the channel in the right envelope. Only together do they answer the question that matters: does a
// follower tab — which may not touch OPFS, because one tab holds the access handle — render the
// same rows as the leader.
//
// Everything real except the browser. A `node:worker_threads` MessageChannel stands in for the
// worker port and Node's own `BroadcastChannel` for the channel, so messages really are
// structured-cloned and really do arrive on a later turn, which is where the ordering mistakes are.
import assert from "node:assert/strict";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId } from "weftdb/core";
import { defineSchema, S } from "weftdb/schema";
import {
  BroadcastDbProxy,
  compileOnlyKysely,
  isDeltaPush,
  OpfsWorkerTransport,
  reactiveSqlQuery,
  serveBroadcastDbProxy,
  serveWeftWorker,
  WeftClientMirror,
  type BroadcastDbProxyServer,
  type MirrorTransport,
  type ReactiveSqlQuery,
  type ScopedRowQuery,
  type WeftWorkerHost,
  type WorkerMessage,
  type WorkerRequest,
} from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";

const schema = defineSchema({
  todos: S.collection({
    title: S.string(),
    done: S.boolean(),
    rank: S.number(),
  }),
});

interface Database {
  todos: {
    id: string;
    scope_id: string;
    created: string;
    title: string;
    done: boolean;
    rank: number;
  };
}

const SCOPE = scopeId("scope-1");
const DEVICE = deviceId("device-1");
const TODOS = tableName("todos");

test("§8.7 a follower tab hydrates, mutates and watches through the leader", async () => {
  using tabs = Tabs.open();
  tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  tabs.seed("todo-2", { title: "beta", done: true, rank: 2 });
  // Edited in that earlier session, so the rows arrive on different revisions and a follower that
  // renumbered them from one would be caught here rather than in a re-render three screens later.
  tabs.seedUpdate("todo-1", "alpha prime");
  const follower = tabs.follower();

  await tabs.leader.hydrate();
  await follower.mirror.hydrate();

  assert.deepEqual([...follower.mirror.rows.keys()].sort(), ["todos\0todo-1", "todos\0todo-2"]);
  assert.equal(follower.mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("title")), "alpha prime");
  // The revision is the row's identity as far as `RowIdentityCache` is concerned, and it has now
  // crossed two boundaries rather than one — the worker port and then the channel. If either leg
  // rebuilt the row instead of carrying it, the two tabs disagree here.
  for (const [key, row] of follower.mirror.rows) {
    assert.equal(
      row.internals._weft_rev,
      tabs.leader.rows.get(key)?.internals._weft_rev,
      `${key} reached the follower on a revision the leader does not hold`,
    );
    assert.equal(row.internals._weft_rev, tabs.host.client?.rows.get(key)?.internals._weft_rev);
  }

  // And it can drive the worker, not only read it. The four client verbs used to be refused by the
  // leader's dispatch by name, which is what made multi-tab unusable on the OPFS path.
  const open = tabs.query((statement) => statement.where("done", "=", false).orderBy("rank"));
  await follower.mirror.watch(open);
  assert.deepEqual(ids(follower.mirror, open), ["todo-1"], "the follower's watch answered with nothing");

  follower.mirror.update(TODOS, rowId("todo-2"), { done: false }, txnId("txn-from-follower"));
  await settle(() => ids(follower.mirror, open).length === 2);
  assert.deepEqual(ids(follower.mirror, open), ["todo-1", "todo-2"]);
  assert.equal(
    tabs.stored("todo-2")?.["done"],
    0,
    "a follower's mutation never reached SQLite, so it dies with the tab",
  );
});

test("§8.7 one tab's mutation reaches every tab's mirror", async () => {
  using tabs = Tabs.open();
  const follower = tabs.follower();
  await tabs.leader.hydrate();
  await follower.mirror.hydrate();

  const all = tabs.query((statement) => statement.orderBy("rank"));
  await tabs.leader.watch(all);
  await follower.mirror.watch(all);

  // From the follower, which is the direction that did not exist: follower → leader → worker, and
  // the resulting delta back out to every tab at once. A relay that only answered the tab that
  // asked would leave the leader's own list stale until something else happened to it.
  follower.mirror.create(TODOS, rowId("todo-1"), { title: "made in a follower", done: false, rank: 1 }, txnId("txn-1"));
  await settle(() => tabs.leader.rows.size === 1 && follower.mirror.rows.size === 1);

  for (const [name, mirror] of [
    ["the leader", tabs.leader],
    ["the follower", follower.mirror],
  ] as const) {
    assert.equal(
      mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("title")),
      "made in a follower",
      `${name} never saw the row`,
    );
    assert.deepEqual(ids(mirror, all), ["todo-1"], `${name}'s watched list did not move`);
  }

  // The other direction too, so this is not a relay that happens to work one way round.
  tabs.leader.update(TODOS, rowId("todo-1"), { title: "edited in the leader" }, txnId("txn-2"));
  await settle(
    () => follower.mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("title")) === "edited in the leader",
  );
  assert.equal(tabs.leader.rows.get("todos\0todo-1")?.fields.get(fieldName("title")), "edited in the leader");
});

test("§8.7 two followers watching different statements each get their own ids", async () => {
  using tabs = Tabs.open();
  tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  tabs.seed("todo-2", { title: "beta", done: true, rank: 2 });
  const first = tabs.follower();
  const second = tabs.follower();
  await first.mirror.hydrate();
  await second.mirror.hydrate();

  const open = tabs.query((statement) => statement.where("done", "=", false).orderBy("rank"));
  const done = tabs.query((statement) => statement.where("done", "=", true).orderBy("rank"));
  await first.mirror.watch(open);
  await second.mirror.watch(done);

  // One push carries every watched statement's answer, because the host has one registry for every
  // tab. Each mirror keeps the keys it asked for and drops the rest — so a mirror that cached the
  // whole `results` array would start answering a statement its own tab never registered, out of
  // ids it can never refresh.
  assert.deepEqual(ids(first.mirror, open), ["todo-1"]);
  assert.deepEqual(ids(first.mirror, done), [], "a follower answered from a statement the other tab watches");
  assert.deepEqual(ids(second.mirror, done), ["todo-2"]);
  assert.deepEqual(ids(second.mirror, open), [], "a follower answered from a statement the other tab watches");

  // A change that moves a row between the two lists has to move both, from one delta.
  first.mirror.update(TODOS, rowId("todo-1"), { done: true }, txnId("txn-1"));
  await settle(() => ids(first.mirror, open).length === 0 && ids(second.mirror, done).length === 2);
  assert.deepEqual(ids(second.mirror, done), ["todo-1", "todo-2"]);
});

test("§8.7 two tabs watching one statement do not retire it from under each other", async () => {
  using tabs = Tabs.open();
  tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  const follower = tabs.follower();
  await tabs.leader.hydrate();
  await follower.mirror.hydrate();

  // The same statement, so the same cache key: the host keys its registry by that and nothing else.
  const all = tabs.query((statement) => statement.orderBy("rank"));
  await tabs.leader.watch(all);
  await follower.mirror.watch(all);
  assert.deepEqual(ids(tabs.leader, all), ["todo-1"]);

  follower.mirror.unwatch(all);
  await settle(() => follower.mirror.select(all).length === 0);

  // A row joining the list, not merely changing inside it. A mirror whose registration was retired
  // keeps the ids it last had, so an edit to an existing row leaves the two indistinguishable —
  // only a change of membership tells a live list from a frozen one.
  tabs.leader.create(TODOS, rowId("todo-2"), { title: "beta", done: false, rank: 2 }, txnId("txn-1"));
  await settle(() => tabs.leader.rows.size === 2);

  // Without a reference count the follower's unwatch deletes the shared registration, and the
  // leader's list silently stops updating — no error anywhere, just a list frozen at the ids it
  // happened to have when the other tab let go.
  assert.deepEqual(
    ids(tabs.leader, all),
    ["todo-1", "todo-2"],
    "one tab's unwatch retired a statement another tab was reading",
  );
  assert.deepEqual(follower.mirror.select(all), [], "the tab that unwatched kept being answered");

  // And the last release really does retire it, or the count leaks the other way and the worker
  // re-runs statements nobody reads for the rest of the session.
  tabs.leader.unwatch(all);
  const before = tabs.pushes();
  tabs.leader.update(TODOS, rowId("todo-1"), { title: "alpha prime" }, txnId("txn-2"));
  await settle(() => tabs.pushes() > before);
  assert.deepEqual(tabs.lastResults(), [], "the worker kept recomputing a statement every tab had released");
});

test("§8.7 a follower that closes hands its watches back to the worker", async () => {
  using tabs = Tabs.open();
  tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  const follower = tabs.follower();
  await tabs.leader.hydrate();
  await follower.mirror.hydrate();

  const all = tabs.query((statement) => statement.orderBy("rank"));
  await follower.mirror.watch(all);

  // A tab going away, orderly: `pagehide` disposes the mirror and the proxy. Nothing else tells the
  // leader's host that the tab is gone — a BroadcastChannel has no liveness signal — so a proxy
  // that did not hand its registrations back would leave the worker running this statement after
  // every mutation any tab makes, forever.
  follower.close();
  await settle(() => tabs.pushes() >= 0);

  tabs.leader.create(TODOS, rowId("todo-2"), { title: "beta", done: false, rank: 2 }, txnId("txn-1"));
  await settle(() => tabs.leader.rows.size === 2);

  assert.deepEqual(tabs.lastResults(), [], "a closed follower left its statement registered in the worker");
});

/**
 * One worker, one leader tab, and however many follower tabs a test asks for.
 *
 * The leader is the assembly the application would write: a transport to the worker, a responder on
 * the channel with that transport as its target, and one subscription relaying the worker's pushes
 * onto the channel. The follower is the whole of what a follower tab needs — a proxy, and a mirror
 * over it. Neither mirror is told which it is.
 */
class Tabs {
  readonly db = compileOnlyKysely<Database>();
  readonly host: WeftWorkerHost;
  readonly store: SqliteClientStore;
  readonly leader: WeftClientMirror;
  readonly leaderServer: BroadcastDbProxyServer;
  leading = true;
  readonly #executor: ReturnType<typeof openSqliteExecutor>;
  readonly #channel: MessageChannel;
  readonly #channelName: string;
  readonly #leaderChannel: BroadcastChannel;
  readonly #transport: OpfsWorkerTransport;
  readonly #offRelay: () => void;
  readonly #followers: FollowerTab[] = [];
  /** Every delta the worker sent, as only a listener on the raw port can see them. */
  readonly #pushes: WorkerMessage[] = [];

  private constructor(executor: ReturnType<typeof openSqliteExecutor>) {
    this.#executor = executor;
    this.store = new SqliteClientStore(executor, schema);
    this.store.installSchema();
    this.#channel = new MessageChannel();
    this.host = serveWeftWorker({
      port: new PortEndpoint<WorkerRequest>(this.#channel.port2),
      executor,
      store: this.store,
    });

    const page = new PortEndpoint<WorkerMessage>(this.#channel.port1);
    page.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      if ("push" in event.data) this.#pushes.push(event.data);
    });
    this.#channelName = `weft-tabs-${Math.trunc(performance.now() * 1000)}-${Math.trunc(Math.random() * 1e6)}`;
    this.#leaderChannel = new BroadcastChannel(this.#channelName);
    this.#transport = new OpfsWorkerTransport(page);
    this.leaderServer = serveBroadcastDbProxy({
      channel: this.#leaderChannel,
      target: this.#transport,
      isLeader: () => this.leading,
    });
    // The one line that makes a follower's mirror live: the leader subscribes to its own worker's
    // deltas and puts each on the channel. The responder is not given the transport's push side —
    // it is handed a request sink — so this wiring is the leader's to do, and is visible here.
    this.#offRelay = this.#transport.onPush((push) => {
      this.leaderServer.relayPush(push);
    });
    this.leader = new WeftClientMirror({ transport: this.#transport, scopeId: SCOPE, deviceId: DEVICE });
  }

  static open(): Tabs {
    return new Tabs(openSqliteExecutor(":memory:"));
  }

  /** Another tab that may not touch the database, reaching the worker only through the leader. */
  follower(): FollowerTab {
    const channel = new BroadcastChannel(this.#channelName);
    const proxy = new BroadcastDbProxy(channel);
    // The proxy passed where the leader passes its worker transport. That assignment is the claim
    // this whole file is making, and it is checked by the compiler rather than by an assertion.
    const transport: MirrorTransport = proxy;
    const tab = new FollowerTab(
      proxy,
      channel,
      new WeftClientMirror({ transport, scopeId: SCOPE, deviceId: deviceId(`device-${this.#followers.length + 2}`) }),
    );
    this.#followers.push(tab);
    return tab;
  }

  /** A row written straight into the database, as a previous session would have left it. */
  seed(id: string, values: { title: string; done: boolean; rank: number }): void {
    const seeding = this.store.hydrate(SCOPE, DEVICE);
    seeding.create(
      TODOS,
      rowId(id),
      { [fieldName("title")]: values.title, [fieldName("done")]: values.done, [fieldName("rank")]: values.rank },
      txnId(`seed-${id}`),
    );
  }

  /** An edit made in a previous session, which is what lifts a row's revision above its first. */
  seedUpdate(id: string, title: string): void {
    const seeding = this.store.hydrate(SCOPE, DEVICE);
    seeding.update(TODOS, rowId(id), { [fieldName("title")]: title }, txnId(`seed-edit-${id}`));
  }

  query(build: (statement: ScopedRowQuery<Database, "todos">) => ScopedRowQuery<Database, "todos">): ReactiveSqlQuery {
    return reactiveSqlQuery({
      tableName: TODOS,
      query: build(this.db.selectFrom("todos").select("id").where("scope_id", "=", SCOPE)),
    });
  }

  /** What SQLite holds for a row, which is what survives every tab. */
  stored(id: string): Record<string, unknown> | undefined {
    return this.#executor.get({
      sql: 'SELECT * FROM "todos" WHERE scope_id = ? AND id = ?',
      parameters: [SCOPE, id],
      decode: (row) => ({ ...row }),
    });
  }

  pushes(): number {
    return this.#pushes.length;
  }

  /** Which statements the worker recomputed for the last push — its registry, seen from outside. */
  lastResults(): readonly string[] {
    const last = this.#pushes.filter(isDeltaPush).at(-1);
    if (last === undefined) return [];
    return last.results.map(([cacheKey]) => cacheKey);
  }

  [Symbol.dispose](): void {
    for (const follower of this.#followers) follower.close();
    this.leader.dispose();
    this.#offRelay();
    this.leaderServer.stop();
    this.#transport.dispose();
    this.host.stop();
    this.#leaderChannel.close();
    // An open port or channel keeps Node's event loop alive, so a failing run that skipped these
    // would hang the whole file rather than report a failure.
    this.#channel.port1.close();
    this.#channel.port2.close();
    this.#executor.close();
  }
}

class FollowerTab {
  readonly proxy: BroadcastDbProxy;
  readonly mirror: WeftClientMirror;
  readonly #channel: BroadcastChannel;
  #closed = false;

  constructor(proxy: BroadcastDbProxy, channel: BroadcastChannel, mirror: WeftClientMirror) {
    this.proxy = proxy;
    this.#channel = channel;
    this.mirror = mirror;
  }

  /** The tab going away, in the order a `pagehide` handler would. Idempotent, because the fixture
   * closes every follower on teardown and a test may already have closed one. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.mirror.dispose();
    this.proxy.dispose();
    this.#channel.close();
  }
}

function ids(mirror: WeftClientMirror, query: ReactiveSqlQuery): readonly string[] {
  return mirror.engine.getSqlSnapshot(query, mirror.select, mirror.rows).rows.map((row) => String(row.id));
}

/**
 * A `MessagePort` and a `BroadcastChannel` both deliver on a later turn of the loop, and a mirror's
 * mutators return before anything has crossed either — so a test waits on the condition rather than
 * on a guessed number of ticks. A follower's traffic makes two crossings each way, which is exactly
 * the kind of thing a fixed delay gets wrong on a loaded machine.
 */
async function settle(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("the tabs never reached the expected state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  // Two more turns, so a delta that arrives with the condition has finished crossing to the tab
  // that did not cause it before the assertions read either map.
  for (let index = 0; index < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * A `MessagePort` in the shape each side expects of the other. It sends and receives both halves of
 * the protocol, which is what lets one class stand in for the page's `WorkerLike` and the worker's
 * `WorkerHostPortLike` alike.
 */
class PortEndpoint<Incoming> {
  readonly #port: MessagePort;
  readonly #wrapped = new Map<unknown, (event: unknown) => void>();

  constructor(port: MessagePort) {
    this.#port = port;
    // A port reached through `addEventListener` rather than through its EventEmitter face does not
    // begin delivering on its own.
    this.#port.start();
  }

  postMessage(message: WorkerRequest | WorkerMessage): void {
    this.#port.postMessage(message);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<Incoming>) => void): void {
    const wrapped = (event: unknown): void => {
      listener(event as MessageEvent<Incoming>);
    };
    this.#wrapped.set(listener, wrapped);
    this.#port.addEventListener("message", wrapped);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent<Incoming>) => void): void {
    const wrapped = this.#wrapped.get(listener);
    if (wrapped === undefined) return;
    this.#wrapped.delete(listener);
    this.#port.removeEventListener("message", wrapped);
  }
}
