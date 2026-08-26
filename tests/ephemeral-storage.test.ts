// A window the browser has promised to forget, served rather than refused.
//
// A private browsing session gives no OPFS synchronous access handle pool, and until now that was
// the end of the application: the worker reported that it had opened nothing and `openWeftDatabase`
// rejected. It now opens the same SQLite in memory instead and says which of the two it got, so a
// page can tell the person that this window will not remember — which is what they asked the browser
// for. Nothing is written to `localStorage` to soften it: rows, outbox and quarantine all go with
// the window, a reload included.
//
// The distinction the whole file turns on is between a browser that *declined* the pool and a build
// that never had one. The first is a browsing mode and is served; the second is a bundle that
// shipped wrong, would work through every reload of development and lose every device's data in
// production, and is still refused.
//
// The SQLite is real. `@sqlite.org/sqlite-wasm` under Node has no `installOpfsSAHPoolVfs` at all,
// which is exactly the build-is-wrong case; a browser that declines the pool is modelled by putting
// the function back and having it throw. So an ephemeral database here is the same WebAssembly
// SQLite a browser would run, opened on `:memory:`.
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { test } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { fieldName, rowId, tableName, txnId, wireText } from "weftdb/core";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import {
  compileOnlyKysely,
  openWeftDatabase,
  reactiveSqlQuery,
  WeftOpenError,
  type MaterializedRow,
  type ReactiveSqlQuery,
  type ScopedRowQuery,
  type StorageLike,
  type WeftClientMirror,
  type WeftDatabase,
  type WeftWorkerHost,
  type WeftWorkerReady,
  type WorkerLike,
  type WorkerMessage,
  type WorkerRequest,
} from "weftdb/client";
import type { Sqlite3Module } from "weftdb/client/wasm-sqlite";
import { serveWeftWorkerDefaults } from "weftdb/client/worker-entry";
import { BrokerHub, PortEndpoint, QueuedLocks, settle, uniqueName } from "./multitab-fixtures.ts";

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

const TODOS = tableName("todos");
const HASH = schemaHash(schema);
const statements = compileOnlyKysely<Database>();

/** The build that ships to a browser, minus the one thing Node cannot give it. */
const sqlite3: Sqlite3Module = await sqlite3InitModule();

/**
 * A browser that has the pool VFS and will not hand out a pool: private browsing, from inside the
 * worker. The function is there, and installing it fails.
 */
const declining: Sqlite3Module = {
  oo1: sqlite3.oo1,
  installOpfsSAHPoolVfs: () =>
    Promise.reject(new Error("SecurityError: storage is not available in this browsing mode")),
};

test("§8.7 a browser that declines the OPFS pool is served an in-memory database and told which it got", async () => {
  const port = new CollectingPort();
  const host = await serveWeftWorkerDefaults({ schema, port, sqlite3InitModule: async () => declining });

  // Served, not refused. A worker that reported `ok: false` here is an application that does not
  // run at all in private browsing, which is the thing this path exists to stop.
  assert.notEqual(host, undefined, "a browser that declined the pool was left with no database");
  assert.equal(port.sent.length, 1, "the worker said something other than whether it was ready");
  const [announced] = port.sent;
  assert.equal(announced?.ok, true, "a browser that declined the pool was reported as having no storage");
  assert.equal(announced?.ok === true ? announced.schemaHash : "", HASH);
  // And the announcement says what kind of database it is. Without this the page cannot tell a
  // window that forgets from one that does not, and would promise durability it does not have.
  assert.equal(
    announced?.ok === true ? announced.durability : undefined,
    "ephemeral",
    "an in-memory database was announced as durable",
  );
  assert.equal(host?.durability, "ephemeral", "the host serving other tabs reports the wrong durability");
  host?.stop();
});

test("§8.7 a build with no pool VFS at all is refused rather than served from memory", async () => {
  // The trap the refusal exists for: a bundle whose sqlite3 has no `installOpfsSAHPoolVfs` works
  // identically in memory through every reload of development and loses every device's data in
  // production. It is a build that shipped wrong on *any* browser, so falling back would hide it
  // for exactly as long as it takes to reach users.
  const port = new CollectingPort();
  const host = await serveWeftWorkerDefaults({ schema, port, sqlite3InitModule: async () => sqlite3 });

  assert.equal(host, undefined, "a build with nowhere to store anything served a database anyway");
  assert.equal(port.sent.length, 1, "the worker said something other than whether it was ready");
  const [announced] = port.sent;
  assert.equal(announced?.ok, false, "a build with no pool VFS was quietly served from memory");
  assert.match(
    announced?.ok === false ? announced.error : "",
    /sync access handle pool/u,
    "the announcement does not say why there is no database",
  );
});

test("§8.7 a page opening against a build with no pool VFS still reports storage-unavailable", async () =>
  withBrowser(async (browser) => {
    // The page's half of the same case, through the real worker entry point rather than a hand-
    // written announcement: `storage-unavailable` has to stay reachable, and it now means this.
    const error = await browser.open("scope-1", { sqlite3: sqlite3 }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof WeftOpenError, "a build with no durable storage was allowed to open");
    assert.equal(error.reason, "storage-unavailable");
    assert.match(error.message, /sync access handle pool/u, "the worker's own reason was thrown away");
  }));

test("§8.7 an ephemeral database answers a compiled query with a WHERE and an ORDER BY", async () =>
  withBrowser(async (browser) => {
    // The claim that separates this design from a `localStorage` fallback. What is under the mirror
    // is SQLite, so the generated `use<Collection>Query` path — a Kysely statement compiled on the
    // page, `selectMatchingIds` run in the worker, ids back in the order the statement asked for —
    // has to work unchanged. A store that only kept a row map would answer the first assertion below
    // and neither of the other two.
    const weft = await browser.open("scope-1");
    assert.equal(weft.durability, "ephemeral");

    weft.source.create(TODOS, rowId("todo-1"), { title: "middle", done: false, rank: 2 }, txnId("txn-1"));
    weft.source.create(TODOS, rowId("todo-2"), { title: "first", done: false, rank: 1 }, txnId("txn-2"));
    weft.source.create(TODOS, rowId("todo-3"), { title: "finished", done: true, rank: 3 }, txnId("txn-3"));
    weft.source.create(TODOS, rowId("todo-4"), { title: "last", done: false, rank: 4 }, txnId("txn-4"));

    const open = query("scope-1", (statement) => statement.where("done", "=", false).orderBy("rank"));
    await weft.source.watch(open);
    await settle(() => rowsOf(weft.source, open).length === 3);

    // The WHERE really filtered — the done row is absent — and the ORDER BY really ordered, rather
    // than the rows arriving in whatever order they were written.
    assert.deepEqual(titles(rowsOf(weft.source, open)), ["first", "middle", "last"]);

    // And it is still SQL after a change: the same statement, recomputed in the worker, drops a row
    // that stopped matching.
    weft.source.update(TODOS, rowId("todo-2"), { done: true }, txnId("txn-5"));
    await settle(() => rowsOf(weft.source, open).length === 2);
    assert.deepEqual(titles(rowsOf(weft.source, open)), ["middle", "last"]);

    // Descending, so the order is the statement's own and not the insertion order read backwards by
    // luck.
    const newest = query("scope-1", (statement) => statement.orderBy("rank", "desc"));
    await weft.source.watch(newest);
    await settle(() => rowsOf(weft.source, newest).length === 4);
    assert.deepEqual(titles(rowsOf(weft.source, newest)), ["last", "finished", "middle", "first"]);
  }));

test("§8.7 a follower reports the same durability as the leader", async () =>
  withBrowser(async (browser) => {
    // The awkward half. A worker announces itself once, to the tab that created it, and a follower
    // is never there to hear it — it is handed a `MessagePort` and starts by asking `hydrate`. So
    // the value has to come back on that reply as well, or the same database in a second tab of one
    // browser tells the person the opposite thing about whether the window will remember.
    const leader = await browser.open("scope-1");
    const follower = await browser.open("scope-1");

    assert.equal(leader.role, "leader");
    assert.equal(follower.role, "follower", "a second tab opened a second database for one scope");
    assert.equal(browser.workers.length, 1, "the follower started a worker of its own");

    assert.equal(leader.durability, "ephemeral");
    assert.equal(follower.durability, "ephemeral", "a tab handed a port never learned what kind of database it is on");
  }));

test("§8.7 a write in an ephemeral database reaches the outbox, so the device still syncs", async () =>
  withBrowser(async (browser) => {
    // Ephemeral is about how long the database lasts, not about what it does. A device in private
    // browsing that queued nothing would be one whose edits never left the machine at all — the
    // application would appear to work and sync nothing, which is worse than refusing to open.
    const weft = await browser.open("scope-1");
    weft.source.create(
      TODOS,
      rowId("todo-1"),
      { title: "typed in a private window", done: false, rank: 1 },
      txnId("t"),
    );
    await settle(() => weft.source.rows.size === 1);

    const client = browser.worker.host?.client;
    assert.notEqual(client, undefined, "the ephemeral worker never hydrated a client");
    assert.ok((client?.outbox.length ?? 0) > 0, "a write in an ephemeral database queued nothing to push");
    assert.deepEqual(
      [...new Set(client?.outbox.map((op) => op.rowId))],
      ["todo-1"],
      "the outbox holds something other than the write that was made",
    );

    // And it is in SQLite rather than only in the mirror: this statement is compiled on the page and
    // run by the worker against the database it opened, so a row it matches is a row that was
    // written through the store.
    const typed = query("scope-1", (statement) => statement.where("title", "=", "typed in a private window"));
    await weft.source.watch(typed);
    await settle(() => rowsOf(weft.source, typed).length === 1);
    assert.deepEqual(titles(rowsOf(weft.source, typed)), ["typed in a private window"]);
  }));

/**
 * One browser in a private window: Web Locks, a `localStorage` for the device id alone, one broker,
 * and whatever tabs a test opens against them.
 *
 * There is deliberately no shared database file. That is the property being tested: each worker
 * opens `:memory:`, so a successor tab would find nothing — which is what a private window is.
 */
class Browser {
  readonly locks = new QueuedLocks();
  readonly storage = new MemoryStorage();
  readonly namespace = uniqueName("weft-ephemeral");
  readonly hub = new BrokerHub();
  readonly workers: EntryWorker[] = [];
  readonly #opened: WeftDatabase[] = [];

  async open(scopeId: string, overrides: { readonly sqlite3?: Sqlite3Module } = {}): Promise<WeftDatabase> {
    const weft = await openWeftDatabase({
      schema,
      scopeId,
      // Never dereferenced: `createWorker` and `createBroker` are what turn these into a worker and
      // a connection to one.
      worker: "./storage-worker.ts",
      broker: "./broker.ts",
      deviceStorage: this.storage,
      namespace: this.namespace,
      locks: this.locks,
      createWorker: () => {
        const worker = new EntryWorker(overrides.sqlite3 ?? declining);
        this.workers.push(worker);
        return worker;
      },
      createBroker: () => this.hub.connect(),
      workerTimeoutMs: 5_000,
    });
    this.#opened.push(weft);
    return weft;
  }

  get worker(): EntryWorker {
    const worker = this.workers.at(-1);
    if (worker === undefined) throw new Error("no worker was ever created");
    return worker;
  }

  async close(): Promise<void> {
    for (const weft of this.#opened) await weft.dispose();
    for (const worker of this.workers) worker.terminate();
    this.hub.close();
  }
}

async function withBrowser(body: (browser: Browser) => Promise<void>): Promise<void> {
  const browser = new Browser();
  try {
    await body(browser);
  } finally {
    await browser.close();
  }
}

/**
 * A dedicated worker running the shipped entry point, rather than a hand-assembled host.
 *
 * That is what makes these tests about the fallback: `serveWeftWorkerDefaults` is the one place that
 * decides between OPFS, memory and refusing, and a fixture that constructed the host itself would
 * have made that decision on its behalf.
 */
class EntryWorker implements WorkerLike {
  host: WeftWorkerHost | undefined;
  terminated = false;
  readonly #channel = new MessageChannel();
  readonly #page: PortEndpoint<WorkerMessage>;

  constructor(module: Sqlite3Module) {
    // Started before the entry point posts anything, exactly as a real worker's page-side handle is
    // in place before the worker's first turn runs.
    this.#page = new PortEndpoint<WorkerMessage>(this.#channel.port1);
    const port = new PortEndpoint<WorkerRequest>(this.#channel.port2);
    void serveWeftWorkerDefaults({ schema, port, sqlite3InitModule: async () => module }).then((host) => {
      this.host = host;
    });
  }

  postMessage(message: unknown, transfer?: readonly unknown[]): void {
    this.#page.postMessage(message, transfer);
  }

  addEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void {
    this.#page.addEventListener(type, listener);
  }

  removeEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void {
    this.#page.removeEventListener(type, listener);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.host?.stop();
    this.#channel.port1.close();
    this.#channel.port2.close();
  }
}

class MemoryStorage implements StorageLike {
  readonly #values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }
}

/** A port that keeps what the worker said, for the tests that read the announcement directly. */
class CollectingPort {
  readonly sent: WeftWorkerReady[] = [];

  postMessage(message: unknown): void {
    this.sent.push(message as WeftWorkerReady);
  }

  addEventListener(): void {
    // Nothing asks this port anything.
  }

  removeEventListener(): void {
    // As above.
  }
}

function query(
  scopeId: string,
  build: (statement: ScopedRowQuery<Database, "todos">) => ScopedRowQuery<Database, "todos">,
): ReactiveSqlQuery {
  return reactiveSqlQuery({
    tableName: TODOS,
    query: build(statements.selectFrom("todos").select("id").where("scope_id", "=", scopeId)),
  });
}

function rowsOf(source: WeftClientMirror, statement: ReactiveSqlQuery): readonly MaterializedRow[] {
  return source.engine.getSqlSnapshot(statement, source.select, source.rows).rows;
}

function titles(rows: readonly MaterializedRow[]): readonly (string | undefined)[] {
  return rows.map((row) => wireText(row.fields.get(fieldName("title")) ?? ""));
}
