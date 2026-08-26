// §8.7 end to end across tabs: one worker, and every tab holding a `MessagePort` straight to it.
//
// This is the case the pieces were built for and none of them shows alone. `worker-bridge` proves a
// mirror works against a worker port; only two of them against one worker answer the question that
// matters: does a tab render the same rows as the tab beside it while the worker answers each of
// them on its own port.
//
// Everything real except the browser. A `node:worker_threads` MessageChannel stands in for each
// tab's connection, so messages really are structured-cloned and really do arrive on a later turn —
// which is where the ordering mistakes are.
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId } from "weftdb/core";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { asyncSqlExecutor, type AsyncSqlExecutor } from "weftdb/shared";
import {
  compileOnlyKysely,
  isDeltaPush,
  reactiveSqlQuery,
  serveWeftWorker,
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
import { PortEndpoint, settle } from "./multitab-fixtures.ts";

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
const HASH = schemaHash(schema);

test("§8.7 a tab that was handed a port hydrates, mutates and watches through it", async () => {
  using tabs = await Tabs.open();
  await tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  await tabs.seed("todo-2", { title: "beta", done: true, rank: 2 });
  // Edited in that earlier session, so the rows arrive on different revisions and a tab that
  // renumbered them from one would be caught here rather than in a re-render three screens later.
  await tabs.seedUpdate("todo-1", "alpha prime");
  const guest = tabs.guest();

  await tabs.owner.mirror.hydrate();
  await guest.mirror.hydrate();

  assert.deepEqual([...guest.mirror.rows.keys()].sort(), ["todos\0todo-1", "todos\0todo-2"]);
  assert.equal(guest.mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("title")), "alpha prime");
  // The revision is the row's identity as far as `RowIdentityCache` is concerned. Both tabs read it
  // from the same worker over their own ports, so a port that rebuilt rows instead of carrying them
  // would have the two tabs disagree here.
  for (const [key, row] of guest.mirror.rows) {
    assert.equal(
      row.internals._weft_rev,
      tabs.owner.mirror.rows.get(key)?.internals._weft_rev,
      `${key} reached the second tab on a revision the first does not hold`,
    );
    assert.equal(row.internals._weft_rev, tabs.host.client?.rows.get(key)?.internals._weft_rev);
  }

  // And it can drive the worker, not only read it.
  const open = tabs.query((statement) => statement.where("done", "=", false).orderBy("rank"));
  await guest.mirror.watch(open);
  assert.deepEqual(ids(guest.mirror, open), ["todo-1"], "the second tab's watch answered with nothing");

  await guest.mirror.update(TODOS, rowId("todo-2"), { done: false }, txnId("txn-from-guest"));
  await settle(() => ids(guest.mirror, open).length === 2);
  assert.deepEqual(ids(guest.mirror, open), ["todo-1", "todo-2"]);
  assert.equal(
    (await tabs.stored("todo-2"))?.["done"],
    0,
    "a second tab's mutation never reached SQLite, so it dies with the tab",
  );
});

test("§8.7 one tab's mutation reaches every tab's mirror", async () => {
  using tabs = await Tabs.open();
  const guest = tabs.guest();
  await tabs.owner.mirror.hydrate();
  await guest.mirror.hydrate();

  const all = tabs.query((statement) => statement.orderBy("rank"));
  await tabs.owner.mirror.watch(all);
  await guest.mirror.watch(all);

  // From one tab, and back out to both. A worker that answered only the port that asked would leave
  // the other tab's list stale until something else happened to it — and that is the mistake this
  // design makes possible, because a response now *is* addressed to one port.
  await guest.mirror.create(
    TODOS,
    rowId("todo-1"),
    { title: "made in a guest tab", done: false, rank: 1 },
    txnId("txn-1"),
  );
  await settle(() => tabs.owner.mirror.rows.size === 1 && guest.mirror.rows.size === 1);

  for (const [name, mirror] of [
    ["the first tab", tabs.owner.mirror],
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
  await tabs.owner.mirror.update(TODOS, rowId("todo-1"), { title: "edited in the first tab" }, txnId("txn-2"));
  await settle(
    () => guest.mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("title")) === "edited in the first tab",
  );
  assert.equal(tabs.owner.mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("title")), "edited in the first tab");
});

test("§8.7 a tab is sent its own statements' results and never another tab's", async () => {
  // The routing rule for results, and the whole reason the host counts watches per port. A tab
  // rendering one list has no use for the lists its neighbours are rendering: a delta carrying them
  // wakes this tab's engine and it re-scans its own subscriptions to learn that nothing it reads
  // has moved. So the assertion is on what crossed the port, not on what the mirror kept — a mirror
  // that filtered the surplus out would pass a test written the second way while the tab went on
  // being woken by every query in the browser.
  using tabs = await Tabs.open();
  await tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  await tabs.seed("todo-2", { title: "beta", done: true, rank: 2 });
  const first = tabs.guest();
  const second = tabs.guest();
  await tabs.owner.mirror.hydrate();
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
  const ownerPushes = tabs.owner.pushes();
  first.clearPushes();
  second.clearPushes();
  await first.mirror.update(TODOS, rowId("todo-1"), { done: true }, txnId("txn-1"));
  await settle(() => ids(first.mirror, open).length === 0 && ids(second.mirror, done).length === 2);
  assert.deepEqual(ids(second.mirror, done), ["todo-1", "todo-2"]);

  assert.deepEqual(first.results(), [open.cacheKey], "a tab was sent the results of another tab's statement");
  assert.deepEqual(second.results(), [done.cacheKey], "a tab was sent the results of another tab's statement");
  // And the tab that watches nothing at all is pushed to — the row is the scope's — and told about
  // no statement whatever.
  assert.ok(tabs.owner.pushes() > ownerPushes, "the tab that watches nothing was not told the row had moved");
  assert.deepEqual(tabs.owner.results(), [], "a tab watching nothing was sent somebody else's results");
});

test("§8.7 two tabs watching one statement do not retire it from under each other", async () => {
  using tabs = await Tabs.open();
  await tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  const guest = tabs.guest();
  await tabs.owner.mirror.hydrate();
  await guest.mirror.hydrate();

  // The same statement, so the same cache key: the host keys its registry by that and nothing else.
  const all = tabs.query((statement) => statement.orderBy("rank"));
  await tabs.owner.mirror.watch(all);
  await guest.mirror.watch(all);
  assert.deepEqual(ids(tabs.owner.mirror, all), ["todo-1"]);

  guest.mirror.unwatch(all);
  await settle(() => guest.mirror.select(all) === undefined);

  // A row joining the list, not merely changing inside it. A mirror whose registration was retired
  // keeps the ids it last had, so an edit to an existing row leaves the two indistinguishable —
  // only a change of membership tells a live list from a frozen one.
  await tabs.owner.mirror.create(TODOS, rowId("todo-2"), { title: "beta", done: false, rank: 2 }, txnId("txn-1"));
  await settle(() => tabs.owner.mirror.rows.size === 2);

  // Without a reference count the second tab's unwatch deletes the shared registration, and the
  // first tab's list silently stops updating — no error anywhere, just a list frozen at the ids it
  // happened to have when the other tab let go.
  assert.deepEqual(
    ids(tabs.owner.mirror, all),
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
  tabs.owner.mirror.unwatch(all);
  const before = tabs.owner.pushes();
  await tabs.owner.mirror.update(TODOS, rowId("todo-1"), { title: "alpha prime" }, txnId("txn-2"));
  await settle(() => tabs.owner.pushes() > before);
  assert.deepEqual(tabs.host.watching, [], "the worker kept recomputing a statement every tab had released");
});

test("§8.7 a tab that disconnects has its watches released by the worker", async () => {
  using tabs = await Tabs.open();
  await tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  const guest = tabs.guest();
  await tabs.owner.mirror.hydrate();
  await guest.mirror.hydrate();

  const all = tabs.query((statement) => statement.orderBy("rank"));
  await guest.mirror.watch(all);
  assert.deepEqual(tabs.host.watching, [all.cacheKey], "the guest's statement was never registered");

  // A tab going away, orderly: `pagehide` disposes the mirror and says goodbye on its port. A
  // `MessagePort` has no liveness signal the worker can rely on, so a tab that simply stopped would
  // leave the worker running this statement after every mutation any tab makes, for ever.
  await guest.close();

  await tabs.owner.mirror.create(TODOS, rowId("todo-2"), { title: "beta", done: false, rank: 2 }, txnId("txn-1"));
  await settle(() => tabs.owner.mirror.rows.size === 2);

  assert.deepEqual(tabs.host.watching, [], "a disconnected tab left its statement registered in the worker");
  assert.equal(tabs.host.connections, 1, "the worker is still serving a port whose tab has gone");
});

test("§8.7 a tab may not release a registration it never took", async () => {
  using tabs = await Tabs.open();
  await tabs.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  const guest = tabs.guest();
  await tabs.owner.mirror.hydrate();
  await guest.mirror.hydrate();

  const all = tabs.query((statement) => statement.orderBy("rank"));
  await tabs.owner.mirror.watch(all);
  assert.deepEqual(ids(tabs.owner.mirror, all), ["todo-1"]);

  // Straight down the port, bypassing the mirror's own reference counting: a tab handing back a
  // registration it never made. The worker counts per port precisely so this cannot retire the
  // statement the other tab is reading.
  await guest.transport.request({ type: "unwatch", cacheKey: all.cacheKey });

  await tabs.owner.mirror.create(TODOS, rowId("todo-2"), { title: "beta", done: false, rank: 2 }, txnId("txn-1"));
  await settle(() => tabs.owner.mirror.rows.size === 2);
  assert.deepEqual(
    ids(tabs.owner.mirror, all),
    ["todo-1", "todo-2"],
    "one tab's unwatch retired a statement it had never registered",
  );
});

/**
 * One worker and however many tabs a test asks for, each of them a `MessageChannel`: the worker end
 * goes to the host, and the page end carries that tab's transport and the mirror over it.
 *
 * The tab the fixture opens for itself is built the same way as every later one, and nothing below
 * this line can tell them apart.
 */
class Tabs {
  readonly db = compileOnlyKysely<Database>();
  readonly host: WeftWorkerHost;
  readonly store: SqliteClientStore;
  readonly owner: Tab;
  readonly #executor: AsyncSqlExecutor;
  readonly #close: () => void;
  readonly #tabs: Tab[] = [];

  private constructor(executor: AsyncSqlExecutor, store: SqliteClientStore, close: () => void) {
    this.#executor = executor;
    this.store = store;
    this.#close = close;
    this.host = serveWeftWorker({ executor, store, schemaHash: HASH });
    this.owner = this.guest();
  }

  static async open(): Promise<Tabs> {
    const file = openSqliteExecutor(":memory:");
    const executor = asyncSqlExecutor(file);
    const store = new SqliteClientStore(executor, schema);
    await store.installSchema();
    return new Tabs(executor, store, () => {
      file.close();
    });
  }

  /** One more tab, reaching the same worker over a port of its own. */
  guest(): Tab {
    const tab = new Tab(this.host, deviceId(`device-${this.#tabs.length + 1}`));
    this.#tabs.push(tab);
    return tab;
  }

  /** A row written straight into the database, as a previous session would have left it. */
  async seed(id: string, values: { title: string; done: boolean; rank: number }): Promise<void> {
    const seeding = await this.store.hydrate(SCOPE, DEVICE);
    await seeding.create(
      TODOS,
      rowId(id),
      { [fieldName("title")]: values.title, [fieldName("done")]: values.done, [fieldName("rank")]: values.rank },
      txnId(`seed-${id}`),
    );
  }

  /** An edit made in a previous session, which is what lifts a row's revision above its first. */
  async seedUpdate(id: string, title: string): Promise<void> {
    const seeding = await this.store.hydrate(SCOPE, DEVICE);
    await seeding.update(TODOS, rowId(id), { [fieldName("title")]: title }, txnId(`seed-edit-${id}`));
  }

  query(build: (statement: ScopedRowQuery<Database, "todos">) => ScopedRowQuery<Database, "todos">): ReactiveSqlQuery {
    return reactiveSqlQuery({
      tableName: TODOS,
      query: build(this.db.selectFrom("todos").select("id").where("scope_id", "=", SCOPE)),
    });
  }

  /** What SQLite holds for a row, which is what survives every tab. */
  async stored(id: string): Promise<Record<string, unknown> | undefined> {
    return this.#executor.get({
      sql: 'SELECT * FROM "todos" WHERE scope_id = ? AND id = ?',
      parameters: [SCOPE, id],
      decode: (row) => ({ ...row }),
    });
  }

  [Symbol.dispose](): void {
    for (const tab of this.#tabs) tab.abandon();
    this.host.stop();
    this.#close();
  }
}

/**
 * One tab: its channel to the worker, the transport over it, and the mirror a page would read.
 *
 * Every push that reached *this tab's* port is kept, read off the transport rather than out of the
 * mirror. What the mirror kept is a second question: a mirror that was sent the whole scope's
 * statements and quietly dropped the surplus looks identical from the outside, and the tab is
 * woken either way.
 */
class Tab {
  readonly transport: WorkerPortTransport;
  readonly mirror: WeftClientMirror;
  readonly #pushes: WorkerPush[] = [];
  readonly #channel: MessageChannel;
  #closed = false;

  constructor(host: WeftWorkerHost, device: string) {
    this.#channel = new MessageChannel();
    host.connect(new PortEndpoint<WorkerRequest>(this.#channel.port2));
    this.transport = new WorkerPortTransport(new PortEndpoint<WorkerMessage>(this.#channel.port1));
    this.transport.onPush((push) => this.#pushes.push(push));
    this.mirror = new WeftClientMirror({ transport: this.transport, scopeId: SCOPE, deviceId: device });
  }

  /** How many deltas the worker has sent this tab. */
  pushes(): number {
    return this.#pushes.length;
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
    this.#release();
  }

  /** Teardown for a tab a test never closed. Says nothing to the worker; the fixture is going. */
  abandon(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.mirror.dispose();
    this.#release();
  }

  #release(): void {
    this.transport.dispose();
    // An open port keeps Node's event loop alive, so a failing run that skipped this would hang the
    // whole file rather than report a failure.
    this.#channel.port1.close();
    this.#channel.port2.close();
  }
}

function ids(mirror: WeftClientMirror, query: ReactiveSqlQuery): readonly string[] {
  return mirror.engine.getSqlSnapshot(query, mirror.select, mirror.rows).rows.map((row) => String(row.id));
}
