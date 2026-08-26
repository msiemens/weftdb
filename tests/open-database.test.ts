// `openWeftDatabase` under §8.7: the whole page-side assembly, as one call.
//
// What is being tested is the composition. Sending the `hydrate` that says which database a port is
// for, refusing a page and a worker built from different schemas, one engine per mirror, the device
// identity, reconnecting when the browser stops the worker, and the order the whole thing comes
// down in are each a mistake an application assembling this by hand makes silently — no error, no
// type error, just rows that stop moving.
//
// Everything is real except IndexedDB. `node:worker_threads` channels carry every tab's connection,
// the storage worker and the WebAssembly SQLite under it are the shipped ones, and the VFS keeps
// its files in memory — so messages really are structured-cloned and really do arrive on a later
// turn, which is where the ordering mistakes live.
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { test } from "vitest";
import { fieldName, rowId, tableName, txnId, wireText, type ScopeId, type WeftOp } from "weftdb/core";
import { defineSchema, S, schemaHash, type SchemaDefinition } from "weftdb/schema";
import type { HandshakeRequest, HandshakeResponse, PullBatch, Snapshot } from "weftdb/server";
import {
  compileOnlyKysely,
  deviceIdForScope,
  openWeftDatabase,
  reactiveSqlQuery,
  WeftOpenError,
  type AsyncSyncTransport,
  type MaterializedRow,
  type PushResult,
  type ReactiveSqlQuery,
  type StorageLike,
  type WeftDatabase,
  type WorkerLike,
} from "weftdb/client";
import { serveWeftStorageWorker, type WeftStorageWorker } from "weftdb/client/worker-entry";
import type { WeftSource } from "weftdb-react";
import { memorySqlite } from "./storage-fixtures.ts";
import { delay, PortEndpoint, settle, uniqueName, waitFor } from "./multitab-fixtures.ts";

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
const statements = compileOnlyKysely<Database>();

test("§8.7 one call opens, hydrates, and hands back a source a generated query reads", async () =>
  withBrowser(async (browser) => {
    const weft = await browser.open("scope-1");

    // What the generated hooks take. If this stops compiling, `openWeftDatabase` has handed back
    // something the code it exists to serve cannot read.
    const source: WeftSource = weft.source;
    assert.equal(source.scopeId, "scope-1");

    await weft.source.watch(todosOrdered("scope-1"));
    await weft.source.create(TODOS, rowId("todo-1"), values("alpha", 1), txnId("txn-1"));
    await settle(() => weft.source.rows.size === 1);

    assert.deepEqual(rowsOf(weft, "scope-1").map(title), ["alpha"]);
  }));

test("§8.7 two tabs of one scope read one client, and a write in one appears in the other", async () =>
  withBrowser(async (browser) => {
    const first = await browser.open("scope-1");
    const second = await browser.open("scope-1");

    await first.source.watch(todosOrdered("scope-1"));
    await second.source.watch(todosOrdered("scope-1"));
    await first.source.create(TODOS, rowId("todo-1"), values("alpha", 1), txnId("txn-1"));

    await settle(() => second.source.rows.size === 1);
    assert.deepEqual(rowsOf(second, "scope-1").map(title), ["alpha"], "the second tab never saw the first tab's row");
  }));

test("§8.7 two tabs of one scope do not share a subscription engine", async () =>
  withBrowser(async (browser) => {
    // One engine caches the last snapshot per query and the identity of each row by revision, so two
    // mirrors sharing one evict each other's entries on every render — which `useSyncExternalStore`
    // turns into an update loop rather than a slow render.
    const first = await browser.open("scope-1");
    const second = await browser.open("scope-1");
    assert.notEqual(first.source.engine, second.source.engine, "two tabs were handed one engine");
  }));

test("§8.7 one scope in two namespaces is two databases, and neither tab is in the other's", async () =>
  withBrowser(async (browser) => {
    const alpha = await browser.open("scope-1", { namespace: "alpha" });
    const beta = await browser.open("scope-1", { namespace: "beta" });

    await alpha.source.create(TODOS, rowId("todo-1"), values("alpha", 1), txnId("txn-1"));
    await settle(() => alpha.source.rows.size === 1);

    assert.equal(beta.source.rows.size, 0, "one application's write reached another application's database");
    // And they are two devices, because the device id is keyed by namespace as well as by scope.
    assert.notEqual(alpha.source.deviceId, beta.source.deviceId);
  }));

test("§8.7 the storage worker is reached at the URL the application named", async () =>
  withBrowser(async (browser) => {
    await browser.open("scope-1");
    assert.deepEqual(browser.urls, ["./storage-worker.ts"], "the worker was constructed at some other URL");
  }));

test("§8.7 a device id is one per scope, kept across opens and never shared between scopes", async () => {
  const storage = new MemoryStorage();
  const first = deviceIdForScope("scope-1", { storage });
  assert.equal(deviceIdForScope("scope-1", { storage }), first, "a second open minted a second device");
  assert.notEqual(deviceIdForScope("scope-2", { storage }), first, "two scopes were one device");
  // The relay counts devices per scope, so one id shared between two of them would have each
  // scope's cursor advanced by the other's pulls.
  assert.notEqual(deviceIdForScope("scope-1", { storage, namespace: "other" }), first);
});

test("§8.7 a page and a worker built from different schemas are refused", async () =>
  withBrowser(async (browser) => {
    const other = defineSchema({ todos: S.collection({ title: S.string(), extra: S.string() }) });
    await assert.rejects(
      () => browser.open("scope-1", { schema: other }),
      (error: unknown) =>
        error instanceof WeftOpenError &&
        error.reason === "schema-mismatch" &&
        error.message.includes(schemaHash(schema)),
      "a page reading a database generated from another schema was allowed to open",
    );
  }));

test("§8.7 a browser with no SharedWorker is refused before anything is opened", async () => {
  // Every tab reaches storage the same way, so a missing `SharedWorker` is the whole of storage
  // missing. There is no smaller database to fall back to.
  await assert.rejects(
    () =>
      openWeftDatabase({
        schema,
        scopeId: "scope-1",
        worker: "./storage-worker.ts",
        deviceStorage: new MemoryStorage(),
      }),
    (error: unknown) => error instanceof WeftOpenError && error.reason === "no-worker",
  );
});

test("§8.7 a browser with no localStorage to keep a device id in is refused", async () => {
  await assert.rejects(
    () => openWeftDatabase({ schema, scopeId: "scope-1", worker: "./storage-worker.ts" }),
    (error: unknown) => error instanceof WeftOpenError && error.reason === "no-device-storage",
  );
});

test("§8.7 disposing a tab hands its watches back and settles what was in flight", async () =>
  withBrowser(async (browser) => {
    const first = await browser.open("scope-1");
    const second = await browser.open("scope-1");
    const shared = todosOrdered("scope-1");
    await first.source.watch(shared);
    await second.source.watch(shared);
    const only = todosOrdered("scope-1", "second");
    await second.source.watch(only);

    await second.dispose();
    await settle(() => browser.watching.length === 1);

    // The statement the leaving tab held alone is retired; the one the staying tab is also reading
    // is not. A `SharedWorker` outlives every tab, so a registration nobody released is a statement
    // recomputed after every mutation for the rest of the browser's life.
    assert.deepEqual(browser.watching, [shared.cacheKey], "a dispose released the wrong registrations");
    await first.source.create(TODOS, rowId("todo-1"), values("alpha", 1), txnId("txn-1"));
    await settle(() => first.source.rows.size === 1);
    assert.deepEqual(rowsOf(first, "scope-1").map(title), ["alpha"], "the staying tab stopped being answered");
  }));

test("§8.7 the token option is read per credential and reaches the worker's session", async () =>
  withBrowser(async (browser) => {
    let token = "first";
    const weft = await browser.open("scope-1", { token: () => token });
    await waitFor(() => browser.tokens.length === 1, "the open never signed the device in");

    token = "second";
    // No argument re-reads the option: a token refreshed since the open is a new credential, and a
    // transport carries its token, so the session is rebuilt around it.
    await weft.setToken();
    await waitFor(() => browser.tokens.length === 2, "a refreshed token never reached the session");
    assert.deepEqual(browser.tokens, ["first", "second"]);
  }));

test("§8.7 a request in flight when the worker goes away rejects, and the re-hydrate shows what committed", async () =>
  withBrowser(async (browser) => {
    const weft = await browser.open("scope-1", { token: () => "token" });
    await weft.source.watch(todosOrdered("scope-1"));
    await weft.source.create(TODOS, rowId("todo-1"), values("committed", 1), txnId("txn-1"));
    await settle(() => weft.source.rows.size === 1);

    // A sync the relay never answers, so there is something outstanding when the worker goes.
    browser.stallRelay = true;
    const syncing = weft.source.sync().then(
      () => "resolved",
      () => "rejected",
    );
    await delay(10);
    await browser.stop();

    // Telling a caller that a write nobody performed had succeeded is the one outcome worse than
    // not knowing, so a request whose worker went away rejects.
    assert.equal(await syncing, "rejected", "a request the worker never answered was reported as having succeeded");

    // And the tab reconnects to whichever worker is serving now and reloads from the file, so what
    // it shows is whatever committed.
    // Waited on the statement and not on the rows: a reconnect pushes the scope's rows and the
    // answers to the statements this tab had registered as two separate messages, so a tab holding
    // the row is not yet a tab whose list has been recomputed.
    await waitFor(() => rowsOf(weft, "scope-1").length === 1, "the tab never reconnected");
    assert.deepEqual(rowsOf(weft, "scope-1").map(title), ["committed"]);
  }));

/**
 * One browser: one `localStorage`, one origin's storage, and one `SharedWorker` at a time serving
 * whatever tabs a test opens against them.
 *
 * The namespace is per browser rather than per suite, so two tests running in one process do not
 * read each other's rows out of a storage keyed by name.
 */
class Browser {
  readonly storage = new MemoryStorage();
  readonly namespace = uniqueName("weft-test");
  /** Which URLs a tab asked to connect to, so "the one the application named" is an assertion. */
  readonly urls: string[] = [];
  /** Every token a transport was built from, in order, so "per credential" is an assertion. */
  readonly tokens: string[] = [];
  /** Set to leave a sync in flight for ever, which is how "the worker went away mid-request" is arranged. */
  stallRelay = false;
  readonly #sqlite = memorySqlite();
  readonly #opened: WeftDatabase[] = [];
  readonly #ports: MessageChannel[] = [];
  #worker: WeftStorageWorker = this.#serve();

  /** Which statements the worker is still recomputing, by cache key. */
  get watching(): readonly string[] {
    return this.#worker.watching;
  }

  async open(
    scopeId: string,
    overrides: {
      readonly namespace?: string;
      readonly schema?: SchemaDefinition;
      readonly token?: () => string | null;
    } = {},
  ): Promise<WeftDatabase> {
    const weft = await openWeftDatabase({
      schema: overrides.schema ?? schema,
      scopeId,
      // Never dereferenced: `connect` is what turns this into a connection, and under Node that is a
      // `MessageChannel` with the shipped storage worker on the far end.
      worker: "./storage-worker.ts",
      deviceStorage: this.storage,
      namespace: overrides.namespace ?? this.namespace,
      connect: (url) => this.connect(url),
      ...(overrides.token === undefined ? {} : { relay: { token: overrides.token } }),
    });
    this.#opened.push(weft);
    return weft;
  }

  /** One tab's port, delivered to whichever worker is serving this origin now. */
  connect(url: URL | string): WorkerLike {
    this.urls.push(String(url));
    const channel = new MessageChannel();
    this.#ports.push(channel);
    this.#worker.connect(new PortEndpoint(channel.port2));
    return new PortEndpoint(channel.port1) as never;
  }

  /**
   * The browser stopping the worker under memory pressure: every port to it closes at once, and a
   * tab that constructs one again is served by a new instance over the same storage.
   */
  async stop(): Promise<void> {
    await this.#worker.stop();
    for (const channel of this.#ports) channel.port2.close();
    this.#ports.length = 0;
    this.#worker = this.#serve();
  }

  async close(): Promise<void> {
    for (const weft of this.#opened) await weft.dispose();
    await this.#worker.stop();
    // An open port keeps Node's event loop alive, so a failing run that skipped these would hang
    // the whole file rather than report a failure.
    for (const channel of this.#ports) {
      channel.port1.close();
      channel.port2.close();
    }
  }

  #serve(): WeftStorageWorker {
    return serveWeftStorageWorker({
      schema,
      sqlite: this.#sqlite,
      relay: {
        transport: (token) => {
          this.tokens.push(token);
          return this.#relay();
        },
        pollWhileBlindMs: 60_000,
      },
    });
  }

  /** A relay that answers nothing, so the only thing a session does here is be built. */
  #relay(): AsyncSyncTransport {
    const pending = async <Result>(): Promise<Result> => {
      if (this.stallRelay) return new Promise<Result>(() => undefined);
      throw new Error("this test's relay answers nothing");
    };
    return {
      handshake: async (_request: HandshakeRequest): Promise<HandshakeResponse> => pending(),
      push: async (_scopeId: ScopeId, _ops: WeftOp[]): Promise<PushResult> => pending(),
      pull: async (_scopeId: ScopeId, _lastServerSeq: number): Promise<PullBatch> => pending(),
      snapshot: async (_scopeId: ScopeId): Promise<Snapshot> => pending(),
    };
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

/** `localStorage`, as much of it as a device id needs. */
class MemoryStorage implements StorageLike {
  readonly #items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }
}

function todosOrdered(scopeId: string, exclude = "none"): ReactiveSqlQuery {
  const scoped = statements
    .selectFrom("todos")
    .select("id")
    .where("scope_id", "=", scopeId)
    .where("title", "!=", exclude)
    .orderBy("rank");
  return reactiveSqlQuery({ tableName: TODOS, query: scoped });
}

function rowsOf(weft: WeftDatabase, scopeId: string): readonly MaterializedRow[] {
  return weft.source.engine.getSqlSnapshot(todosOrdered(scopeId), weft.source.select, weft.source.rows).rows;
}

function title(row: MaterializedRow): string {
  return wireText(row.fields.get(fieldName("title")) ?? "");
}

function values(name: string, rank: number): Record<string, string | number | boolean> {
  return { title: name, done: false, rank };
}
