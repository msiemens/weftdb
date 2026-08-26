// The worker's front door under §8.7: which database an arriving port turns out to be for, and
// what happens to that database when the last tab reading it goes away.
//
// A `SharedWorker` is identified by its script URL, so one instance serves every tab of an origin —
// tabs on different scopes, and tabs of two applications that share an origin and a bundle. A port
// arrives through `onconnect` saying nothing about which of those it wants, and the first request
// on it is what settles it.
//
// Everything here is real except IndexedDB: the worker, the store, the client and the WebAssembly
// SQLite under them are the shipped ones, and `node:worker_threads` channels carry the protocol, so
// messages are structured-cloned and delivered on a later turn.
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { test } from "vitest";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { weftDatabaseKey, WorkerPortTransport, type WorkerRequest } from "weftdb/client";
import { serveWeftStorageWorker, type WeftStorageWorker } from "weftdb/client/worker-entry";
import { memorySqlite } from "./storage-fixtures.ts";
import { PortEndpoint, settle } from "./multitab-fixtures.ts";

const schema = defineSchema({ todos: S.collection({ title: S.string() }) });

test("§8.7 a port is served the database its first request names", async () => {
  using origin = new Origin();
  const alpha = origin.connect();
  const beta = origin.connect();

  await hydrate(alpha, "scope-1", "alpha");
  await hydrate(beta, "scope-1", "beta");

  // Same scope, two applications sharing an origin. A worker keyed on the scope alone would hand
  // both tabs one client, and each would push the other's rows under its own device id.
  assert.deepEqual(
    [...origin.worker.serving].sort(),
    [weftDatabaseKey("scope-1", "alpha"), weftDatabaseKey("scope-1", "beta")].sort(),
  );

  await write(alpha, "todo-alpha", "in alpha");
  await settle(() => true);
  assert.deepEqual(await titles(alpha, "scope-1"), ["in alpha"]);
  assert.deepEqual(await titles(beta, "scope-1"), [], "one namespace's write reached another's database");
});

test("§8.7 a namespace and a scope that run together are still two databases", async () => {
  // The pair is composed with a length prefix, so namespace `a:b` with scope `c` and namespace `a`
  // with scope `b:c` cannot land on one key — which would be two applications sharing one client,
  // one outbox and one file, with nothing anywhere reporting it.
  using origin = new Origin();
  const first = origin.connect();
  const second = origin.connect();

  await hydrate(first, "c", "a:b");
  await hydrate(second, "b:c", "a");
  await write(first, "todo-1", "first");
  await settle(() => true);

  assert.equal(origin.worker.serving.length, 2, "two databases were served as one");
  assert.deepEqual(await titles(second, "b:c"), [], "one database's write reached the other");
});

test("§8.7 two tabs of one database share one client", async () => {
  using origin = new Origin();
  const first = origin.connect();
  const second = origin.connect();
  await hydrate(first, "scope-1", "weft");
  await hydrate(second, "scope-1", "weft");

  assert.deepEqual(origin.worker.serving, [weftDatabaseKey("scope-1", "weft")]);
  await write(first, "todo-1", "written next door");
  await settle(() => true);
  assert.deepEqual(await titles(second, "scope-1"), ["written next door"]);
});

test("§8.7 the database of a tab that has gone is dropped, and what it wrote is still there", async () => {
  // A `SharedWorker` outlives every tab of its origin, so a client nobody released stays in the
  // worker's heap until the browser stops it — and `IDBMirrorVFS` holds the whole database in that
  // heap. One per `(namespace, scope)` an origin has ever opened is the ceiling this avoids.
  using origin = new Origin();
  const first = origin.connect();
  await hydrate(first, "scope-1", "weft");
  await write(first, "todo-1", "committed");
  await first.request({ type: "disconnect" });
  first.dispose();
  await settle(() => origin.worker.serving.length === 0);

  const second = origin.connect();
  const delta = (await hydrate(second, "scope-1", "weft")) as { readonly rows: readonly { readonly id: string }[] };
  assert.deepEqual(
    delta.rows.map((row) => row.id),
    ["todo-1"],
    "a database reopened after its last tab left had lost what that tab committed",
  );
});

test("§8.7 a page built from another schema is told which one the worker serves", async () => {
  using origin = new Origin();
  const port = origin.connect();
  const delta = (await hydrate(port, "scope-1", "weft")) as { readonly schemaHash: string };
  assert.equal(delta.schemaHash, schemaHash(schema));
});

/** One origin's `SharedWorker`, and whatever tabs a test connects to it. */
class Origin {
  readonly worker: WeftStorageWorker = serveWeftStorageWorker({ schema, sqlite: memorySqlite() });
  readonly #opened: WorkerPortTransport[] = [];
  readonly #ports: MessageChannel[] = [];

  /** One more tab, connected the way `onconnect` connects one. */
  connect(): WorkerPortTransport {
    const channel = new MessageChannel();
    this.#ports.push(channel);
    this.worker.connect(new PortEndpoint<WorkerRequest>(channel.port2));
    const transport = new WorkerPortTransport(new PortEndpoint(channel.port1) as never);
    this.#opened.push(transport);
    return transport;
  }

  [Symbol.dispose](): void {
    for (const transport of this.#opened) transport.dispose();
    void this.worker.stop();
    // An open port keeps Node's event loop alive, so a failing run that skipped these would hang
    // the whole file rather than report a failure.
    for (const channel of this.#ports) {
      channel.port1.close();
      channel.port2.close();
    }
  }
}

function hydrate(transport: WorkerPortTransport, scopeId: string, namespace: string): Promise<unknown> {
  return transport.request({ type: "hydrate", scopeId, deviceId: `device-${namespace}`, namespace });
}

function write(transport: WorkerPortTransport, id: string, title: string): Promise<unknown> {
  return transport.request({
    type: "mutate",
    mutation: { kind: "create", tableName: "todos", rowId: id, txnId: `txn-${id}`, values: { title } },
  });
}

async function titles(transport: WorkerPortTransport, scopeId: string): Promise<readonly string[]> {
  const rows = (await transport.request({
    type: "execute",
    query: { sql: 'SELECT title FROM "todos" WHERE scope_id = ? ORDER BY id', parameters: [scopeId] },
  })) as readonly Record<string, unknown>[];
  return rows.map((row) => String(row["title"]));
}
