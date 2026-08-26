// `openWeftDatabase` under §8.7: the whole page-side assembly, as one call.
//
// What is being tested is the composition, not the parts. Election, the port handover through the
// broker, forwarding an arriving port into the worker, one engine per mirror, the device identity,
// what happens when the tab holding the worker dies, and the order the whole thing comes down in
// are each a mistake an application used to be able to make silently — no error, no type error,
// just rows that stop moving. Every test below fails when its line is removed, which is the only
// reason any of them is here.
//
// Everything is real except the browser. `node:worker_threads` MessageChannel stands in for the
// worker port and for every tab's connection, the shipped broker relays those connections in this
// process, and `openSqliteExecutor(":memory:")` stands in for OPFS — so messages really are
// structured-cloned, ports really are transferred, and both really do arrive on a later turn, which
// is where the ordering mistakes live.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { test } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { fieldName, rowId, tableName, txnId, wireText, type ScopeId, type WeftOp } from "weftdb/core";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { WeftServer } from "weftdb/server";
import {
  compileOnlyKysely,
  deviceIdForScope,
  openWeftDatabase,
  reactiveSqlQuery,
  serveWeftWorker,
  WeftBrokerClient,
  weftDatabaseKey,
  WeftOpenError,
  WorkerPortTransport,
  type AsyncSyncTransport,
  type BrokerPortLike,
  type MaterializedRow,
  type ReactiveSqlQuery,
  type ScopedRowQuery,
  type StorageLike,
  type WeftClientMirror,
  type WeftDatabase,
  type WeftDurability,
  type WeftWorkerHost,
  type WeftWorkerReady,
  type WorkerLike,
  type WorkerMessage,
  type WorkerRequest,
} from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import type { Sqlite3Module, WasmDatabase } from "weftdb/client/wasm-sqlite";
import { serveWeftWorkerDefaults } from "weftdb/client/worker-entry";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import type { WeftSource } from "weftdb-react";
import { BrokerHub, delay, PortEndpoint, QueuedLocks, settle, waitFor } from "./multitab-fixtures.ts";

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

/**
 * The build that ships to a browser, minus the one thing Node cannot give it: this has no
 * `installOpfsSAHPoolVfs`, which is what `OpfsPools` puts back.
 */
const sqlite3: Sqlite3Module = await sqlite3InitModule();

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
    // And the second tab is on that one worker's own list of connections, not on a path through
    // the first tab: the count is what the worker itself is serving.
    assert.equal(browser.worker.host.connections, 2, "the second tab never reached the worker directly");

    const all = query("scope-1", (statement) => statement.orderBy("rank"));
    await leader.source.watch(all);
    await follower.source.watch(all);

    // The invariant this whole file is about. One worker pushes the delta, and it has to reach
    // every port it is serving rather than only the one that asked — a worker that answered the
    // mutating tab alone would leave the other hydrated once and never moving again, with no error
    // and no rejection, just a list frozen at what it first loaded.
    leader.source.create(TODOS, rowId("todo-1"), { title: "typed in the leader", done: false, rank: 1 }, txnId("t1"));
    await settle(() => follower.source.rows.size === 1);
    assert.deepEqual(titles(rowsOf(follower.source, all)), ["typed in the leader"]);

    // And the other way, so this is not a path that happens to work one way round.
    follower.source.update(TODOS, rowId("todo-1"), { title: "edited in the follower" }, txnId("t2"));
    await settle(() => titles(rowsOf(leader.source, all))[0] === "edited in the follower");
    assert.deepEqual(titles(rowsOf(follower.source, all)), ["edited in the follower"]);
  }));

test("§8.7 one scope in two namespaces is two databases, and neither tab is in the other's", async () =>
  withBrowser(async (browser) => {
    // A database is a namespace and a scope together. The scope alone used to name it, so two
    // applications sharing an origin — or one application keeping a second profile beside the first —
    // met at the Web Lock, at the broker, and on the OPFS pool, and the second of them silently
    // became another tab of the first's database. Under the same person's `scopeId`, which is
    // exactly when it would happen.
    const alpha = `${browser.namespace}-alpha`;
    const beta = `${browser.namespace}-beta`;
    const first = await browser.open("scope-1", { namespace: alpha });
    const second = await browser.open("scope-1", { namespace: beta });

    // Two elections rather than one. Only one tab can hold a lock, so two leaders is two locks —
    // and each of them built a worker of its own, which the single-namespace case forbids.
    assert.equal(first.role, "leader");
    assert.equal(second.role, "leader", "the second namespace lost an election it was never standing in");
    assert.equal(browser.workers.length, 2, "two namespaces shared one storage worker");
    assert.equal(browser.workers[0]?.host.connections, 1, "a tab of one namespace connected to the other's worker");
    assert.equal(browser.workers[1]?.host.connections, 1, "a tab of one namespace connected to the other's worker");
    // And two devices, because the device id is already namespaced. A shared one would have each
    // database's relay cursor advanced by the other's pulls.
    assert.notEqual(first.source.deviceId, second.source.deviceId, "two databases were opened as one device");

    const all = query("scope-1", (statement) => statement.orderBy("rank"));
    await first.source.watch(all);
    await second.source.watch(all);

    first.source.create(TODOS, rowId("todo-1"), { title: "in alpha", done: false, rank: 1 }, txnId("txn-1"));
    await settle(() => first.source.rows.size === 1);
    // Long enough for a delta to have crossed if anything were carrying one. Two tabs of one
    // database see each other's writes within a turn or two — see the test above.
    await delay(50);

    assert.equal(second.source.rows.size, 0, "a write in one namespace was pushed into another namespace's tab");
    assert.deepEqual(titles(rowsOf(second.source, all)), [], "one namespace's statement answered with another's rows");
    // In the file as well as in the mirror: this is two databases, not one database two tabs are
    // reading selectively.
    assert.equal(browser.stored("scope-1", "todo-1", alpha)?.["title"], "in alpha");
    assert.equal(browser.stored("scope-1", "todo-1", beta), undefined, "two namespaces wrote into one file");
  }));

test("§8.7 a tab is never handed the storage worker of another namespace", async () =>
  withBrowser(async (browser) => {
    // The broker's half of the same rule, and the half the isolation above cannot show: two tabs
    // that each hold a worker never ask anybody for a port. This one has to ask.
    //
    // One `SharedWorker` serves the whole origin, so a provider registered under the scope alone
    // would be handed out to whoever named that scope — and a tab of `alpha` would be given a port
    // straight into `beta`'s worker, hydrate from it, and render another application's rows without
    // an error anywhere.
    const alpha = `${browser.namespace}-alpha`;
    const beta = `${browser.namespace}-beta`;
    const other = await browser.open("scope-1", { namespace: beta });
    assert.equal(other.role, "leader");

    // A tab of `alpha` that lost its own election: there is a provider for this scope in the origin,
    // and none for this database.
    browser.locks.hold(browser.lockName("scope-1", alpha));
    const error = await browser.open("scope-1", { namespace: alpha, leaderTimeoutMs: 150 }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    assert.ok(error instanceof WeftOpenError, "a tab was handed the storage worker of another namespace");
    assert.equal(error.reason, "no-leader");
    assert.equal(browser.worker.host.connections, 1, "another namespace's worker accepted a port it was sent");
  }));

test("§8.7 a namespace and a scope that run together are still two databases", async () =>
  withBrowser(async (browser) => {
    // Both halves of the key are strings an application chose, so joining them with a separator is
    // not enough: namespace `x:a` with scope `b:scope-1` and namespace `x:a:b` with scope `scope-1`
    // read as one key the moment the separator is all that divides them. That is two applications on
    // one lock, one worker and one file, and nothing anywhere would report it.
    const joined = `${browser.namespace}:a`;
    const split = `${browser.namespace}:a:b`;
    assert.notEqual(
      weftDatabaseKey("b:scope-1", joined),
      weftDatabaseKey("scope-1", split),
      "a namespace and a scope ran together into one key",
    );

    const first = await browser.open("b:scope-1", { namespace: joined });
    const second = await browser.open("scope-1", { namespace: split });

    // Two leaders is two locks, which is the composition holding where a plain join would have made
    // the second tab a follower of the first.
    assert.equal(first.role, "leader");
    assert.equal(second.role, "leader", "two databases whose parts run together were elected as one");
    assert.equal(browser.workers.length, 2, "two databases whose parts run together shared a worker");

    first.source.create(TODOS, rowId("todo-1"), { title: "in the first", done: false, rank: 1 }, txnId("txn-1"));
    await settle(() => first.source.rows.size === 1);
    await delay(50);
    assert.equal(second.source.rows.size, 0, "a write reached a database that only shares a spelling");
    assert.equal(browser.stored("b:scope-1", "todo-1", joined)?.["title"], "in the first");
    assert.equal(browser.stored("scope-1", "todo-1", split), undefined, "the two wrote into one file");
  }));

test("§8.7 the storage worker is constructed at a URL carrying its namespace", async () =>
  withBrowser(async (browser) => {
    // How the namespace reaches the one part of this that decides where the bytes go. The worker
    // opens its database as it starts, before the page has said anything to it, so the URL it is
    // constructed at is the only channel that exists in time — and `serveWeftWorkerDefaults` reads
    // the namespace back off its own `location` to name the OPFS pool it asks for.
    const alpha = `${browser.namespace}-alpha`;
    const beta = `${browser.namespace}-beta`;
    const urls: string[] = [];
    await withWorkerConstructor(browser, urls, async () => {
      const first = await browser.open("scope-1", { namespace: alpha, useDefaultWorker: true });
      const second = await browser.open("scope-1", { namespace: beta, useDefaultWorker: true });

      // The workers here were built by the default `createWorker` and told nothing but their URL, so
      // a write staying in its own database is the round trip working end to end.
      first.source.create(TODOS, rowId("todo-1"), { title: "in alpha", done: false, rank: 1 }, txnId("txn-1"));
      await settle(() => first.source.rows.size === 1);
      await delay(50);
      assert.equal(second.source.rows.size, 0, "the namespace never reached the worker, so both opened one database");
      // And in the file the URL named. Two workers that were told nothing would both open the
      // default one — quietly, since a worker reading a file another worker is writing answers every
      // statement and merely stops agreeing with it.
      assert.equal(
        browser.stored("scope-1", "todo-1", alpha)?.["title"],
        "in alpha",
        "the worker did not open the database its URL named",
      );
      assert.equal(browser.stored("scope-1", "todo-1", beta), undefined, "both workers opened one file");
    });

    assert.deepEqual(
      urls.map((url) => new URL(url).searchParams.get("weft-namespace")),
      [alpha, beta],
      "the worker's URL does not say which namespace's database to open",
    );
    // And the URL still points at the module the application named, resolved against the document.
    assert.deepEqual(
      urls.map((url) => new URL(url).pathname),
      ["/app/storage-worker.ts", "/app/storage-worker.ts"],
      "the namespace was written into the URL at the cost of the URL",
    );
  }));

test("§8.7 two namespaces ask for two OPFS pools, and one namespace asks for one", async () =>
  withBrowser(async (browser) => {
    // The exclusion the namespace has to reach, in the one place it is real. A pool is installed by
    // taking a synchronous access handle on every file it holds, so a second worker asking for a
    // pool another worker has is refused it — and, being unable to tell that from a browser with no
    // OPFS at all, opens in memory instead. Two applications of one origin would therefore have the
    // second of them quietly ephemeral beside the first's durable file.
    const pools = new OpfsPools();
    const alpha = await pools.open(`${browser.namespace}-alpha`);
    const beta = await pools.open(`${browser.namespace}-beta`);

    assert.equal(alpha, "durable");
    assert.equal(beta, "durable", "a second namespace was refused the pool the first is holding");
    assert.equal(new Set(pools.installed).size, 2, "two namespaces asked for one pool");

    // And the same namespace twice is the same pool, which is what makes the exclusion above the
    // real thing rather than a fresh name per worker. A second tab never gets here — one tab holds
    // the worker — but a successor built while a crashed predecessor is still letting go does.
    const again = await pools.open(`${browser.namespace}-alpha`);
    assert.equal(again, "ephemeral", "a worker of the same namespace was given a pool of its own");
    assert.equal(pools.installed.at(-1), pools.installed[0], "the pool a namespace opens in is not stable");
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

    // Nothing is left answering on the old tab's behalf either: it stood down as the provider and
    // its worker was stopped, so a port asked for now reaches nobody.
    await next.dispose();
    assert.equal(await answers(browser, "scope-1"), false, "somebody is still serving after every tab closed");

    // Idempotent, because a `pagehide` handler and an unmount both call it.
    await weft.dispose();
  }));

test("§8.7 disposing a follower hands its watches back and settles what was in flight", async () =>
  withBrowser(async (browser) => {
    const leader = await browser.open("scope-1");
    const follower = await browser.open("scope-1");
    const all = query("scope-1", (statement) => statement.orderBy("rank"));
    await follower.source.watch(all);

    assert.deepEqual(browser.worker.host.watching, [all.cacheKey], "the follower's statement was never registered");

    await follower.dispose();
    // A `MessagePort` has no liveness signal the worker can rely on, so a tab that went away
    // without saying so would leave the worker re-running this statement after every mutation any
    // tab makes for the rest of the session. Read off the worker's registry rather than off the
    // leader's pushes: a delta carries only the statements its own tab registered, so a statement
    // left standing on behalf of a tab that has gone shows up on nobody's port.
    await settle(() => browser.worker.host.connections === 1);
    leader.source.create(TODOS, rowId("todo-1"), { title: "alpha", done: false, rank: 1 }, txnId("txn-1"));
    await settle(() => leader.source.rows.size === 1);
    assert.deepEqual(browser.worker.host.watching, [], "a disposed tab left its statement registered in the worker");
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

test("§8.7 a worker that could open nothing at all is refused, and the failed open leaves nothing behind", async () =>
  withBrowser(async (browser) => {
    // A build that shipped without the pool VFS in it, as the worker reports it. This is the only
    // thing left that reaches `storage-unavailable`: a browser that merely declines the pool is
    // served an in-memory database and reports `durability: "ephemeral"` instead, so a refusal here
    // has to describe a build rather than a browsing mode.
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
    assert.ok(error instanceof WeftOpenError, "a worker that opened nothing was not reported as an open failure");
    assert.equal(error.reason, "storage-unavailable");
    assert.match(error.message, /OPFS synchronous\s+access handle pool/u, "the failure does not name what is missing");
    assert.match(
      error.message,
      /in-memory database/u,
      "the failure still describes private browsing, which no longer reaches it",
    );
    assert.doesNotMatch(
      error.message,
      /private browsing/u,
      "the failure blames a browsing mode that is now served rather than refused",
    );
    assert.match(error.message, /no OPFS sync access handle pool/u, "the worker's own reason was thrown away");

    // A failed open that leaks a worker is its own bug.
    assert.equal(browser.workers[0]?.terminated, true, "the refused open left its worker running");
    assert.equal(await answers(browser, "scope-1"), false, "the refused open left a provider registered");
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

test("§8.7 a tab with no worker to reach is told, rather than waiting forever", async () =>
  withBrowser(async (browser) => {
    // A tab that lost the election while the winner was still starting its worker. The broker has
    // no provider to give its port to, and a handover is never acknowledged — so without a deadline
    // this is a page that shows a spinner for the rest of the session.
    browser.locks.hold(browser.lockName("scope-1"));
    const error = await browser.open("scope-1", { leaderTimeoutMs: 150 }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof WeftOpenError, "a tab with no worker to reach waited instead of reporting");
    assert.equal(error.reason, "no-leader");
    assert.match(error.message, /storage worker/u);
  }));

test("§8.7 a tab whose port reaches a document that has gone is told within the deadline", async () =>
  withBrowser(async (browser) => {
    // The case the probe exists for, and the one a refusal does not cover. The broker keeps no
    // liveness — deliberately, since it cannot tell a tab that has gone from one the browser has
    // frozen — so a provider that died leaves its registration standing, and a port asked for is
    // accepted, forwarded, and delivered into nothing. No error, no refusal, silence. Without a
    // deadline over something the far end has to answer, this is a page that spins for ever.
    const ghost = new WeftBrokerClient(browser.hub.connect(), "scope-1", browser.namespace);
    ghost.provide();
    browser.locks.hold(browser.lockName("scope-1"));
    try {
      const started = Date.now();
      const error = await browser.open("scope-1", { leaderTimeoutMs: 150 }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      const elapsed = Date.now() - started;
      assert.ok(error instanceof WeftOpenError, "a tab whose port reached nobody waited instead of reporting");
      assert.equal(error.reason, "no-leader");
      // Bounded by the deadline it was given, not by the deadline plus however long one attempt is
      // left standing: attempts are kept so a slow worker can still win, and they are all closed
      // when the deadline passes.
      assert.ok(elapsed < 2_000, `a tab with a 150ms deadline reported after ${elapsed}ms`);
    } finally {
      ghost.dispose();
    }
  }));

test("§8.7 a browser with no SharedWorker is refused before anything is opened", async () =>
  withBrowser(async (browser) => {
    // The loud failure, in every tab rather than only in the ones that turn out not to hold the
    // worker. A tab that opened without a broker could neither be given a port nor hand one out, so
    // the second tab of the origin would fail somewhere else entirely with nothing connecting the
    // two symptoms — and there is no smaller database to fall back to.
    const error = await browser
      .open("scope-1", {
        createBroker: () => {
          throw new WeftOpenError("no-broker", "this environment has no SharedWorker constructor.");
        },
      })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    assert.ok(error instanceof WeftOpenError, "a browser with no broker was allowed to open anyway");
    assert.equal(error.reason, "no-broker");
    // Refused before the election, so no lock was taken and no worker was started on the way out.
    assert.deepEqual(browser.workers, [], "a refused open started a worker");
    const next = await browser.open("scope-1");
    assert.equal(next.role, "leader", "the refused open kept the Web Lock");
  }));

test("§8.7 a browser with no Web Locks is refused in every tab, before a worker is created", async () =>
  withBrowser(async (browser) => {
    // Refused rather than run without an election, and refused everywhere rather than in the tabs
    // that would have lost one. Nothing decides who may touch the file without a lock, so two tabs
    // of one browser would each create a worker: two databases, two outboxes and two sync sessions
    // under a single device id, each pushing to the relay as the same device.
    //
    // `navigator.locks` is what the option falls back to, so a browser without Web Locks is a
    // `navigator` without one — which is what this puts back for the length of the test.
    await withoutWebLocks(async () => {
      const refused = await browser.open("scope-1", { withoutLocks: true }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      assert.ok(refused instanceof WeftOpenError, "a browser with no Web Locks was allowed to open anyway");
      assert.equal(refused.reason, "no-locks");
      assert.match(refused.message, /navigator\.locks/u, "the failure does not name what is missing");
      assert.deepEqual(browser.workers, [], "a refused open started a worker");

      // The second tab is refused the same way. This is the assertion: a rule that only caught the
      // tabs which lost an election would let the first tab of the browser run, and the fault would
      // surface in the second tab as a database that silently disagrees with the first.
      const second = await browser.open("scope-1", { withoutLocks: true }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      assert.ok(second instanceof WeftOpenError, "the second tab of a browser with no Web Locks opened");
      assert.equal(second.reason, "no-locks");
      assert.deepEqual(browser.workers, [], "the second refused open started a worker");
    });

    // And nothing was left holding the scope: a tab in a browser that has Web Locks opens and leads.
    const next = await browser.open("scope-1");
    assert.equal(next.role, "leader", "a refused open left the scope unopenable");
  }));

test("§8.7 a successor whose pool is still held retries rather than taking an in-memory database", async () =>
  withBrowser(async (browser) => {
    // The handover race. A tab that crashes runs no teardown, so the browser hands the lock on while
    // it is still letting go of the access handles, and a successor that asks a moment early is
    // refused the pool. From inside the worker that is indistinguishable from a browser with no OPFS
    // to give, and it is answered the same way: an in-memory database. Accepting it would leave this
    // device on an empty database with its real one on disk beside it and nothing left to reach it,
    // and the page would report `durability: "ephemeral"` where it had said `durable` a second ago.
    const dying = await browser.open("scope-1");
    const successor = await browser.open("scope-1");
    assert.equal(dying.durability, "durable");
    assert.equal(successor.durability, "durable");

    const all = query("scope-1", (statement) => statement.orderBy("rank"));
    await successor.source.watch(all);
    dying.source.create(TODOS, rowId("todo-1"), { title: "before the crash", done: false, rank: 1 }, txnId("txn-1"));
    await settle(() => successor.source.rows.size === 1);

    // The first two workers the successor builds find the pool still held.
    browser.poolRefusals = 2;
    browser.crash("scope-1");

    await waitFor(() => successor.role === "leader", "no tab took over the OPFS access handle");
    // Waited on the migration having finished rather than on the lock having moved: this mirror is
    // still holding the rows the dead worker gave it, so its own row count says nothing yet. A
    // hydrated client in the newest worker is the tab having reconnected to it.
    await waitFor(() => hydrated(browser), "the successor never reconnected to a worker", 4_000);

    assert.equal(successor.durability, "durable", "a device that was durable was quietly downgraded");
    assert.equal(browser.poolRefusals, 0, "the successor gave up before the pool came free");
    assert.equal(browser.workers.length, 4, "the successor accepted the first worker it was given");

    // And a write, because which database this tab ended up on is the whole question.
    successor.source.create(TODOS, rowId("todo-2"), { title: "after taking over", done: false, rank: 2 }, txnId("t2"));
    await settle(() => successor.source.rows.size === 2, 4_000);

    // The database is the one that was there before, not a fresh one. This is what the retry is for:
    // the first row was written by the tab that crashed, and it is readable because the successor is
    // on the same file rather than on an empty database that happens to answer the same statements.
    assert.deepEqual(
      titles(rowsOf(successor.source, all)),
      ["before the crash", "after taking over"],
      "the successor reopened an empty database instead of the one this device had",
    );
    assert.equal(browser.stored("scope-1", "todo-1")?.["title"], "before the crash");
    assert.equal(browser.stored("scope-1", "todo-2")?.["title"], "after taking over");
  }));

test("§8.7 a browser that has no pool at all pays nothing for the successor's retry", async () =>
  withBrowser(async (browser) => {
    // The other side of the same rule, and the reason it is written as "was this device durable"
    // rather than "try again before believing it". In private browsing the pool fails every time, so
    // a retry before every fallback would add its whole wait to every open in that mode and end in
    // the answer it started with. A device that was already ephemeral therefore asks once.
    browser.poolDeclines = true;
    const dying = await browser.open("scope-1");
    const successor = await browser.open("scope-1");
    assert.equal(dying.durability, "ephemeral");
    assert.equal(successor.durability, "ephemeral", "a tab handed a port never learned what kind of database it is on");
    assert.equal(browser.workers.length, 1, "the first open of a private window retried something");

    const started = Date.now();
    browser.crash("scope-1");
    await waitFor(() => successor.role === "leader", "no tab took over");
    // What is timed is the whole takeover, up to a write the new worker answers, rather than the
    // moment the lock changed hands.
    await waitFor(() => hydrated(browser), "the successor never reconnected to a worker", 4_000);
    successor.source.create(TODOS, rowId("todo-1"), { title: "after taking over", done: false, rank: 1 }, txnId("t1"));
    await settle(() => successor.source.rows.size === 1, 4_000);
    const elapsed = Date.now() - started;

    // One worker, not a run of them. A successor that retried here would build every attempt the
    // bound allows, sleep between each, and arrive at the same in-memory database it was offered
    // first — a wait added to every takeover in a mode where waiting can never help.
    assert.equal(browser.workers.length, 2, "a browser with no pool to give was made to ask again");
    assert.equal(successor.durability, "ephemeral");
    assert.ok(elapsed < 400, `taking over cost ${elapsed}ms, so this tab waited on a pool that was never coming`);
  }));

test("§8.7 when the tab holding the worker dies, a successor creates one and the rest reconnect", async () =>
  withBrowser(async (browser) => {
    // The whole migration, end to end. A dedicated worker dies with the document that created it,
    // so this is not a connection dropping — the database's only server is gone, and every tab has
    // to be pointed at a new one. Two tabs stay behind so that both halves are exercised: one is
    // granted the lock and creates a worker, the other is told leadership moved and asks the broker
    // for a port to whoever has it now.
    const dying = await browser.open("scope-1");
    const successor = await browser.open("scope-1");
    const onlooker = await browser.open("scope-1");
    assert.equal(dying.role, "leader");
    assert.equal(successor.role, "follower");
    assert.equal(onlooker.role, "follower");

    const all = query("scope-1", (statement) => statement.orderBy("rank"));
    await successor.source.watch(all);
    await onlooker.source.watch(all);
    dying.source.create(TODOS, rowId("todo-1"), { title: "before", done: false, rank: 1 }, txnId("txn-1"));
    await settle(() => onlooker.source.rows.size === 1);

    // Crashed rather than closed. Nothing runs in a tab that crashes, so no teardown happens
    // anywhere and the browser hands the lock on by itself — which is the only signal there is. The
    // dead tab is also still registered with the broker, so the first port the other tab asks for
    // may well be delivered into a worker that has stopped answering.
    browser.crash("scope-1");

    await waitFor(() => successor.role === "leader", "no tab took over the OPFS access handle");
    await waitFor(() => browser.workers.length === 2, "the successor never created a worker");
    // Two tabs on the new worker, and neither of them is the one that died.
    await waitFor(
      () => browser.worker.host.connections === 2,
      "the tab that did not take over never reconnected to the successor's worker",
    );
    assert.equal(onlooker.role, "follower", "a losing tab promoted itself");

    // Re-hydrated, not merely reconnected: the row was written before the migration and both tabs
    // are reading it out of the new worker.
    await settle(() => onlooker.source.rows.size === 1 && successor.source.rows.size === 1);
    assert.deepEqual(titles(rowsOf(onlooker.source, all)), ["before"], "a reconnected tab lost its rows");

    // And every registration was made again. A tab that reconnected without re-watching has a list
    // that renders whatever it last held and never moves — the exact freeze the migration exists to
    // prevent, wearing the migration's own clothes.
    successor.source.create(TODOS, rowId("todo-2"), { title: "after", done: false, rank: 2 }, txnId("txn-2"));
    await settle(() => onlooker.source.rows.size === 2);
    assert.deepEqual(
      titles(rowsOf(onlooker.source, all)),
      ["before", "after"],
      "a reconnected tab's watched statement was never registered with the new worker",
    );
    assert.deepEqual(titles(rowsOf(successor.source, all)), ["before", "after"]);
  }));

test("§8.7 a promoted tab tells its renderer, and a tab that stayed a follower tells it nothing", async () =>
  withBrowser(async (browser) => {
    // `role` is a live getter, which is only half of what a banner needs. A promoted tab holds the
    // lock from the moment the browser grants it, and a renderer with nothing to subscribe to would
    // go on showing "follower" until some unrelated state happened to re-render it — a page saying
    // it is a follower while holding the access handle, which is the opposite of the truth.
    const dying = await browser.open("scope-1");
    const successor = await browser.open("scope-1");
    const onlooker = await browser.open("scope-1");

    let promoted = 0;
    let unmoved = 0;
    const offSuccessor = successor.subscribeRole(() => {
      promoted += 1;
    });
    const offOnlooker = onlooker.subscribeRole(() => {
      unmoved += 1;
    });

    browser.crash("scope-1");
    await waitFor(() => successor.role === "leader", "no tab took over the OPFS access handle");
    await waitFor(() => promoted > 0, "the promoted tab never told anything reading its role");

    // Read from inside the notification's own reach: the coordinator sets `role` before it calls the
    // listeners, so a renderer woken by this reads the role it was woken about rather than the one
    // before it.
    assert.equal(successor.role, "leader");
    // The onlooker did hear about the succession, over the broker, and reconnected on it. What it
    // did not do is change role, so a banner in that tab has nothing to redraw.
    await waitFor(() => browser.worker.host.connections === 2, "the onlooker never reconnected");
    assert.equal(onlooker.role, "follower");
    assert.equal(unmoved, 0, "a tab that stayed a follower woke its renderer to say so");

    offSuccessor();
    offOnlooker();
    const settled = promoted;
    successor.source.create(TODOS, rowId("todo-1"), { title: "after", done: false, rank: 1 }, txnId("txn-1"));
    await settle(() => successor.source.rows.size === 1);
    assert.equal(promoted, settled, "a role listener kept firing after it was unsubscribed");

    await dying.dispose();
  }));

test("§8.7 every tab hears of a successor, and no tab concludes from hearing it that it leads", async () =>
  withBrowser(async (browser) => {
    // How the tabs that are not next in line find out, and what that message is forbidden to do.
    //
    // A Web Lock wakes the one waiter at the head of the queue and tells nobody else. So the tabs
    // behind it would sit on ports into a document that has gone, rendering whatever they last held
    // for ever — no error, no rejection. The broker is what tells them: a successor has to register
    // there before it can serve a port, and the broker holds a connection to every tab of the
    // origin. Three tabs are left behind here rather than one, and only the first of them is next
    // in the lock queue, so a mechanism that reached only the next waiter fails this.
    //
    // The other half is the invariant. All three hear the same message and exactly one of them was
    // granted the lock; if hearing it were enough to lead, each would build a worker of its own and
    // four documents would be contending for one OPFS access handle. So the count of workers is an
    // assertion, not scenery.
    const dying = await browser.open("scope-1");
    const successor = await browser.open("scope-1");
    const behind = await browser.open("scope-1");
    const further = await browser.open("scope-1");
    assert.equal(dying.role, "leader");
    for (const tab of [successor, behind, further]) assert.equal(tab.role, "follower");

    const all = query("scope-1", (statement) => statement.orderBy("rank"));
    for (const tab of [successor, behind, further]) await tab.source.watch(all);
    dying.source.create(TODOS, rowId("todo-1"), { title: "before", done: false, rank: 1 }, txnId("txn-1"));
    await settle(() => further.source.rows.size === 1);

    // Crashed rather than closed: nothing runs in a tab that crashes, so it says goodbye to nobody
    // and the browser hands the lock on by itself.
    browser.crash("scope-1");

    await waitFor(() => successor.role === "leader", "no tab took over the OPFS access handle");
    // All three back on one worker. The two that are not next in the queue are the point: the lock
    // is never going to say anything to them.
    await waitFor(
      () => browser.worker.host.connections === 3,
      "a tab that was not next in line never heard that its worker had gone",
    );
    await delay(50);

    assert.equal(browser.workers.length, 2, "a tab built a worker of its own on the strength of a message");
    assert.equal(behind.role, "follower", "a tab promoted itself on hearing that somebody else had taken over");
    assert.equal(further.role, "follower", "a tab promoted itself on hearing that somebody else had taken over");

    // And they are reading the new worker rather than remembering the old one, with every statement
    // registered again — a tab that reconnected without re-watching has a list that renders what it
    // last held and never moves, which is the freeze this whole path exists to prevent.
    successor.source.create(TODOS, rowId("todo-2"), { title: "after", done: false, rank: 2 }, txnId("txn-2"));
    await settle(() => behind.source.rows.size === 2 && further.source.rows.size === 2);
    for (const [name, tab] of [
      ["the tab next in line", behind],
      ["the tab behind that", further],
    ] as const) {
      assert.deepEqual(
        titles(rowsOf(tab.source, all)),
        ["before", "after"],
        `${name} did not reload from the new worker`,
      );
    }
  }));

test("§8.7 a request in flight when the worker dies rejects, and the re-hydrate shows what committed", async () =>
  withBrowser(async (browser) => {
    // The caveat this design cannot remove, made explicit. A tab whose worker vanishes mid-request
    // cannot know whether the write landed, and the one thing it must not do is guess: resolving
    // would tell a mutator that a write nobody performed had succeeded. So it rejects — and because
    // weftdb applies nothing optimistically on the page and the database is durable, the re-hydrate
    // that follows shows whatever actually committed, which is the answer the rejection declined to
    // invent.
    const dying = await browser.open("scope-1", { token: () => "token-1" });
    const follower = await browser.open("scope-1", { token: () => "token-1" });
    dying.source.create(TODOS, rowId("todo-1"), { title: "committed", done: false, rank: 1 }, txnId("txn-1"));
    await settle(() => follower.source.rows.size === 1);
    await settle(() => follower.status() !== undefined);

    // `sync` is the one verb whose promise an application actually holds, so it is what a test can
    // hold too. The relay it reaches through takes the request and never answers, which is a worker
    // that is busy on the page's behalf at the moment its document dies.
    browser.stallRelay = true;
    const settled = follower.source.sync().then(
      () => "resolved" as const,
      (error: unknown) => (error instanceof Error ? error.message : "rejected"),
    );
    await delay(20);

    browser.crash("scope-1");

    const outcome = await Promise.race([settled, delay(2_000).then(() => "pending" as const)]);
    assert.notEqual(outcome, "pending", "a request in flight when the worker died never settled");
    assert.notEqual(outcome, "resolved", "a request the worker never answered was reported as succeeded");
    assert.match(String(outcome), /outcome is unknown/u, "the rejection did not say the outcome was unknowable");

    // And what committed is what comes back. Nothing was applied optimistically on the page, so
    // there is nothing to undo; the new worker reopens the same file and the re-hydrate is the
    // answer the rejection above declined to invent.
    browser.stallRelay = false;
    await waitFor(() => follower.role === "leader", "no tab took over", 3_000);
    await settle(() => follower.source.rows.size === 1, 3_000);
    assert.equal(
      follower.source.rows.get("todos\0todo-1")?.fields.get(fieldName("title")),
      "committed",
      "the re-hydrate did not show what the database held",
    );
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
  readonly locks = new QueuedLocks();
  readonly storage = new MemoryStorage();
  readonly namespace = `weft-test-${Math.trunc(performance.now() * 1000)}-${Math.trunc(Math.random() * 1e6)}`;
  readonly server = new WeftServer();
  /** One `SharedWorker` for the whole browser, which is what makes it a broker at all. */
  readonly hub = new BrokerHub();
  /**
   * One database file per namespace for the whole browser, rather than one per worker.
   *
   * Two properties in one, and every worker built here goes through it. That a *later* worker of one
   * namespace reopens the *same* file is what OPFS gives and an in-memory database does not, and
   * migration is where it matters: a successor tab creates a new worker and has to find what the tab
   * before it committed. That a worker of *another* namespace opens a different file is the OPFS
   * pool, which a worker derives from the namespace it was given — see `serveWeftWorkerDefaults`,
   * where the same derivation decides which pool of access handles the worker asks for.
   */
  readonly directory = mkdtempSync(join(tmpdir(), "weft-open-"));
  /** Every token a transport was built from, in order, so "per credential" is an assertion. */
  readonly tokens: string[] = [];
  readonly workers: FakeWorker[] = [];
  /** Set to leave a sync in flight for ever, which is how "the worker died mid-request" is arranged. */
  stallRelay = false;
  /**
   * How many of the next workers find the OPFS pool still held.
   *
   * The handover race, as a number. A tab that crashes runs no teardown, so the browser releases its
   * lock and its access handles when it gets round to it, and a successor granted the lock in
   * between asks for a pool that is not free yet. Counted down rather than timed, so the test says
   * how many attempts the race lasts instead of guessing at a duration.
   */
  poolRefusals = 0;
  /** A browser with no pool to give at all, on any attempt: private browsing. */
  poolDeclines = false;
  readonly #opened: WeftDatabase[] = [];

  /**
   * Whether the worker being built now gets the OPFS pool. Exclusive, and from inside the worker
   * indistinguishable from a browser that has none — which is the whole difficulty.
   */
  takePool(): boolean {
    if (this.poolDeclines) return false;
    if (this.poolRefusals <= 0) return true;
    this.poolRefusals -= 1;
    return false;
  }

  async open(scopeId: string, overrides: OpenOverrides = {}): Promise<WeftDatabase> {
    // A turn, so an election runs after a lock a previous `dispose` handed back has actually been
    // released. A browser serialises its own lock queue; this fake resolves a release through
    // ordinary promises, which take a tick that a synchronous `open` would run inside.
    await delay(0);
    const weft = await openWeftDatabase({
      schema,
      scopeId,
      // Never dereferenced: `createWorker` and `createBroker` are what turn these into a worker and
      // a connection, and under Node that is a MessageChannel with a `serveWeftWorker` on the far
      // end and one with `serveWeftPortBroker` on the far end. The one test about the *default*
      // `createWorker` leaves it out and puts a `Worker` on the global instead.
      worker: "./storage-worker.ts",
      broker: "./broker.ts",
      deviceStorage: this.storage,
      namespace: overrides.namespace ?? this.namespace,
      // Left out for the one test about a browser that has none, which is refused before anything
      // is built rather than run without an election.
      ...(overrides.withoutLocks === true ? {} : { locks: this.locks }),
      ...(overrides.useDefaultWorker === true
        ? {}
        : {
            // The namespace is taken from the argument rather than from the option above, because
            // what a worker stores under is what it was handed: in a browser it reads that off its
            // own URL, and a page that never passed it would have two namespaces on one pool.
            createWorker: (_url: URL | string, namespace: string) => this.build(namespace, overrides.announce),
          }),
      createBroker: overrides.createBroker ?? (() => this.hub.connect()),
      workerTimeoutMs: 2_000,
      ...(overrides.leaderTimeoutMs === undefined ? {} : { leaderTimeoutMs: overrides.leaderTimeoutMs }),
      ...(overrides.token === undefined ? {} : { relay: { token: overrides.token } }),
    });
    this.#opened.push(weft);
    return weft;
  }

  /** One more worker, on this browser's storage for the namespace it was given. */
  build(namespace: string, announce?: WeftWorkerReady): FakeWorker {
    const worker = new FakeWorker(this, namespace, announce);
    this.workers.push(worker);
    return worker;
  }

  /** The worker created most recently, which after a migration is the successor's. */
  get worker(): FakeWorker {
    const worker = this.workers.at(-1);
    if (worker === undefined) throw new Error("no worker was ever created");
    return worker;
  }

  /**
   * The Web Lock one of this browser's databases is elected on.
   *
   * A database is a namespace and a scope together, so this takes both — and the namespace defaults
   * to the browser's own, which is what every tab a test opens is in.
   */
  lockName(scopeId: string, namespace: string = this.namespace): string {
    return `weft:${weftDatabaseKey(scopeId, namespace)}:opfs`;
  }

  /**
   * A tab that crashes: its worker stops answering, and the browser hands its lock on.
   *
   * Nothing else happens, and that is the point. Code in a crashing tab does not run, so it
   * withdraws nothing from the broker and closes nothing — leaving a registration pointing at a
   * document that is gone, which is the case the reconnect loop's probe exists for.
   */
  crash(scopeId: string): void {
    this.worker.terminate();
    this.locks.kill(this.lockName(scopeId));
  }

  /** Where one namespace's database lives. Two namespaces of one origin are two of these. */
  databasePath(namespace: string = this.namespace): string {
    return join(this.directory, `${encodeURIComponent(namespace)}.sqlite3`);
  }

  /** What SQLite holds for a row, which is what survives every tab. Read over its own connection,
   * so it answers whether or not a worker is up. */
  stored(scopeId: string, id: string, namespace: string = this.namespace): Record<string, unknown> | undefined {
    const executor = openSqliteExecutor(this.databasePath(namespace));
    try {
      return executor.get({
        sql: 'SELECT * FROM "todos" WHERE scope_id = ? AND id = ?',
        parameters: [scopeId, id],
        decode: (row) => ({ ...row }),
      });
    } finally {
      executor.close();
    }
  }

  /** A transport per credential, so signing in as somebody else is a new one rather than a mutated one. */
  relay(token: string): AsyncSyncTransport {
    this.tokens.push(token);
    return {
      handshake: async (request) => {
        // A relay that has taken the request and not answered. The worker's session is inside it,
        // so the `sync` the page is awaiting is genuinely in flight rather than merely slow.
        if (this.stallRelay) await new Promise<never>(() => undefined);
        return this.server.handshake(request);
      },
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
    this.hub.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

interface OpenOverrides {
  /** What the worker announces instead of a database it opened. */
  readonly announce?: WeftWorkerReady;
  readonly token?: () => string | null;
  readonly leaderTimeoutMs?: number;
  /** For the one test about a browser that has no `SharedWorker` to connect to. */
  readonly createBroker?: (url: URL | string) => BrokerPortLike;
  /** For the one test about a browser that has no Web Locks. */
  readonly withoutLocks?: boolean;
  /** Another application of this origin. The browser's own namespace by default. */
  readonly namespace?: string;
  /** For the tests about the default `createWorker`, which reads a `Worker` off the global. */
  readonly useDefaultWorker?: boolean;
}

/**
 * Whether the newest worker has hydrated a client, which is a tab having reconnected to it.
 *
 * What a migration test needs and a mirror's own row count cannot give: the rows it is holding came
 * from the worker that died and stay there until the new one answers.
 */
function hydrated(browser: Browser): boolean {
  return browser.workers.length > 1 && browser.worker.host.client !== undefined;
}

/**
 * Runs a body in an environment that has both halves of what the default `createWorker` needs: a
 * `Worker` constructor, and a document for a relative worker URL to be resolved against.
 *
 * The stand-in constructor reads the namespace off the URL it was handed and opens that namespace's
 * storage, which is exactly what `serveWeftWorkerDefaults` does with the same URL — a worker is told
 * which database to open by where it was loaded from and by nothing else.
 */
async function withWorkerConstructor(browser: Browser, urls: string[], body: () => Promise<void>): Promise<void> {
  // A function rather than a class, because a class constructor may not hand back an object of
  // another type and this one has to: what the page is given is the fake worker, and what the fake
  // worker is given is the namespace its URL named.
  const constructor = function (url: URL | string): FakeWorker {
    urls.push(String(url));
    return browser.build(namespaceOfWorkerUrl(String(url)));
  } as unknown as new (url: URL | string) => unknown;
  await withGlobals({ location: { href: "https://weft.test/app/index.html" }, Worker: constructor }, body);
}

/**
 * Which namespace a worker loaded from this URL would open, read the way the worker reads it.
 *
 * A URL with nothing written into it is the default namespace, which is what makes a page that
 * stopped writing one two workers on a single database rather than an error.
 */
function namespaceOfWorkerUrl(url: string): string {
  return new URL(url).searchParams.get("weft-namespace") ?? "weft";
}

/** Runs a body with globals a browser has and Node does not, and puts back whatever was there. */
async function withGlobals<T>(values: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const originals = Object.keys(values).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(values))
    Object.defineProperty(globalThis, name, { value, configurable: true });
  try {
    return await body();
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
  }
}

/**
 * Runs a body in an environment whose `navigator` has no `locks`.
 *
 * Node's own `navigator` has a real `LockManager` on it, which is the same place the library reads
 * one from — so a test about a browser that has none has to take that one away rather than merely
 * leave the option out. Restored afterwards, because every other test in this file elects.
 */
async function withoutWebLocks(body: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
  try {
    await body();
  } finally {
    if (original === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, "navigator", original);
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
class FakeWorker implements WorkerLike {
  readonly host: WeftWorkerHost;
  readonly executor: ReturnType<typeof openSqliteExecutor>;
  /** What this worker got, which is what it announces and what it answers every hydrate with. */
  readonly durability: WeftDurability;
  terminated = false;
  readonly #channel = new MessageChannel();
  readonly #page: PortEndpoint<WorkerMessage>;

  constructor(browser: Browser, namespace: string, announce?: WeftWorkerReady) {
    // The browser's one file for this namespace, not a database of this worker's own: a successor
    // tab creates a new worker and has to find what the tab before it committed, while a worker of
    // another namespace has been given a pool of its own and finds nothing of this one's. A worker
    // refused the pool falls back to memory and says so, exactly as `serveWeftWorkerDefaults` does —
    // a different, empty database with the durable one still on disk beside it.
    const pooled = browser.takePool();
    this.durability = pooled ? "durable" : "ephemeral";
    this.executor = openSqliteExecutor(pooled ? browser.databasePath(namespace) : ":memory:");
    const store = new SqliteClientStore(this.executor, schema);
    store.installSchema();
    this.host = serveWeftWorker({
      port: new PortEndpoint<WorkerRequest>(this.#channel.port2),
      executor: this.executor,
      store,
      durability: this.durability,
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
    this.#channel.port2.postMessage(
      announce ?? { weft: "ready", ok: true, schemaHash: HASH, durability: this.durability },
    );
  }

  // The transfer list is the whole handover: `openWeftDatabase` forwards a port that arrived from
  // the broker into the worker with `postMessage(connect, [port])`, and a stand-in that dropped
  // the second argument would deliver a detached port and the other tab would wait for ever.
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

/**
 * The OPFS synchronous access handle pools of one origin, as a worker meets them.
 *
 * A pool is installed by taking an access handle on every file it holds, so a pool one document has
 * is refused to the next — and from inside the worker that refusal is indistinguishable from a
 * browser that has no OPFS at all, which is why it comes back as an in-memory database rather than
 * as an error. That is the whole reason a namespace has to reach the worker: two applications of one
 * origin asking for one pool is the second of them silently ephemeral.
 *
 * Everything else is real. The SQLite is `@sqlite.org/sqlite-wasm`, the entry point under test is
 * `serveWeftWorkerDefaults`, and what a worker is told about its namespace is what a browser tells
 * it: its own URL.
 */
class OpfsPools {
  /** Every pool name a worker asked for, in the order they asked. */
  readonly installed: string[] = [];
  readonly #held = new Set<string>();

  /** Starts one worker in a namespace, and reports what kind of database it ended up with. */
  async open(namespace: string): Promise<WeftDurability> {
    const port = new CollectingPort();
    const href = `https://weft.test/app/storage-worker.ts?weft-namespace=${encodeURIComponent(namespace)}`;
    await withGlobals({ location: { href } }, async () => {
      await serveWeftWorkerDefaults({ schema, port, sqlite3InitModule: async () => this.#module() });
    });
    const announced = port.sent[0];
    if (announced?.ok !== true) throw new Error("the worker opened no database at all");
    return announced.durability ?? "durable";
  }

  #module(): Sqlite3Module {
    return {
      oo1: sqlite3.oo1,
      installOpfsSAHPoolVfs: async (options) => {
        const name = options.name ?? "opfs-sahpool";
        this.installed.push(name);
        if (this.#held.has(name)) throw new Error(`the pool ${name} is held by another document`);
        this.#held.add(name);
        return { OpfsSAHPoolDb: PooledDatabase };
      },
    };
  }
}

/** A database out of a pool, which for this test is any real SQLite that is not the other one. */
class PooledDatabase implements WasmDatabase {
  readonly #database = new sqlite3.oo1.DB(":memory:", "c");

  prepare(sql: string): ReturnType<WasmDatabase["prepare"]> {
    return this.#database.prepare(sql);
  }

  exec(sql: string): unknown {
    return this.#database.exec(sql);
  }

  close(): void {
    this.#database.close();
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

/**
 * Whether any tab is still serving a scope. Used to prove a teardown really tore down.
 *
 * Asked the way a tab asks: through the broker, over a port, with the `hydrate` a tab sends first.
 * A registration alone would not do — a provider that has gone leaves one standing on purpose — so
 * what is tested is whether something answers.
 */
async function answers(browser: Browser, scopeId: string): Promise<boolean> {
  // In this browser's namespace, or it would be asking after a database no tab of the test ever
  // opened and be told nobody is serving it however many tabs are.
  const broker = new WeftBrokerClient(browser.hub.connect(), scopeId, browser.namespace);
  const brokered = broker.requestPort();
  const transport = new WorkerPortTransport(brokered.port);
  try {
    return await Promise.race([
      transport.request({ type: "hydrate", scopeId, deviceId: "device-probe" }).then(
        () => true,
        () => true,
      ),
      brokered.refused.then(() => false),
      delay(200).then(() => false),
    ]);
  } finally {
    transport.dispose();
    brokered.discard();
    broker.dispose();
  }
}
