// The page-to-worker bridge under §8.7: a `WeftClient` in the worker, a mirror of its rows on the
// page, and a row delta between them.
//
// The whole bridge is exercised in Node. `serveWeftWorker` takes its executor and its store as
// options, so `openSqliteExecutor(":memory:")` — synchronous, which is exactly what the host needs
// — stands in for OPFS, and a `node:worker_threads` MessageChannel stands in for the worker port.
// That is not a shortcut around a browser test: the messages really are structured-cloned and
// really do arrive on a later turn, which is where the ordering mistakes live.
import assert from "node:assert/strict";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { test } from "vitest";
import {
  deviceId,
  encodeHlc,
  fieldName,
  rowId,
  scopeId,
  tableName,
  txnId,
  type HlcString,
  type WireValue,
} from "weftdb/core";
import type { SqlExecutor, SqlStatement } from "weftdb/shared";
import { defineSchema, S } from "weftdb/schema";
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
import type { WeftSource } from "weftdb-react";

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

test("§8.7 a hydrate brings the worker's rows to the page with their revisions intact", async () => {
  using bridge = Bridge.open();
  bridge.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  bridge.seed("todo-2", { title: "beta", done: true, rank: 2 });
  // Edited in that earlier session, so the two rows come back on different revisions and a mirror
  // that started every row at one would be caught here rather than three tests later.
  bridge.seedUpdate("todo-1", "alpha prime");

  await bridge.mirror.hydrate();

  assert.deepEqual([...bridge.mirror.rows.keys()].sort(), ["todos\0todo-1", "todos\0todo-2"]);
  assert.equal(bridge.mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("title")), "alpha prime");
  // The revision is the row's identity as far as `RowIdentityCache` is concerned. A mirror that
  // renumbered it from zero would look right on the first render and then hand React an unchanged
  // object for a row that had changed, because the two sides' counters had drifted.
  for (const [key, row] of bridge.mirror.rows) {
    assert.equal(
      row.internals._weft_rev,
      bridge.workerRow(key)?.internals._weft_rev,
      `${key} arrived with a revision the worker does not hold`,
    );
  }
});

test("§8.7 a mutator returns void, and the row appears when the worker echoes it back", async () => {
  using bridge = Bridge.open();
  await bridge.mirror.hydrate();

  // The mutator returns nothing and returns at once: the mutation is applied in the worker, and
  // there is deliberately no optimistic local apply here to undo if it fails (DESIGN.md §259).
  bridge.mirror.create(TODOS, rowId("todo-1"), { title: "alpha", done: false, rank: 1 }, txnId("txn-1"));
  assert.equal(bridge.mirror.rows.size, 0, "the page applied the mutation itself rather than waiting for the echo");

  await bridge.settle(() => bridge.mirror.rows.size === 1);

  assert.equal(bridge.mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("title")), "alpha");
  // And it is on disk, not merely in the worker's memory: the point of moving the client across
  // the boundary is that `ClientPersistence.save` gets the live client on the thread that can
  // write synchronously.
  assert.equal(
    bridge.stored("todo-1")?.["title"],
    "alpha",
    "the worker echoed a row it had not written through to SQLite",
  );
});

test("§8.7 a watched statement's id list moves as rows start and stop matching it", async () => {
  using bridge = Bridge.open();
  bridge.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  bridge.seed("todo-2", { title: "beta", done: true, rank: 2 });
  await bridge.mirror.hydrate();

  const open = bridge.query((statement) => statement.where("done", "=", false).orderBy("rank"));
  await bridge.mirror.watch(open);
  assert.deepEqual(bridge.ids(open), ["todo-1"], "the watch did not answer with the ids it matched");

  // Leaving the result set and joining it are the two directions, and a mirror that only ever
  // added would keep showing a row the statement no longer matches.
  bridge.mirror.update(TODOS, rowId("todo-1"), { done: true }, txnId("txn-close"));
  await bridge.settle(() => bridge.ids(open).length === 0);

  bridge.mirror.update(TODOS, rowId("todo-2"), { done: false }, txnId("txn-open"));
  await bridge.settle(() => bridge.ids(open).length === 1);
  assert.deepEqual(bridge.ids(open), ["todo-2"]);
});

test("§8.7 a row that did not change is the same row after a push", async () => {
  using bridge = Bridge.open();
  bridge.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  bridge.seed("todo-2", { title: "beta", done: false, rank: 2 });
  await bridge.mirror.hydrate();

  const all = bridge.query((statement) => statement.orderBy("rank"));
  await bridge.mirror.watch(all);
  const before = bridge.snapshot(all);

  bridge.mirror.update(TODOS, rowId("todo-2"), { title: "beta prime" }, txnId("txn-1"));
  await bridge.settle(() => bridge.snapshot(all) !== before);
  const after = bridge.snapshot(all);

  // The delta carries only the rows that moved, so the untouched row keeps the object it had —
  // and with it the revision `RowIdentityCache` decides identity by. Rebuilding the whole row map
  // on every push would compile and pass every value assertion, and quietly re-render every row
  // of the list on every keystroke.
  assert.equal(after.rows[0], before.rows[0], "an untouched row lost its identity across a push");
  assert.notEqual(after.rows[1], before.rows[1], "a changed row kept its old object");
  assert.equal(after.rows[1]?.fields.get(fieldName("title")), "beta prime");
});

test("§8.7 the mirror's dirty flag says what the worker's client says", async () => {
  using bridge = Bridge.open();
  await bridge.mirror.hydrate();

  // One row made here and never pushed, and one the scope handed over. They have to differ, or a
  // mirror that hard-coded `true` would pass.
  bridge.mirror.create(TODOS, rowId("todo-1"), { title: "mine", done: false, rank: 1 }, txnId("txn-1"));
  await bridge.settle(() => bridge.mirror.rows.has("todos\0todo-1"));
  bridge.pullRow("todo-2", "theirs");
  bridge.mirror.update(TODOS, rowId("todo-1"), { title: "mine, edited" }, txnId("txn-2"));
  await bridge.settle(() => bridge.mirror.rows.has("todos\0todo-2"));

  for (const id of ["todo-1", "todo-2"]) {
    assert.equal(
      bridge.mirror.isRowDirty(TODOS, rowId(id)),
      bridge.host.client?.isRowDirty(TODOS, rowId(id)),
      `the mirror and the worker disagree about whether ${id} has unsent work`,
    );
  }
  assert.equal(bridge.mirror.isRowDirty(TODOS, rowId("todo-1")), true);
  assert.equal(bridge.mirror.isRowDirty(TODOS, rowId("todo-2")), false);
  // A row nobody holds is not dirty. Reading the counter off `undefined` would answer "yes".
  assert.equal(bridge.mirror.isRowDirty(TODOS, rowId("todo-9")), false);
});

test("§8.7 unwatching stops the worker running the statement at all", async () => {
  using bridge = Bridge.open();
  bridge.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  await bridge.mirror.hydrate();

  const all = bridge.query((statement) => statement.orderBy("rank"));
  await bridge.mirror.watch(all);
  // No wait between the two: one port delivers in the order things were posted, so the worker
  // has retired the registration before it ever sees the mutation.
  bridge.mirror.unwatch(all);

  bridge.counted.reset();
  bridge.mirror.update(TODOS, rowId("todo-1"), { title: "alpha prime" }, txnId("txn-1"));
  await bridge.settle(() => bridge.pushes.length > 0);

  // Not merely "the page stopped reading it": the worker re-runs every watched statement after
  // every mutation, so a registration it never dropped is a SQLite query per keystroke for a list
  // nothing is rendering.
  assert.equal(bridge.counted.ran(all.compiled.sql), 0, "the worker still ran a statement nobody is watching");
  assert.deepEqual(
    bridge.pushes
      .filter(isDeltaPush)
      .at(-1)
      ?.results.map(([cacheKey]) => cacheKey),
    [],
    "the worker pushed a result for an unwatched statement",
  );
  assert.deepEqual(bridge.ids(all), [], "the mirror kept answering from a statement it had unwatched");
});

test("§8.7 a push naming a statement the page never registered is ignored", async () => {
  using bridge = Bridge.open();
  await bridge.mirror.hydrate();

  // A worker that is a version ahead, or a result for a statement unwatched while the push was on
  // the wire. Neither is an error, and neither may be cached: the mirror would then answer a query
  // nothing had asked it to watch, out of ids it can never refresh.
  bridge.pushToPage({
    push: "delta",
    rows: [],
    removed: [],
    results: [["a statement nobody registered", ["todo-9"]]],
  });
  await delay(5);

  const unknown = bridge.query((statement) => statement.orderBy("rank"));
  assert.equal(bridge.mirror.select(unknown), undefined, "the mirror cached a result it was never watching");
  assert.equal(bridge.mirror.rows.size, 0);
});

test("§8.7 a statement nobody registered is not a statement that matched nothing", async () => {
  using bridge = Bridge.open();
  bridge.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  await bridge.mirror.hydrate();

  // A statement that would match the seeded row if anyone had asked the worker to run it, and one
  // the worker did run and that matched nothing. The mirror answers out of what the worker pushed,
  // so reporting both as an empty list is a list that will never fill wearing the appearance of a
  // list that is legitimately empty — which is what makes a missing registration invisible.
  const unregistered = bridge.query((statement) => statement.orderBy("rank"));
  const matchedNothing = bridge.query((statement) => statement.where("done", "=", true).orderBy("rank"));
  await bridge.mirror.watch(matchedNothing);

  assert.equal(bridge.mirror.select(unregistered), undefined, "an unregistered statement answered as an empty one");
  assert.deepEqual(bridge.mirror.select(matchedNothing), [], "a statement that ran and matched nothing had no answer");
  // And they still paint the same, which is the point: the states differ where something can act on
  // the difference, not in what a component renders.
  assert.deepEqual(bridge.ids(unregistered), []);
  assert.deepEqual(bridge.ids(matchedNothing), []);
});

test("§8.7 a registration still in flight is not an answer of no rows", async () => {
  using bridge = Bridge.open();
  bridge.seed("todo-1", { title: "alpha", done: false, rank: 1 });
  await bridge.mirror.hydrate();

  const open = bridge.query((statement) => statement.where("done", "=", false).orderBy("rank"));
  const ready = bridge.mirror.watch(open);
  // Registered, but the round trip has not come back. The worker will answer with `todo-1`, so an
  // empty list here is not this statement's answer — it is the absence of one.
  assert.equal(
    bridge.mirror.select(open),
    undefined,
    "a statement whose first answer was still crossing looked answered",
  );
  assert.deepEqual(bridge.ids(open), [], "a statement whose answer had not arrived rendered rows");

  await ready;
  assert.deepEqual(bridge.mirror.select(open), ["todo-1"], "the answer never replaced the absence");
});

test("§8.7 the mirror is a weft source as it stands", () => {
  using bridge = Bridge.open();
  // The point of the mirror is that a component reads it the same way it reads a client that has
  // the database on this thread: a row map, a `select`, and a scope. If this stops compiling, the
  // hooks and the worker path have drifted apart and every generated component on OPFS is broken.
  const source: WeftSource = bridge.mirror;
  assert.equal(typeof source.select, "function");
  assert.equal(source.scopeId, SCOPE);
});

test("§8.7 the worker transport ignores a push rather than mis-correlating it", async () => {
  const worker = new PushingWorker();
  const transport = new WorkerPortTransport(worker);

  let settled = false;
  const pending = transport.execute({ sql: "select 1", parameters: [] }).then((value) => {
    settled = true;
    return value;
  });

  // The push carries no request id. A transport that read `event.data.id` unconditionally would
  // look `undefined` up in its pending map — and any push that happened to carry a numeric field
  // named `id` would settle whichever request was wearing that number.
  worker.push({ push: "delta", rows: [], removed: [], results: [] });
  await delay(1);
  assert.equal(settled, false, "a push settled a request it had nothing to do with");

  worker.reply(1, "rows");
  assert.equal(await pending, "rows");
  transport.dispose();
});

/**
 * Both halves of the bridge, joined by a real `MessageChannel`: the host with an in-memory SQLite
 * on one end, the mirror on the other.
 */
class Bridge {
  readonly db = compileOnlyKysely<Database>();
  readonly mirror: WeftClientMirror;
  /** The mirror's transport, owned here rather than by the mirror: a leader tab needs it too. */
  readonly transport: WorkerPortTransport;
  readonly host: WeftWorkerHost;
  readonly counted: CountingExecutor;
  readonly store: SqliteClientStore;
  /** Every unsolicited delta the worker sent, in order, as a test can only see them here. */
  readonly pushes: WorkerPush[] = [];
  readonly #executor: ReturnType<typeof openSqliteExecutor>;
  readonly #channel: MessageChannel;

  private constructor(executor: ReturnType<typeof openSqliteExecutor>) {
    this.#executor = executor;
    this.counted = new CountingExecutor(executor);
    this.store = new SqliteClientStore(this.counted, schema);
    this.store.installSchema();
    this.#channel = new MessageChannel();
    this.host = serveWeftWorker({
      port: new PortEndpoint<WorkerRequest>(this.#channel.port2),
      executor: this.counted,
      store: this.store,
    });
    const page = new PortEndpoint<WorkerMessage>(this.#channel.port1);
    page.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      if ("push" in event.data) this.pushes.push(event.data);
    });
    this.transport = new WorkerPortTransport(page);
    this.mirror = new WeftClientMirror({ transport: this.transport, scopeId: SCOPE, deviceId: DEVICE });
  }

  static open(): Bridge {
    return new Bridge(openSqliteExecutor(":memory:"));
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

  /** A row the scope handed over, which is the only way to hold one with nothing unsent. */
  pullRow(id: string, title: string): void {
    const client = this.host.client;
    if (client === undefined) throw new Error("the worker has not hydrated");
    const hlc = encodeHlc({ wallMs: 1_000, counter: 0, deviceId: deviceId("device-elsewhere") });
    client.applyPull({
      serverSeq: 1,
      tombstoneFloorSeq: 0,
      rows: [
        {
          scopeId: SCOPE,
          tableName: TODOS,
          rowId: rowId(id),
          firstSeenAt: 1_000,
          class: "row",
          deletedHlc: null,
          registerHlc: null,
          serverSeq: 1,
        },
      ],
      // Every declared field, because the generated columns are NOT NULL: a row the scope hands
      // over arrives whole or not at all.
      fields: [
        pulledField(id, "title", title, hlc),
        pulledField(id, "done", false, hlc),
        pulledField(id, "rank", 1, hlc),
      ],
    });
  }

  query(build: (statement: ScopedRowQuery<Database, "todos">) => ScopedRowQuery<Database, "todos">): ReactiveSqlQuery {
    return reactiveSqlQuery({
      tableName: TODOS,
      query: build(this.db.selectFrom("todos").select("id").where("scope_id", "=", SCOPE)),
    });
  }

  snapshot(query: ReactiveSqlQuery) {
    return this.mirror.engine.getSqlSnapshot(query, this.mirror.select, this.mirror.rows);
  }

  ids(query: ReactiveSqlQuery): readonly string[] {
    return this.snapshot(query).rows.map((row) => String(row.id));
  }

  workerRow(key: string) {
    return this.host.client?.rows.get(key);
  }

  /** What SQLite holds for a row, which is what survives the tab. */
  stored(id: string): Record<string, unknown> | undefined {
    return this.#executor.get({
      sql: 'SELECT * FROM "todos" WHERE scope_id = ? AND id = ?',
      parameters: [SCOPE, id],
      decode: (row) => ({ ...row }),
    });
  }

  /** Posts a delta to the page directly, as a worker of another version might. */
  pushToPage(push: WorkerPush): void {
    this.#channel.port2.postMessage(push);
  }

  /**
   * A `MessagePort` delivers on a later turn of the loop and the mirror's mutators return before
   * anything has crossed, so a test waits on the condition rather than on a guessed number of
   * ticks. The engine's own listener fan-out is a microtask on top of that.
   */
  async settle(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("the bridge never reached the expected state");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // One more turn, so a push that arrives with the condition is fully applied before the
    // assertions read the map.
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  [Symbol.dispose](): void {
    this.mirror.dispose();
    this.transport.dispose();
    this.host.stop();
    // An open port keeps Node's event loop alive, so a failing run that skipped this would hang
    // the whole file rather than report a failure.
    this.#channel.port1.close();
    this.#channel.port2.close();
    this.#executor.close();
  }
}

function pulledField(id: string, name: string, value: WireValue, hlc: HlcString) {
  return {
    scopeId: SCOPE,
    tableName: TODOS,
    rowId: rowId(id),
    field: fieldName(name),
    value,
    hlc,
    serverSeq: 1,
    txnId: txnId(`pull-${id}`),
  };
}

/** Counts which statements were run, so "the worker stopped recomputing it" can be asserted. */
class CountingExecutor implements SqlExecutor {
  readonly #inner: SqlExecutor;
  #sql: string[] = [];

  constructor(inner: SqlExecutor) {
    this.#inner = inner;
  }

  reset(): void {
    this.#sql = [];
  }

  ran(sql: string): number {
    return this.#sql.filter((seen) => seen === sql).length;
  }

  all<Decoded>(statement: SqlStatement<Decoded>): readonly Decoded[] {
    this.#sql.push(statement.sql);
    return this.#inner.all(statement);
  }

  get<Decoded>(statement: SqlStatement<Decoded>): Decoded | undefined {
    return this.#inner.get(statement);
  }

  run(statement: { readonly sql: string; readonly parameters: readonly never[] }): void {
    this.#inner.run(statement);
  }

  transaction<Result>(body: () => Result): Result {
    return this.#inner.transaction(body);
  }
}

/**
 * A `MessagePort` in the shape each side expects of the other. It sends and receives both halves
 * of the protocol, which is what lets one class stand in for the page's `WorkerLike` and the
 * worker's `WorkerHostPortLike` alike.
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

  // `unknown` rather than the protocol's own union, because the protocol is no longer all that
  // crosses these ports: a tab that was handed a connection sends its `MessagePort` through one.
  postMessage(message: unknown): void {
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

/** A worker that sends a push and a reply on demand, so the two can be told apart. */
class PushingWorker {
  #listener: ((event: MessageEvent<WorkerMessage>) => void) | undefined;

  postMessage(_message: WorkerRequest): void {
    // Requests are answered by hand, from the test.
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void {
    this.#listener = listener;
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void {
    if (this.#listener === listener) this.#listener = undefined;
  }

  push(message: WorkerPush): void {
    this.#listener?.({ data: message } as MessageEvent<WorkerMessage>);
  }

  reply(id: number, value: unknown): void {
    this.#listener?.({ data: { id, ok: true, value } } as MessageEvent<WorkerMessage>);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
