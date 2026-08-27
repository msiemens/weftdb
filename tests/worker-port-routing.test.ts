// §8.7 what one worker does once it is serving several tabs.
//
// Request ids are per tab and every tab counts from one, so two tabs can have a request numbered
// the same outstanding at once. A response addressed to the wrong port settles whatever request
// that tab happens to have outstanding under that number, and nothing anywhere reports a fault.
//
// Rows and results are routed differently, and both halves are checked here. A row belongs to the
// scope, so every port serving it is told. A result belongs to whoever registered the statement,
// and one tab's list means nothing to the tab beside it.
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId } from "weftdb/core";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import {
  compileOnlyKysely,
  reactiveSqlQuery,
  serveWeftWorker,
  WorkerPortTransport,
  type ReactiveSqlQuery,
  type WeftWorkerHost,
  type WorkerRequest,
} from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { asyncSqlExecutor } from "weftdb/shared";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import { PortEndpoint, settle } from "./multitab-fixtures.ts";

const schema = defineSchema({
  todos: S.collection({ title: S.string(), done: S.boolean(), rank: S.number() }),
});

interface Database {
  todos: { id: string; scope_id: string; created: string; title: string; done: boolean; rank: number };
}

const SCOPE = scopeId("scope-1");
const DEVICE = deviceId("device-1");
const NAMESPACE = "weft";
const TODOS = tableName("todos");

test("§8.7 a response goes to the tab that asked and to no other", async () => {
  using worker = await Worker.open();
  const first = worker.connect();
  const second = worker.connect();
  try {
    // Both tabs count their requests from one, so both have a request numbered 1 outstanding at
    // the same moment. Swapping the two answers settles each request with a value of the wrong
    // shape, and both promises still resolve, so a routing bug here would not throw.
    const executed = first.request({ type: "execute", query: query("one").compiled });
    const hydrated = second.request({
      type: "hydrate",
      scopeId: SCOPE,
      deviceId: "device-2",
      namespace: NAMESPACE,
    });

    const rows = (await executed) as readonly Record<string, unknown>[];
    const delta = (await hydrated) as { readonly rows: readonly unknown[] };
    assert.ok(Array.isArray(delta.rows), "the tab that hydrated was not answered with a delta");
    assert.deepEqual(
      rows.map((row) => row["id"]),
      ["todo-one"],
      "the executing tab was answered with another tab's result",
    );
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("§8.7 an error goes back to the tab whose request failed", async () => {
  using worker = await Worker.open();
  const first = worker.connect();
  const second = worker.connect();
  try {
    // `sync` needs a session and this worker has none, so it is refused. A refusal routed to every
    // port would reject a request another tab is waiting on, reporting an edit as failed when it
    // never was.
    const refused = second.request({ type: "sync" }).then(
      () => "resolved",
      () => "rejected",
    );
    const answered = first.request({ type: "hydrate", scopeId: SCOPE, deviceId: DEVICE, namespace: NAMESPACE }).then(
      () => "resolved",
      () => "rejected",
    );
    assert.equal(await refused, "rejected");
    assert.equal(await answered, "resolved", "a rejection meant for another tab was delivered here");
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("§8.7 a push reaches every connected tab", async () => {
  using worker = await Worker.open();
  const first = worker.connect();
  const second = worker.connect();
  const third = worker.connect();
  try {
    const seen = [first, second, third].map(() => 0);
    const offs = [first, second, third].map((transport, index) =>
      transport.onPush(() => {
        seen[index] = (seen[index] ?? 0) + 1;
      }),
    );
    await first.request({ type: "hydrate", scopeId: SCOPE, deviceId: "device-1", namespace: NAMESPACE });

    // One tab mutates, and the delta belongs to all of them, because the worker recomputes every
    // watched statement after every mutation, whichever tab caused it.
    await first.request({
      type: "mutate",
      mutation: {
        kind: "create",
        tableName: "todos",
        rowId: "todo-2",
        txnId: "txn-1",
        values: { title: "beta", done: false, rank: 2 },
      },
    });
    await settle(() => seen.every((count) => count > 0));
    assert.deepEqual(
      seen.map((count) => count > 0),
      [true, true, true],
      "a push did not reach every tab",
    );
    for (const off of offs) off();
  } finally {
    first.dispose();
    second.dispose();
    third.dispose();
  }
});

test("§8.7 a tab's watches are released by its own disconnect and by nobody else's", async () => {
  using worker = await Worker.open();
  const first = worker.connect();
  const second = worker.connect();
  try {
    await first.request({ type: "hydrate", scopeId: SCOPE, deviceId: "device-1", namespace: NAMESPACE });
    const shared = query("shared");
    const only = query("only");
    await first.request({ type: "watch", cacheKey: shared.cacheKey, tableName: "todos", query: shared.compiled });
    await second.request({ type: "watch", cacheKey: shared.cacheKey, tableName: "todos", query: shared.compiled });
    await second.request({ type: "watch", cacheKey: only.cacheKey, tableName: "todos", query: only.compiled });

    await second.request({ type: "disconnect" });
    second.dispose();
    await settle(() => worker.host.connections === 1);

    // The statement the leaving tab held alone is retired, and the one the staying tab is also
    // reading is not. Retiring both would freeze a list the remaining tab is rendering, and
    // retiring neither would leave the worker re-running a statement nobody reads for the rest of
    // the session, which under a `SharedWorker` is the rest of the browser's.
    //
    // Both halves are asserted because one port cannot see the whole of it. A delta carries only
    // the statements its own tab registered, so the retired one is invisible from here whether or
    // not the worker is still running it.
    assert.deepEqual(worker.host.watching, [shared.cacheKey], "a disconnect released the wrong registrations");
    const results = await worker.recompute(first);
    assert.deepEqual(results, [shared.cacheKey], "the staying tab stopped being answered for its own statement");
  } finally {
    first.dispose();
  }
});

test("§8.7 a worker whose last tab has gone says so", async () => {
  // A `SharedWorker` outlives every tab of its origin, so nothing else can tell the entry point
  // that a client is finished with it. Without this, one database per `(namespace, scope)` the
  // origin had ever opened stays resident for as long as the browser keeps the worker.
  using worker = await Worker.open();
  const first = worker.connect();
  const second = worker.connect();

  await first.request({ type: "disconnect" });
  first.dispose();
  assert.equal(worker.idle, 0, "a worker still serving a tab reported itself idle");

  await second.request({ type: "disconnect" });
  second.dispose();
  assert.equal(worker.idle, 1, "the last tab disconnecting left the worker holding its client");
});

/** One worker over an in-memory database, plus however many ports a test connects to it. */
class Worker {
  readonly host: WeftWorkerHost;
  readonly #close: () => void;
  readonly #idle: { count: number };
  readonly #opened: WorkerPortTransport[] = [];
  readonly #ports: MessageChannel[] = [];

  private constructor(host: WeftWorkerHost, close: () => void, idle: { count: number }) {
    this.host = host;
    this.#close = close;
    this.#idle = idle;
  }

  /** How many times the host has reported that nothing is connected to it. */
  get idle(): number {
    return this.#idle.count;
  }

  static async open(): Promise<Worker> {
    const file = openSqliteExecutor(":memory:");
    const executor = asyncSqlExecutor(file);
    const store = new SqliteClientStore(executor, schema);
    await store.installSchema();
    // A row already in the file, so `execute` has something to answer with that a hydrate's delta
    // could never be mistaken for.
    const seeding = await store.hydrate(SCOPE, DEVICE);
    await seeding.create(
      TODOS,
      rowId("todo-one"),
      { [fieldName("title")]: "one", [fieldName("done")]: false, [fieldName("rank")]: 1 },
      txnId("seed"),
    );
    const idle = { count: 0 };
    const host = serveWeftWorker({
      executor,
      store,
      schemaHash: schemaHash(schema),
      onIdle: () => {
        idle.count += 1;
      },
    });
    return new Worker(
      host,
      () => {
        file.close();
      },
      idle,
    );
  }

  /** One more tab, connected the way `onconnect` connects one, with a port of its own. */
  connect(): WorkerPortTransport {
    const channel = new MessageChannel();
    this.#ports.push(channel);
    this.host.connect(new PortEndpoint<WorkerRequest>(channel.port2));
    const transport = new WorkerPortTransport(new PortEndpoint(channel.port1) as never);
    this.#opened.push(transport);
    return transport;
  }

  /** Which statements the worker recomputed for the next push, seen from a tab's own port. */
  async recompute(transport: WorkerPortTransport): Promise<readonly string[]> {
    let results: readonly string[] = [];
    const off = transport.onPush((push) => {
      if (push.push === "delta") results = push.results.map(([cacheKey]) => cacheKey);
    });
    await transport.request({
      type: "mutate",
      mutation: {
        kind: "update",
        tableName: "todos",
        rowId: "todo-one",
        txnId: `txn-${String(Math.random())}`,
        values: { title: "one prime" },
      },
    });
    await settle(() => true);
    off();
    return results;
  }

  [Symbol.dispose](): void {
    for (const transport of this.#opened) transport.dispose();
    this.host.stop();
    // An open port keeps Node's event loop alive, so leaving one open when a test fails hangs the
    // whole file without ever reporting the failure.
    for (const channel of this.#ports) {
      channel.port1.close();
      channel.port2.close();
    }
    this.#close();
  }
}

const statements = compileOnlyKysely<Database>();

/** A statement that constrains `scope_id`, which is all `reactiveSqlQuery` insists on. */
function query(title: string): ReactiveSqlQuery {
  return reactiveSqlQuery({
    tableName: TODOS,
    query: statements
      .selectFrom("todos")
      .select("id")
      .where("scope_id", "=", SCOPE)
      .where("title", "!=", `never-${title}`)
      .orderBy("rank"),
  });
}
