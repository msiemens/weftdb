// Generated writes over a client that lives in a worker.
//
// The read half of the OPFS path needs nothing of its own: a `WeftClientMirror` satisfies
// `SqlQuerySource`, so `use<Collection>` and `use<Collection>Query` run over it unchanged. The
// write half would need something, if generated mutators asked for a `WeftClient` by class, because
// a mirror is not one. `MutationTarget` names the shape instead, and this file is the claim that the
// shape is enough: the mutators the CLI emitted for the todo demo, handed a mirror, with an
// in-memory SQLite on the other end of a real `MessageChannel`.
//
// Nothing here is stubbed except OPFS itself. `openSqliteExecutor(":memory:")` is synchronous, which
// is the whole of what the worker host needs of a database, and a `node:worker_threads`
// MessageChannel structured-clones every message and delivers it on a later turn.
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId } from "weftdb/core";
import {
  serveWeftWorker,
  WeftClient,
  WeftClientMirror,
  WorkerPortTransport,
  type WeftWorkerHost,
  type MutationTarget,
  type WorkerMessage,
  type WorkerRequest,
} from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { asyncSqlExecutor, type AsyncSqlExecutor } from "weftdb/shared";
import { schemaHash } from "weftdb/schema";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import { schema } from "weftdb-demo-todo/schema";
import { todoEventsMutators, todosMutators } from "weftdb-demo-todo/bindings";
import { PortEndpoint } from "./multitab-fixtures.ts";

const SCOPE = scopeId("scope-1");
const DEVICE = deviceId("device-1");

/** Every NOT NULL column the generated DDL declares, because a row is written whole or not at all. */
const ALPHA = { title: "alpha", notes: "", done: false, rank: "a0", due_at: null, auto_delete_days: null };

test("§8.7 both a client and a mirror are what a generated mutator asks for", async () => {
  using bridge = await Bridge.open();
  // The assignments are the test. If either stops compiling, one of the two paths has lost its
  // generated writes and an application on that path has to hand-write every mutation.
  const inThePage: MutationTarget = new WeftClient(SCOPE, DEVICE, schema);
  const inAWorker: MutationTarget = bridge.mirror;

  for (const target of [inThePage, inAWorker]) {
    for (const verb of ["create", "append", "update", "delete"] as const) {
      assert.equal(typeof target[verb], "function", `a mutation target is missing ${verb}`);
    }
  }
});

test("§8.7 a generated create through a mirror reaches SQLite and comes back", async () => {
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();
  const todos = todosMutators(bridge.mirror);

  const writing = todos.create("todo-1", ALPHA);
  // Nothing is applied on this side, so the row is absent until the worker echoes it. A mirror that
  // wrote optimistically would have a row here and nothing to roll it back with.
  assert.equal(bridge.mirror.rows.size, 0, "the page applied a generated mutation itself");

  await writing;
  await bridge.settle(() => bridge.mirror.rows.has("todos\0todo-1"));

  assert.equal(bridge.mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("title")), "alpha");
  assert.equal(
    (await bridge.stored("todos", "todo-1"))?.["title"],
    "alpha",
    "a generated create never reached the worker's SQLite, so it dies with the tab",
  );
});

test("§8.7 a generated update and delete move the same row in both places", async () => {
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();
  const todos = todosMutators(bridge.mirror);

  await todos.create("todo-1", ALPHA);
  await bridge.settle(() => bridge.mirror.rows.has("todos\0todo-1"));

  await todos.update("todo-1", { title: "alpha prime", done: true });
  await bridge.settle(() => bridge.mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("done")) === true);
  assert.equal(bridge.mirror.rows.get("todos\0todo-1")?.fields.get(fieldName("title")), "alpha prime");
  assert.equal((await bridge.stored("todos", "todo-1"))?.["done"], 1);

  // A delete crosses back as a removed key rather than as a row, so a mirror that only applied
  // `rows` would keep rendering a row the worker and the database have both dropped.
  await todos.delete("todo-1");
  await bridge.settle(() => !bridge.mirror.rows.has("todos\0todo-1"));
  assert.equal(await bridge.stored("todos", "todo-1"), undefined, "the row survived a generated delete in SQLite");
});

test("§8.7 an event log's generated create appends rather than opening a mutable row", async () => {
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();

  // The class a row is opened as is settled by the op that opens it and never afterwards, so a
  // mutation target missing `append` would silently give an event log an ordinary row: it compiles,
  // it renders, and the relay refuses the next write to it.
  await todoEventsMutators(bridge.mirror).create("event-1", { todo_id: "todo-1", kind: "created", actor: "laptop" });
  await bridge.settle(() => bridge.mirror.rows.has("todo_events\0event-1"));

  assert.equal((await bridge.stored("todo_events", "event-1"))?.["kind"], "created");
  const queued = bridge.host.client?.outbox.filter((op) => op.rowId === rowId("event-1")) ?? [];
  assert.equal(
    queued.filter((op) => op.kind === "append").length,
    1,
    "an event log row was opened as a mutable row, which the relay refuses to write to again",
  );
  assert.equal(queued.filter((op) => op.kind === "create").length, 0);
});

test("§8.7 a mirror answers a direct read from the last push", async () => {
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();
  const todos = todosMutators(bridge.mirror);
  const table = tableName("todos");

  await todos.create("todo-1", ALPHA);
  await todos.create("todo-2", { ...ALPHA, title: "beta", rank: "a1" });
  // A second collection, because a read that ignored the collection would answer with its rows too
  // and a list would render an event where a todo belongs.
  await todoEventsMutators(bridge.mirror).create("event-1", { todo_id: "todo-1", kind: "created", actor: "laptop" });
  await bridge.settle(() => bridge.mirror.rows.size === 3);

  assert.equal(bridge.mirror.getRow(table, rowId("todo-1"))?.fields.get(fieldName("title")), "alpha");
  assert.deepEqual(
    bridge.mirror
      .listRows(table)
      .map((row) => row.id)
      .sort(),
    ["todo-1", "todo-2"],
  );
  // A row outside the hydrated scope, or one whose delta is still crossing, reads as missing.
  assert.equal(bridge.mirror.getRow(table, rowId("todo-9")), undefined, "a mirror answered for a row it has not");
});

test("§8.7 a materialized row from a mirror does not alias the mirror's own row", async () => {
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();
  const table = tableName("todos");

  await todosMutators(bridge.mirror).create("todo-1", ALPHA);
  await bridge.settle(() => bridge.mirror.getRow(table, rowId("todo-1")) !== undefined);

  const row = bridge.mirror.getRow(table, rowId("todo-1"));
  assert.notEqual(row?.fields, bridge.mirror.rows.get("todos\0todo-1")?.fields);
  // Frozen, so a caller cannot write a field onto a row the next push is about to replace and be
  // left wondering where the value went.
  assert.equal(Object.isFrozen(row), true);
});

/**
 * The worker host with an in-memory SQLite behind it, and a mirror on the other end of a real port.
 * The same assembly as `worker-bridge`, over the todo demo's schema so the generated code under
 * test is the code the CLI actually emits rather than a hand-written stand-in.
 */
class Bridge {
  readonly mirror: WeftClientMirror;
  /** The mirror's transport, owned here rather than by the mirror: a leader tab needs it too. */
  readonly transport: WorkerPortTransport;
  readonly host: WeftWorkerHost;
  readonly store: SqliteClientStore;
  readonly #executor: AsyncSqlExecutor;
  readonly #close: () => void;
  readonly #channel: MessageChannel;

  private constructor(executor: AsyncSqlExecutor, store: SqliteClientStore, close: () => void) {
    this.#executor = executor;
    this.#close = close;
    this.store = store;
    this.#channel = new MessageChannel();
    this.host = serveWeftWorker({
      port: new PortEndpoint<WorkerRequest>(this.#channel.port2),
      executor,
      store,
      schemaHash: schemaHash(schema),
    });
    this.transport = new WorkerPortTransport(new PortEndpoint<WorkerMessage>(this.#channel.port1));
    this.mirror = new WeftClientMirror({ transport: this.transport, scopeId: SCOPE, deviceId: DEVICE });
  }

  static async open(): Promise<Bridge> {
    const file = openSqliteExecutor(":memory:");
    const executor = asyncSqlExecutor(file);
    const store = new SqliteClientStore(executor, schema);
    await store.installSchema();
    return new Bridge(executor, store, () => {
      file.close();
    });
  }

  /** What SQLite holds for a row, which is what survives the tab. */
  async stored(table: string, id: string): Promise<Record<string, unknown> | undefined> {
    return this.#executor.get({
      sql: `SELECT * FROM "${table}" WHERE scope_id = ? AND id = ?`,
      parameters: [SCOPE, id],
      decode: (row) => ({ ...row }),
    });
  }

  /**
   * A `MessagePort` delivers on a later turn of the loop and a generated mutator returns before
   * anything has crossed it, so a test waits on the condition rather than on a guessed number of
   * ticks.
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
    // An open port keeps Node's event loop alive, so a failing run that skipped this would hang the
    // whole file rather than report a failure.
    this.#channel.port1.close();
    this.#channel.port2.close();
    this.#close();
  }
}

test("§8.7 two collections can be written in one transaction through the generated mutators", async () => {
  // The relay applies a transaction as a unit, so a status change and the event that records it
  // have to share one or they are two writes that can be accepted separately — leaving a history
  // that disagrees with the row it describes. The `txnId` parameter is what says so.
  const client = new WeftClient(SCOPE, DEVICE, schema, () => 1_000);
  const shared = txnId("status-and-history");

  await todosMutators(client).create("todo-1", ALPHA, shared);
  await todoEventsMutators(client).create("event-1", { todo_id: "todo-1", kind: "created", actor: "laptop" }, shared);

  const transactions = new Set(client.outbox.map((op) => String(op.txnId)));
  assert.deepEqual([...transactions], ["status-and-history"], "the two collections were written separately");
});

test("§8.7 a generated mutator left to itself still mints its own transaction", async () => {
  // The parameter is optional, and the default has to stay: two unrelated edits sharing a
  // transaction would be refused together, so one rejected write would take the other with it.
  const client = new WeftClient(SCOPE, DEVICE, schema, () => 1_000);
  const todos = todosMutators(client);

  await todos.create("todo-1", ALPHA);
  await todos.create("todo-2", { ...ALPHA, rank: "a1" });

  assert.equal(new Set(client.outbox.map((op) => String(op.txnId))).size, 2, "two creates shared one transaction");
});
