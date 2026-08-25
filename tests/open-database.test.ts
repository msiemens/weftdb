// `openWeftDatabase` under §8.7: the whole page-side assembly, as one call.
//
// What is being tested is the composition, not the parts. Election, the channel name both halves
// have to agree on, the leader's relay subscription, one engine per mirror, the device identity,
// and the order the whole thing comes down in are each a mistake an application used to be able to
// make silently — no error, no type error, just rows that stop moving. Every test below fails when
// its line is removed, which is the only reason any of them is here.
//
// Everything is real except the browser. `node:worker_threads` MessageChannel stands in for the
// worker port, Node's own `BroadcastChannel` for the channel between tabs, and
// `openSqliteExecutor(":memory:")` for OPFS — so messages really are structured-cloned and really do
// arrive on a later turn, which is where the ordering mistakes live.
import assert from "node:assert/strict";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { test } from "vitest";
import { fieldName, rowId, tableName, txnId, wireText, type ScopeId, type WeftOp } from "weftdb/core";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { WeftServer } from "weftdb/server";
import {
  BroadcastDbProxy,
  compileOnlyKysely,
  databaseChannelName,
  deviceIdForScope,
  isDeltaPush,
  openWeftDatabase,
  reactiveSqlQuery,
  serveWeftWorker,
  WeftOpenError,
  type AsyncSyncTransport,
  type LockManagerLike,
  type MaterializedRow,
  type ReactiveSqlQuery,
  type ScopedRowQuery,
  type StorageLike,
  type WeftClientMirror,
  type WeftDatabase,
  type WeftWorkerHost,
  type WeftWorkerLike,
  type WeftWorkerReady,
  type WorkerMessage,
  type WorkerRequest,
} from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import type { Sqlite3Module } from "weftdb/client/wasm-sqlite";
import { serveWeftWorkerDefaults } from "weftdb/client/worker-entry";
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

const TODOS = tableName("todos");
const HASH = schemaHash(schema);
const statements = compileOnlyKysely<Database>();

test("§8.7 one call opens, hydrates, and hands back a source a generated query reads", async () =>
  withBrowser(async (browser) => {
    const weft = await browser.open("scope-1");

    // What the generated hooks take. If this stops compiling, `openWeftDatabase` has handed back
    // something `use<Collection>Query` cannot read, and the front door is not a front door.
    const source: WeftSource = weft.source;
    assert.equal(source.scopeId, "scope-1");
    assert.equal(weft.role, "leader", "the first tab of a scope did not take the lock");

    weft.source.create(TODOS, rowId("todo-1"), { title: "alpha", done: false, rank: 1 }, txnId("txn-1"));
    const open = query("scope-1", (statement) => statement.where("done", "=", false).orderBy("rank"));
    await weft.source.watch(open);
    await settle(() => rowsOf(weft.source, open).length === 1);

    assert.deepEqual(titles(rowsOf(weft.source, open)), ["alpha"]);
    // And it is in SQLite rather than only in the mirror, which is the whole reason the client is
    // on the other side of the port.
    assert.equal(browser.stored("scope-1", "todo-1")?.["title"], "alpha");
  }));

test("§8.7 a second tab on the same scope follows, and a write in one appears in the other", async () =>
  withBrowser(async (browser) => {
    const leader = await browser.open("scope-1");
    const follower = await browser.open("scope-1");

    assert.equal(leader.role, "leader");
    assert.equal(follower.role, "follower", "a second tab opened a second database for one scope");
    // One worker between them. Two would mean two tabs holding one OPFS file, which is the case
    // the election exists to prevent.
    assert.equal(browser.workers.length, 1, "the follower started a worker of its own");

    const all = query("scope-1", (statement) => statement.orderBy("rank"));
    await leader.source.watch(all);
    await follower.source.watch(all);

    // The invariant this whole file is about. The leader's worker pushes the delta to the leader's
    // own transport; nothing else carries it to the other tab. Drop
    // `transport.onPush((push) => server.relayPush(push))` and the follower hydrates once and then
    // never moves again — no error, no rejection, just a list frozen at what it first loaded.
    leader.source.create(TODOS, rowId("todo-1"), { title: "typed in the leader", done: false, rank: 1 }, txnId("t1"));
    await settle(() => follower.source.rows.size === 1);
    assert.deepEqual(titles(rowsOf(follower.source, all)), ["typed in the leader"]);

    // And the other way, so this is not a relay that happens to work one way round. A follower's
    // own echo comes back over the channel too, so this leg also fails without the wiring.
    follower.source.update(TODOS, rowId("todo-1"), { title: "edited in the follower" }, txnId("t2"));
    await settle(() => titles(rowsOf(leader.source, all))[0] === "edited in the follower");
    assert.deepEqual(titles(rowsOf(follower.source, all)), ["edited in the follower"]);
  }));

test("§8.7 two tabs of one scope do not share a subscription engine", async () =>
  withBrowser(async (browser) => {
    const leader = await browser.open("scope-1");
    const follower = await browser.open("scope-1");
    leader.source.create(TODOS, rowId("todo-1"), { title: "alpha", done: false, rank: 1 }, txnId("txn-1"));
    await settle(() => follower.source.rows.size === 1);

    // Registered by the leader alone. The two tabs therefore have different answers for the same
    // statement, which is the only way to tell one engine from two.
    const all = query("scope-1", (statement) => statement.orderBy("rank"));
    await leader.source.watch(all);

    // The follower first, deliberately. An engine caches one snapshot per cache key per generation
    // and hands it back whichever mirror asks next, so a shared engine answers the leader out of
    // the follower's empty result — a tab reading a list it never registered would be given
    // another tab's rows, and a tab that did register one would be given nothing.
    const beforeAnyWatch = rowsOf(follower.source, all);
    assert.deepEqual(beforeAnyWatch, [], "a tab was answered for a statement it never registered");
    assert.deepEqual(
      titles(rowsOf(leader.source, all)),
      ["alpha"],
      "one tab's engine answered another tab's question, so the two share an engine",
    );
    assert.notEqual(
      snapshotOf(leader.source, all),
      snapshotOf(follower.source, all),
      "two mirrors handed out one snapshot object, so they are sharing an engine",
    );
  }));

test("§8.7 disposing a leader leaves nothing running", async () =>
  withBrowser(async (browser) => {
    const weft = await browser.open("scope-1");
    const worker = browser.workers[0];
    assert.notEqual(worker, undefined);
    weft.setToken("token-1");
    await settle(() => weft.status() !== undefined);

    await weft.dispose();

    // The worker was asked to close the database before it was stopped, rather than merely killed:
    // `close` is what makes it let go of the OPFS access handle, and a terminate that raced it
    // would leave the file locked against the tab taking over.
    assert.equal(worker?.host.client, undefined, "the worker was terminated without closing its database");
    assert.equal(
      worker?.host.session,
      undefined,
      "the sync session outlived the tab, so its poll timer is still running",
    );
    assert.equal(worker?.terminated, true, "the worker was left running");

    // The Web Lock is handed back, and after the handle was released rather than before. A
    // successor can only prove that by becoming the leader.
    const next = await browser.open("scope-1");
    assert.equal(next.role, "leader", "the lock was never released, so no tab can take over");

    // Nothing is left answering on the old tab's behalf either: the responder was stopped and the
    // channel closed, so a stale leader cannot answer beside the new one.
    await next.dispose();
    assert.equal(await answers("scope-1", browser.namespace), false, "somebody is still answering on a closed channel");

    // Idempotent, because a `pagehide` handler and an unmount both call it.
    await weft.dispose();
  }));

test("§8.7 disposing a follower hands its watches back and settles what was in flight", async () =>
  withBrowser(async (browser) => {
    const leader = await browser.open("scope-1");
    const follower = await browser.open("scope-1");
    const all = query("scope-1", (statement) => statement.orderBy("rank"));
    await follower.source.watch(all);

    await follower.dispose();
    // The unwatch crosses the channel while the leader's own mutation goes straight down the port,
    // so nothing but time orders the two. Waiting here is about the test's arrangement; what is
    // being asserted is that the registration was handed back at all.
    await delay(20);
    // A BroadcastChannel has no liveness signal, so a tab that went away without handing its
    // registrations back would leave the worker re-running this statement after every mutation any
    // tab makes for the rest of the session.
    leader.source.create(TODOS, rowId("todo-1"), { title: "alpha", done: false, rank: 1 }, txnId("txn-1"));
    await settle(() => leader.source.rows.size === 1);
    assert.deepEqual(
      browser.workers[0]?.lastResults(),
      [],
      "a disposed tab left its statement registered in the worker",
    );
  }));

test("§8.7 a device id is one per scope, kept across opens and never shared between scopes", async () =>
  withBrowser(async (browser) => {
    const first = await browser.open("scope-1");
    const minted = first.source.deviceId;
    assert.match(minted, /^[0-9a-f-]{36}$/u, "the device id was not minted with crypto.randomUUID");
    await first.dispose();

    // The same browser, opening the same scope again. A device that renamed itself on every load
    // would leave the relay a new device per visit, and this device's own past writes stamped by
    // somebody else.
    const again = await browser.open("scope-1");
    assert.equal(again.source.deviceId, minted, "the device id was minted again instead of being read back");

    // A second scope in the same browser is a second device: the relay counts devices per scope,
    // and one id shared between two would have each scope's cursor advanced by the other's pulls.
    const other = await browser.open("scope-2");
    assert.notEqual(other.source.deviceId, minted, "two scopes in one browser were opened as one device");

    // The storage is the caller's, and namespaced by scope, so this is checkable without a page.
    assert.equal(deviceIdForScope("scope-1", { storage: browser.storage, namespace: browser.namespace }), minted);
  }));

test("§8.7 a device with no OPFS pool is refused, and the failed open leaves nothing behind", async () =>
  withBrowser(async (browser) => {
    // Safari's private browsing mode, as the worker reports it: the page cannot know in advance —
    // whether a synchronous access handle pool exists is a property of the worker — so the worker
    // tries and says. What it must not do is hand back a database that answers every read and then
    // loses all of it on reload.
    const refused = browser.open("scope-1", {
      announce: {
        weft: "ready",
        ok: false,
        error: "this SQLite build has no OPFS sync access handle pool, so it cannot store anything synchronously",
      },
    });

    const error = await refused.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof WeftOpenError, "an unavailable pool was not reported as an open failure");
    assert.equal(error.reason, "storage-unavailable");
    assert.match(error.message, /OPFS synchronous\s+access handle pool/u, "the failure does not name what is missing");
    assert.match(error.message, /private browsing/u, "the failure does not name the browser condition");
    assert.match(error.message, /no OPFS sync access handle pool/u, "the worker's own reason was thrown away");

    // A failed open that leaks a worker is its own bug.
    assert.equal(browser.workers[0]?.terminated, true, "the refused open left its worker running");
    assert.equal(
      await answers("scope-1", browser.namespace),
      false,
      "the refused open left a responder on the channel",
    );
    // And it handed the lock back, so the next attempt is a fresh election rather than a follower
    // waiting on a leader that never existed.
    const next = await browser.open("scope-1");
    assert.equal(next.role, "leader", "the refused open kept the Web Lock");
  }));

test("§8.7 a page and a worker built from different schemas are refused", async () =>
  withBrowser(async (browser) => {
    const refused = browser.open("scope-1", {
      announce: { weft: "ready", ok: true, schemaHash: "a-schema-this-page-has-never-seen" },
    });
    const error = await refused.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof WeftOpenError);
    assert.equal(error.reason, "schema-mismatch");
    assert.equal(browser.workers[0]?.terminated, true, "the refused open left its worker running");
  }));

test("§8.7 a follower with no leader to reach is told, rather than waiting forever", async () =>
  withBrowser(async (browser) => {
    // A tab that lost the election while the winner was still starting its worker. A
    // BroadcastChannel queues nothing, so its hydrate would be posted to nobody and
    // `BroadcastDbProxy.request` has no deadline — which is a page that shows a spinner for the
    // rest of the session.
    browser.locks.hold(`weft:scope-1:opfs`);
    const error = await browser.open("scope-1", { leaderTimeoutMs: 150 }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof WeftOpenError, "a follower with no leader waited instead of reporting");
    assert.equal(error.reason, "no-leader");
    assert.match(error.message, /follower/u);
  }));

test("§8.7 the token option is read per credential and reaches the worker's session", async () =>
  withBrowser(async (browser) => {
    let token: string | null = "token-1";
    const weft = await browser.open("scope-1", { token: () => token });
    await settle(() => weft.status() !== undefined);
    assert.deepEqual(browser.tokens, ["token-1"], "the transport was not built from the token the page holds");

    // Refreshed on the page, and the session rebuilt around it. A socket presents its token once,
    // when it connects, so a token applied in place would leave a connection open under the
    // credential the person has stopped using — which is why this re-reads rather than caches.
    token = "token-2";
    weft.setToken();
    await settle(() => browser.tokens.length === 2);
    assert.deepEqual(browser.tokens, ["token-1", "token-2"]);

    weft.setToken(null);
    await settle(() => weft.status()?.online === false);
  }));

test("§8.7 a worker with no OPFS pool reports it rather than rejecting into nothing", async () => {
  // The worker-side front door's half of the same case. The failure has to leave the port as an
  // ordinary message: a rejection thrown here reaches the page as an `error` event with no detail,
  // or as an unhandled rejection with none at all, and `openWeftDatabase` would have nothing to
  // fail with but a timeout.
  const port = new CollectingPort();
  const host = await serveWeftWorkerDefaults({
    schema,
    port,
    // A build without `installOpfsSAHPoolVfs`, which is what Safari's private mode looks like from
    // inside the worker.
    sqlite3InitModule: async () => ({ oo1: { DB: class {} } }) as unknown as Sqlite3Module,
  });

  assert.equal(host, undefined, "a worker with nowhere to store anything served a database anyway");
  assert.deepEqual(port.sent.length, 1, "the worker said something other than whether it was ready");
  const [announced] = port.sent;
  assert.equal(announced?.weft, "ready");
  assert.equal(announced?.ok, false);
  assert.match(
    announced?.ok === false ? announced.error : "",
    /sync access handle pool/u,
    "the announcement does not say why there is no database",
  );
});

/**
 * One browser: one set of Web Locks, one `localStorage`, one relay, and whatever tabs a test opens
 * against them.
 *
 * The namespace is per browser rather than per suite, so two tests running in one process do not
 * elect each other's leaders or hear each other's channels — the channel name is derived from the
 * scope, which is the point, so the scope has to be made unique some other way.
 */
class Browser {
  readonly locks = new FakeLocks();
  readonly storage = new MemoryStorage();
  readonly namespace = `weft-test-${Math.trunc(performance.now() * 1000)}-${Math.trunc(Math.random() * 1e6)}`;
  readonly server = new WeftServer();
  /** Every token a transport was built from, in order, so "per credential" is an assertion. */
  readonly tokens: string[] = [];
  readonly workers: FakeWorker[] = [];
  readonly #opened: WeftDatabase[] = [];

  async open(scopeId: string, overrides: OpenOverrides = {}): Promise<WeftDatabase> {
    const announce: WeftWorkerReady = overrides.announce ?? { weft: "ready", ok: true, schemaHash: HASH };
    const weft = await openWeftDatabase({
      schema,
      scopeId,
      // Never dereferenced: `createWorker` is what turns it into a worker, and under Node that is
      // a MessageChannel with a `serveWeftWorker` on the far end.
      worker: "./storage-worker.ts",
      deviceStorage: this.storage,
      namespace: this.namespace,
      locks: this.locks,
      createWorker: () => {
        const worker = new FakeWorker(this, announce);
        this.workers.push(worker);
        return worker;
      },
      workerTimeoutMs: 2_000,
      ...(overrides.leaderTimeoutMs === undefined ? {} : { leaderTimeoutMs: overrides.leaderTimeoutMs }),
      ...(overrides.token === undefined ? {} : { relay: { token: overrides.token } }),
    });
    this.#opened.push(weft);
    return weft;
  }

  /** What SQLite holds for a row, which is what survives the tab. */
  stored(scopeId: string, id: string): Record<string, unknown> | undefined {
    return this.workers[0]?.executor.get({
      sql: 'SELECT * FROM "todos" WHERE scope_id = ? AND id = ?',
      parameters: [scopeId, id],
      decode: (row) => ({ ...row }),
    });
  }

  /** A transport per credential, so signing in as somebody else is a new one rather than a mutated one. */
  relay(token: string): AsyncSyncTransport {
    this.tokens.push(token);
    return {
      handshake: async (request) => this.server.handshake(request),
      push: async (scopeId: ScopeId, ops: WeftOp[]) => this.server.push(scopeId, ops),
      pull: async (scopeId: ScopeId, lastServerSeq: number) => this.server.pull(scopeId, lastServerSeq),
      snapshot: async (scopeId: ScopeId) => this.server.snapshot(scopeId),
    };
  }

  /**
   * Asynchronous, because a leader's teardown crosses a port: it asks the worker to close the
   * database before stopping it, and a test that walked away at that point would leave the file
   * handle and the process's event loop behind it.
   */
  async close(): Promise<void> {
    for (const weft of this.#opened) await weft.dispose();
    for (const worker of this.workers) worker.terminate();
  }
}

interface OpenOverrides {
  /** What the worker announces instead of a database it opened. */
  readonly announce?: WeftWorkerReady;
  readonly token?: () => string | null;
  readonly leaderTimeoutMs?: number;
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
 * A worker, as far as the page is concerned: it takes requests, sends replies and pushes, announces
 * itself once, and can be stopped.
 *
 * This is the seam. Node has no DOM `Worker`, and everything else `openWeftDatabase` does — the
 * election, deriving the channel name, branching leader and follower, the relay subscription, the
 * teardown order — is exactly the code a browser runs. Replacing the one line that cannot run here
 * is what lets the rest of it be tested rather than described.
 *
 * What it does at the end of its constructor is what `serveWeftWorkerDefaults` does at the end of
 * its own: announce, once the host is listening and never before, so a request cannot arrive while
 * there is nobody to receive it.
 */
class FakeWorker implements WeftWorkerLike {
  readonly host: WeftWorkerHost;
  readonly executor: ReturnType<typeof openSqliteExecutor>;
  terminated = false;
  /** Every delta the worker sent, as only a listener on the raw port can see them. */
  readonly #pushes: WorkerMessage[] = [];
  readonly #channel = new MessageChannel();
  readonly #page: PortEndpoint<WorkerMessage>;

  constructor(browser: Browser, announce: WeftWorkerReady) {
    this.executor = openSqliteExecutor(":memory:");
    const store = new SqliteClientStore(this.executor, schema);
    store.installSchema();
    this.host = serveWeftWorker({
      port: new PortEndpoint<WorkerRequest>(this.#channel.port2),
      executor: this.executor,
      store,
      session: {
        schemaHash: HASH,
        transport: (token) => browser.relay(token),
        // Long, because every test that syncs asks for it; a poll would only add noise.
        pollWhileBlindMs: 60_000,
        pollWhileLiveMs: 60_000,
        debounceMs: 5,
        now: () => 1_000,
      },
    });
    this.#page = new PortEndpoint<WorkerMessage>(this.#channel.port1);
    this.#page.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      if ("push" in event.data) this.#pushes.push(event.data);
    });
    this.#channel.port2.postMessage(announce);
  }

  postMessage(message: WorkerRequest): void {
    this.#page.postMessage(message);
  }

  addEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void {
    this.#page.addEventListener(type, listener);
  }

  removeEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void {
    this.#page.removeEventListener(type, listener);
  }

  /** Which statements the worker recomputed for the last push — its registry, seen from outside. */
  lastResults(): readonly string[] {
    const last = this.#pushes.filter(isDeltaPush).at(-1);
    return last === undefined ? [] : last.results.map(([cacheKey]) => cacheKey);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.host.stop();
    // The host's `close` gives the handle back when the page asked for one; this covers the paths
    // where it never got that far.
    try {
      this.executor.close();
    } catch {
      // Already closed by the request the page sent before it stopped us.
    }
    this.#channel.port1.close();
    this.#channel.port2.close();
  }
}

/** Web Locks, as `MultiTabCoordinator` asks for them: held for as long as the callback is pending. */
class FakeLocks implements LockManagerLike {
  readonly #held = new Set<string>();

  /** Takes a lock nobody hands back, so a test can make the next tab a follower. */
  hold(name: string): void {
    this.#held.add(name);
  }

  async request<T>(
    name: string,
    _options: { readonly ifAvailable: true },
    callback: (lock: object | null) => T | Promise<T>,
  ): Promise<T> {
    if (this.#held.has(name)) return await callback(null);
    this.#held.add(name);
    try {
      return await callback({});
    } finally {
      this.#held.delete(name);
    }
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

/** A port that keeps what the worker said, for the one test that reads the announcement directly. */
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

/** What a generated hook reads, without React: the engine, the source's `select`, and its rows. */
function snapshotOf(source: WeftClientMirror, statement: ReactiveSqlQuery) {
  return source.engine.getSqlSnapshot(statement, source.select, source.rows);
}

function rowsOf(source: WeftClientMirror, statement: ReactiveSqlQuery): readonly MaterializedRow[] {
  return snapshotOf(source, statement).rows;
}

function titles(rows: readonly MaterializedRow[]): readonly (string | undefined)[] {
  return rows.map((row) => wireText(row.fields.get(fieldName("title")) ?? ""));
}

/** Whether any tab is still answering for a scope. Used to prove a teardown really tore down. */
async function answers(scopeId: string, namespace: string): Promise<boolean> {
  const channel = new BroadcastChannel(databaseChannelName(scopeId, namespace));
  const proxy = new BroadcastDbProxy(channel);
  try {
    return await Promise.race([
      proxy.request({ type: "open", scopeId }).then(
        () => true,
        () => true,
      ),
      delay(200).then(() => false),
    ]);
  } finally {
    proxy.dispose();
    channel.close();
  }
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
    await delay(1);
  }
  // Two more turns, so a delta that arrives with the condition has finished crossing to the tab
  // that did not cause it before the assertions read either map.
  await delay(1);
  await delay(1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
