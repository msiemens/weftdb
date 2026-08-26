// §8.7 end to end across tabs: one worker, and every tab holding a `MessagePort` straight to it.
//
// This is the case the pieces were built for and none of them shows alone. `worker-bridge` proves a
// mirror works against a worker port; `worker-port-broker` proves a port really crosses from one
// document to another and that the worker answers each one separately. Only together do they answer
// the question that matters: does a tab that may not touch OPFS — because another tab holds the
// access handle — render the same rows as the tab that does, while sending its traffic to the
// worker rather than through its neighbour.
//
// Everything real except the browser. A `node:worker_threads` MessageChannel stands in for the
// worker port and for every tab's connection, and the broker relaying those connections is the
// shipped one, so messages really are structured-cloned, ports really are transferred, and they
// really do arrive on a later turn — which is where the ordering mistakes are.
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId } from "weftdb/core";
import { defineSchema, S } from "weftdb/schema";
import {
  compileOnlyKysely,
  isDeltaPush,
  reactiveSqlQuery,
  serveWeftWorker,
  WeftBrokerClient,
  WeftClientMirror,
  WorkerPortTransport,
  type ReactiveSqlQuery,
  type ScopedRowQuery,
  type WeftWorkerHost,
  type WorkerMessage,
  type WorkerPush,
  type WorkerRequest,
} from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import { BrokerHub, PortEndpoint, settle } from "./multitab-fixtures.ts";

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

test("§8.7 a tab that was handed a port hydrates, mutates and watches through it", async () => {
  using tabs = Tabs.open();
  tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  tabs.seed("todo-2", { title: "beta", done: true, rank: 2 });
  // Edited in that earlier session, so the rows arrive on different revisions and a tab that
  // renumbered them from one would be caught here rather than in a re-render three screens later.
  tabs.seedUpdate("todo-1", "alpha prime");
  const guest = await tabs.guest();

  await tabs.owner.hydrate();
  await guest.mirror.hydrate();

  assert.deepEqual([...guest.mirror.rows.keys()].sort(), ["todos\0todo-1", "todos\0todo-2"]);
  assert.equal(guest.mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("title")), "alpha prime");
  // The revision is the row's identity as far as `RowIdentityCache` is concerned. Both tabs read it
  // from the same worker over their own ports, so a port that rebuilt rows instead of carrying them
  // would have the two tabs disagree here.
  for (const [key, row] of guest.mirror.rows) {
    assert.equal(
      row.internals._weft_rev,
      tabs.owner.rows.get(key)?.internals._weft_rev,
      `${key} reached the second tab on a revision the first does not hold`,
    );
    assert.equal(row.internals._weft_rev, tabs.host.client?.rows.get(key)?.internals._weft_rev);
  }

  // And it can drive the worker, not only read it.
  const open = tabs.query((statement) => statement.where("done", "=", false).orderBy("rank"));
  await guest.mirror.watch(open);
  assert.deepEqual(ids(guest.mirror, open), ["todo-1"], "the second tab's watch answered with nothing");

  guest.mirror.update(TODOS, rowId("todo-2"), { done: false }, txnId("txn-from-guest"));
  await settle(() => ids(guest.mirror, open).length === 2);
  assert.deepEqual(ids(guest.mirror, open), ["todo-1", "todo-2"]);
  assert.equal(
    tabs.stored("todo-2")?.["done"],
    0,
    "a second tab's mutation never reached SQLite, so it dies with the tab",
  );
});

test("§8.7 one tab's mutation reaches every tab's mirror", async () => {
  using tabs = Tabs.open();
  const guest = await tabs.guest();
  await tabs.owner.hydrate();
  await guest.mirror.hydrate();

  const all = tabs.query((statement) => statement.orderBy("rank"));
  await tabs.owner.watch(all);
  await guest.mirror.watch(all);

  // From the tab that does not own the worker, and back out to both. A worker that answered only
  // the port that asked would leave the owning tab's list stale until something else happened to
  // it — and that is the mistake this design makes possible, because a response now *is* addressed
  // to one port.
  guest.mirror.create(TODOS, rowId("todo-1"), { title: "made in a guest tab", done: false, rank: 1 }, txnId("txn-1"));
  await settle(() => tabs.owner.rows.size === 1 && guest.mirror.rows.size === 1);

  for (const [name, mirror] of [
    ["the owning tab", tabs.owner],
    ["the guest tab", guest.mirror],
  ] as const) {
    assert.equal(
      mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("title")),
      "made in a guest tab",
      `${name} never saw the row`,
    );
    assert.deepEqual(ids(mirror, all), ["todo-1"], `${name}'s watched list did not move`);
  }

  // The other direction too, so this is not a path that happens to work one way round.
  tabs.owner.update(TODOS, rowId("todo-1"), { title: "edited in the owning tab" }, txnId("txn-2"));
  await settle(
    () => guest.mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("title")) === "edited in the owning tab",
  );
  assert.equal(tabs.owner.rows.get("todos\0todo-1")?.fields.get(fieldName("title")), "edited in the owning tab");
});

test("§8.7 a tab is sent its own statements' results and never another tab's", async () => {
  // The routing rule for results, and the whole reason the host counts watches per port. A tab
  // rendering one list has no use for the lists its neighbours are rendering: a delta carrying them
  // wakes this tab's engine and it re-scans its own subscriptions to learn that nothing it reads
  // has moved. So the assertion is on what crossed the port, not on what the mirror kept — a mirror
  // that filtered the surplus out would pass a test written the second way while the tab went on
  // being woken by every query in the browser.
  using tabs = Tabs.open();
  tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  tabs.seed("todo-2", { title: "beta", done: true, rank: 2 });
  const first = await tabs.guest();
  const second = await tabs.guest();
  await tabs.owner.hydrate();
  await first.mirror.hydrate();
  await second.mirror.hydrate();

  const open = tabs.query((statement) => statement.where("done", "=", false).orderBy("rank"));
  const done = tabs.query((statement) => statement.where("done", "=", true).orderBy("rank"));
  await first.mirror.watch(open);
  await second.mirror.watch(done);

  assert.deepEqual(ids(first.mirror, open), ["todo-1"]);
  assert.deepEqual(ids(first.mirror, done), [], "a tab answered from a statement the other tab watches");
  assert.deepEqual(ids(second.mirror, done), ["todo-2"]);
  assert.deepEqual(ids(second.mirror, open), [], "a tab answered from a statement the other tab watches");

  // A change that moves a row between the two lists has to move both, from one mutation. The rows
  // go to everybody — a row belongs to the scope — so both tabs are pushed to, and the point is
  // what each push carries.
  const ownerPushes = tabs.pushes();
  first.clearPushes();
  second.clearPushes();
  first.mirror.update(TODOS, rowId("todo-1"), { done: true }, txnId("txn-1"));
  await settle(() => ids(first.mirror, open).length === 0 && ids(second.mirror, done).length === 2);
  assert.deepEqual(ids(second.mirror, done), ["todo-1", "todo-2"]);

  assert.deepEqual(first.results(), [open.cacheKey], "a tab was sent the results of another tab's statement");
  assert.deepEqual(second.results(), [done.cacheKey], "a tab was sent the results of another tab's statement");
  // And the owning tab, which watches nothing at all, is pushed to — the row is the scope's — and
  // told about no statement whatever.
  assert.ok(tabs.pushes() > ownerPushes, "the tab that watches nothing was not told the row had moved");
  assert.deepEqual(tabs.lastResults(), [], "a tab watching nothing was sent somebody else's results");
});

test("§8.7 two tabs watching one statement do not retire it from under each other", async () => {
  using tabs = Tabs.open();
  tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  const guest = await tabs.guest();
  await tabs.owner.hydrate();
  await guest.mirror.hydrate();

  // The same statement, so the same cache key: the host keys its registry by that and nothing else.
  const all = tabs.query((statement) => statement.orderBy("rank"));
  await tabs.owner.watch(all);
  await guest.mirror.watch(all);
  assert.deepEqual(ids(tabs.owner, all), ["todo-1"]);

  guest.mirror.unwatch(all);
  await settle(() => guest.mirror.select(all) === undefined);

  // A row joining the list, not merely changing inside it. A mirror whose registration was retired
  // keeps the ids it last had, so an edit to an existing row leaves the two indistinguishable —
  // only a change of membership tells a live list from a frozen one.
  tabs.owner.create(TODOS, rowId("todo-2"), { title: "beta", done: false, rank: 2 }, txnId("txn-1"));
  await settle(() => tabs.owner.rows.size === 2);

  // Without a reference count the second tab's unwatch deletes the shared registration, and the
  // first tab's list silently stops updating — no error anywhere, just a list frozen at the ids it
  // happened to have when the other tab let go.
  assert.deepEqual(
    ids(tabs.owner, all),
    ["todo-1", "todo-2"],
    "one tab's unwatch retired a statement another tab was reading",
  );
  // No answer, rather than an answer of no rows: the tab let the statement go, so it holds nothing
  // the worker said about it — which is a different thing from the worker having said "nothing".
  assert.equal(guest.mirror.select(all), undefined, "the tab that unwatched kept being answered");

  // And the last release really does retire it, or the count leaks the other way and the worker
  // re-runs statements nobody reads for the rest of the session. Read off the worker's own registry:
  // a delta carries only the statements the tab it is addressed to registered, so a statement left
  // standing on behalf of a tab that has let go is invisible from every port.
  tabs.owner.unwatch(all);
  const before = tabs.pushes();
  tabs.owner.update(TODOS, rowId("todo-1"), { title: "alpha prime" }, txnId("txn-2"));
  await settle(() => tabs.pushes() > before);
  assert.deepEqual(tabs.host.watching, [], "the worker kept recomputing a statement every tab had released");
});

test("§8.7 a tab that disconnects has its watches released by the worker", async () => {
  using tabs = Tabs.open();
  tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  const guest = await tabs.guest();
  await tabs.owner.hydrate();
  await guest.mirror.hydrate();

  const all = tabs.query((statement) => statement.orderBy("rank"));
  await guest.mirror.watch(all);
  assert.deepEqual(tabs.host.watching, [all.cacheKey], "the guest's statement was never registered");

  // A tab going away, orderly: `pagehide` disposes the mirror and says goodbye on its port. A
  // `MessagePort` has no liveness signal the worker can rely on, so a tab that simply stopped would
  // leave the worker running this statement after every mutation any tab makes, for ever.
  await guest.close();

  tabs.owner.create(TODOS, rowId("todo-2"), { title: "beta", done: false, rank: 2 }, txnId("txn-1"));
  await settle(() => tabs.owner.rows.size === 2);

  assert.deepEqual(tabs.host.watching, [], "a disconnected tab left its statement registered in the worker");
  assert.equal(tabs.host.connections, 1, "the worker is still serving a port whose tab has gone");
});

test("§8.7 a tab may not release a registration it never took", async () => {
  using tabs = Tabs.open();
  tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  const guest = await tabs.guest();
  await tabs.owner.hydrate();
  await guest.mirror.hydrate();

  const all = tabs.query((statement) => statement.orderBy("rank"));
  await tabs.owner.watch(all);
  assert.deepEqual(ids(tabs.owner, all), ["todo-1"]);

  // Straight down the port, bypassing the mirror's own reference counting: a tab handing back a
  // registration it never made. The worker counts per port precisely so this cannot retire the
  // statement the other tab is reading.
  await guest.transport.request({ type: "unwatch", cacheKey: all.cacheKey });

  tabs.owner.create(TODOS, rowId("todo-2"), { title: "beta", done: false, rank: 2 }, txnId("txn-1"));
  await settle(() => tabs.owner.rows.size === 2);
  assert.deepEqual(
    ids(tabs.owner, all),
    ["todo-1", "todo-2"],
    "one tab's unwatch retired a statement it had never registered",
  );
});

/**
 * One worker, the tab that made it, and however many other tabs a test asks for.
 *
 * The owning tab is the assembly the application would write: a transport to the worker, a broker
 * connection registered as the provider, and one subscription forwarding each arriving port into
 * the worker. A guest tab is the whole of what such a tab needs — a broker connection, a port it
 * asked for, and a mirror over it. Neither mirror is told which it is.
 */
class Tabs {
  readonly db = compileOnlyKysely<Database>();
  readonly host: WeftWorkerHost;
  readonly store: SqliteClientStore;
  readonly owner: WeftClientMirror;
  readonly hub = new BrokerHub();
  readonly #executor: ReturnType<typeof openSqliteExecutor>;
  readonly #channel: MessageChannel;
  readonly #broker: WeftBrokerClient;
  readonly #transport: WorkerPortTransport;
  readonly #offPort: () => void;
  readonly #guests: GuestTab[] = [];
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
    this.#transport = new WorkerPortTransport(page);
    this.#broker = new WeftBrokerClient(this.hub.connect(), SCOPE);
    // The one line that lets another tab exist at all: a port the broker delivers is moved into the
    // worker, and from that moment this tab is not on that tab's path.
    this.#offPort = this.#broker.onPort((port) => {
      page.postMessage({ weft: "connect", port }, [port]);
    });
    this.#broker.provide();
    this.owner = new WeftClientMirror({ transport: this.#transport, scopeId: SCOPE, deviceId: DEVICE });
  }

  static open(): Tabs {
    return new Tabs(openSqliteExecutor(":memory:"));
  }

  /** Another tab that may not touch the database, reaching the worker over a port of its own. */
  async guest(): Promise<GuestTab> {
    const broker = new WeftBrokerClient(this.hub.connect(), SCOPE);
    const brokered = broker.requestPort();
    const transport = new WorkerPortTransport(brokered.port);
    // The same probe `openWeftDatabase` makes: the handover is not acknowledged, so the only
    // evidence the port reached the worker is the worker answering something over it, and what it
    // asks is the hydrate it was going to send first anyway.
    await transport.request({ type: "hydrate", scopeId: SCOPE, deviceId: DEVICE });
    const tab = new GuestTab(
      broker,
      transport,
      new WeftClientMirror({
        transport,
        scopeId: SCOPE,
        deviceId: deviceId(`device-${this.#guests.length + 2}`),
      }),
    );
    this.#guests.push(tab);
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
    for (const guest of this.#guests) guest.abandon();
    this.owner.dispose();
    this.#offPort();
    this.#broker.dispose();
    this.#transport.dispose();
    this.host.stop();
    this.hub.close();
    // An open port keeps Node's event loop alive, so a failing run that skipped these would hang
    // the whole file rather than report a failure.
    this.#channel.port1.close();
    this.#channel.port2.close();
    this.#executor.close();
  }
}

class GuestTab {
  readonly broker: WeftBrokerClient;
  readonly transport: WorkerPortTransport;
  readonly mirror: WeftClientMirror;
  /**
   * Every push that reached *this tab's* port, read off the transport rather than out of the
   * mirror. What the mirror kept is a second question: a mirror that was sent the whole scope's
   * statements and quietly dropped the surplus looks identical from the outside, and the tab is
   * woken either way.
   */
  readonly #pushes: WorkerPush[] = [];
  #closed = false;

  constructor(broker: WeftBrokerClient, transport: WorkerPortTransport, mirror: WeftClientMirror) {
    this.broker = broker;
    this.transport = transport;
    this.mirror = mirror;
    transport.onPush((push) => this.#pushes.push(push));
  }

  /** Which statements the last delta to this tab carried, in the order the worker listed them. */
  results(): readonly string[] {
    const last = this.#pushes.filter(isDeltaPush).at(-1);
    return last === undefined ? [] : last.results.map(([cacheKey]) => cacheKey);
  }

  clearPushes(): void {
    this.#pushes.length = 0;
  }

  /** The tab going away, in the order a `pagehide` handler would. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.mirror.dispose();
    // The goodbye, which is the only thing that tells the worker this tab is gone. Awaited, because
    // what a test asserts next is what the worker did with it.
    await this.transport.request({ type: "disconnect" }).catch(() => undefined);
    this.transport.dispose();
    this.broker.dispose();
  }

  /** Teardown for a tab a test never closed. Says nothing to the worker; the fixture is going. */
  abandon(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.mirror.dispose();
    this.transport.dispose();
    this.broker.dispose();
  }
}

function ids(mirror: WeftClientMirror, query: ReactiveSqlQuery): readonly string[] {
  return mirror.engine.getSqlSnapshot(query, mirror.select, mirror.rows).rows.map((row) => String(row.id));
}
