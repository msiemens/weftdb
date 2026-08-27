// The sync session under §8.7, on the side of the boundary the client is on.
//
// The session drives `syncWith` against a `WeftClient` and reads its outbox and quarantine to say
// what is pending, so under OPFS it has to run in the worker beside the client. What the page keeps
// is the credential, because the page is the only place a token can be got: a worker has no
// `localStorage` and no redirect to read one out of. Everything between the two is these three
// verbs and one push, rather than the side-channel every application would otherwise write.
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId, type ScopeId, type WeftOp } from "weftdb/core";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { asyncSqlExecutor, type AsyncSqlExecutor } from "weftdb/shared";
import { WeftServer } from "weftdb/server";
import {
  type AsyncSyncTransport,
  inProcessTransport,
  isMissingRowError,
  serveWeftWorker,
  type SessionStatus,
  WeftClient,
  WeftClientMirror,
  type WeftWorkerHost,
  type WorkerMessage,
  WorkerPortTransport,
  type WorkerRequest,
} from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import { PortEndpoint } from "./multitab-fixtures.ts";

const schema = defineSchema({
  todos: S.collection({
    title: S.string(),
    done: S.boolean(),
    rank: S.number(),
  }),
});

const SCOPE = scopeId("scope-1");
const DEVICE = deviceId("device-1");
const TODOS = tableName("todos");
const HASH = schemaHash(schema);

test("§8.7 the page hands over a token and the worker starts syncing under it", async () => {
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();

  // Nothing has been signed in, so there is no session and nothing to report. That is a state, not
  // a failure: a device with no credential is exactly where an application starts.
  assert.equal(bridge.mirror.status(), undefined, "a device that has not signed in reported a session");

  await bridge.mirror.setToken("token-1");
  await bridge.settle(() => bridge.mirror.status() !== undefined);

  assert.deepEqual(bridge.tokens, ["token-1"], "the transport was not built from the token the page gave");
  assert.equal(bridge.mirror.status()?.online, true);
});

test("a write to a row the device no longer holds is refused as such through the worker", async () => {
  // An edit debounced behind a keystroke reaches the client after the row was deleted, here or on
  // another device that this one pulled from. A page that cannot tell that from a fault either
  // treats every failed write as normal or lets this one crash it, and a rejection nobody is left
  // to catch takes the process down under Node. The name is what carries across the boundary; an
  // `Error` does not survive a structured clone with its prototype.
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();
  await bridge.mirror.create(TODOS, rowId("todo-1"), { title: "typed", done: false, rank: 1 }, txnId("create"));
  await bridge.mirror.delete(TODOS, rowId("todo-1"), txnId("delete"));

  const refused = await bridge.mirror.update(TODOS, rowId("todo-1"), { title: "typed again" }, txnId("late")).then(
    () => undefined,
    (error: unknown) => error,
  );

  assert.equal(isMissingRowError(refused), true, `a deleted row's write came back as ${String(refused)}`);

  // And the other direction, or a page written against this would drop every failed write. A
  // create over a row this device holds is a fault in the caller, and has to stay one.
  await bridge.mirror.create(TODOS, rowId("todo-2"), { title: "held", done: false, rank: 2 }, txnId("second"));
  const faulted = await bridge.mirror
    .create(TODOS, rowId("todo-2"), { title: "again", done: false, rank: 3 }, txnId("again"))
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  assert.equal(faulted instanceof Error, true, "a duplicate create resolved");
  assert.equal(isMissingRowError(faulted), false, `a caller's fault was reported as a row that had gone`);
});

test("§8.7 a manual sync pushes this device's work and answers when it has landed", async () => {
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();
  await bridge.mirror.setToken("token-1");
  await bridge.settle(() => bridge.mirror.status() !== undefined);

  await bridge.mirror.create(TODOS, rowId("todo-1"), { title: "alpha", done: false, rank: 1 }, txnId("txn-1"));
  await bridge.settle(() => bridge.mirror.rows.size === 1);

  await bridge.mirror.sync();

  // Answering when the sync has finished rather than when the message was sent is the whole point
  // of the verb: a pull-to-refresh that resolved on delivery would stop spinning before the relay
  // had been spoken to.
  assert.equal(
    bridge.server.snapshot(SCOPE).fields.some((record) => record.value === "alpha"),
    true,
    "the sync answered before this device's work reached the relay",
  );
});

test("§8.7 a local write is sent without waiting for the next poll", async () => {
  // The poll is a minute long here, as it is in a browser whose socket is up: a live connection
  // says when to sync, and what it says nothing about is what this device has just written.
  using bridge = await Bridge.open({ pollMs: 60_000 });
  await bridge.mirror.hydrate();
  await bridge.mirror.setToken("token-1");
  await bridge.settle(() => bridge.mirror.status() !== undefined);

  await bridge.mirror.create(TODOS, rowId("todo-1"), { title: "alpha", done: false, rank: 1 }, txnId("txn-1"));

  // Nobody calls `sync`. A page that has just been typed into shows the row as unsent until the
  // session sends it, and the person watching has no button that would help.
  await bridge.settle(() => bridge.server.snapshot(SCOPE).fields.some((record) => record.value === "alpha"));
  assert.equal(bridge.host.client?.outbox.length, 0, "the write was still queued after the relay took it");
});

test("§8.7 what a sync pulls reaches the page without a local write to carry it", async () => {
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();

  // A neighbour's row, on the relay before this device ever syncs. Only a pull can bring it here,
  // so a session whose applied rows never reached the page would leave the list empty until the
  // person happened to type something.
  await bridge.neighbourWrites("todo-9", "from elsewhere");

  await bridge.mirror.setToken("token-1");
  await bridge.settle(() => bridge.mirror.rows.has("todos\0todo-9"));

  assert.equal(bridge.mirror.rows.get("todos\0todo-9")?.fields.get(fieldName("title")), "from elsewhere");
});

test("§8.7 status is published when it moves and not when it repeats", async () => {
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();
  await bridge.mirror.setToken("token-1");
  await bridge.settle(() => bridge.mirror.status() !== undefined);

  const seen: SessionStatus[] = [];
  bridge.mirror.subscribeStatus(() => {
    const status = bridge.mirror.status();
    if (status !== undefined) seen.push(status);
  });

  await bridge.mirror.create(TODOS, rowId("todo-1"), { title: "alpha", done: false, rank: 1 }, txnId("txn-1"));
  await bridge.settle(() => seen.some((status) => status.pending > 0));
  await bridge.mirror.sync();
  await bridge.settle(() => seen.some((status) => status.pending === 0));

  await bridge.mirror.sync();
  await bridge.mirror.sync();

  // Not a count: a sync legitimately moves `syncing` twice, and the poll runs in the background,
  // so how many arrive is not the property. The property is that none of them repeats the one
  // before it — a status per poll would wake every component reading it for nothing.
  for (const [index, status] of seen.entries()) {
    if (index === 0) continue;
    assert.notDeepEqual(status, seen[index - 1], "a status identical to the one before it was published");
  }
  // And the object is stable between pushes, which is what `useSyncExternalStore` compares by.
  assert.equal(bridge.mirror.status(), seen.at(-1), "the mirror rebuilt a status nothing had changed");
});

test("§8.7 signing out stops the session and leaves the unsent work where it is", async () => {
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();
  await bridge.mirror.setToken("token-1");
  await bridge.settle(() => bridge.mirror.status() !== undefined);

  // Made while signed in and never pushed, because the relay is only reachable through a session.
  bridge.offline = true;
  await bridge.mirror.create(TODOS, rowId("todo-1"), { title: "alpha", done: false, rank: 1 }, txnId("txn-1"));
  await bridge.settle(() => (bridge.host.client?.outbox.length ?? 0) > 0);
  const queued = bridge.host.client?.outbox.length ?? 0;

  await bridge.mirror.setToken(null);
  await bridge.settle(() => bridge.mirror.status()?.online === false);

  // Unsent work belongs to the device rather than to the session that would have pushed it (§4.1),
  // so signing out keeps it and signing back in pushes it. Dropping it is `discardQuarantine`,
  // which is a decision for whoever is holding it.
  assert.equal(bridge.host.client?.outbox.length, queued, "signing out threw away work this device had not sent");
  assert.equal(bridge.host.session, undefined, "the session outlived the credential it was running under");
  // Said rather than merely stopped: a page whose status stream went quiet would go on showing the
  // connection it had before it signed out.
  assert.equal(bridge.mirror.status()?.live, false);
});

test("§8.7 a new token is a new session rather than a setting changed under the old one", async () => {
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();
  await bridge.mirror.setToken("token-1");
  await bridge.settle(() => bridge.mirror.status() !== undefined);
  const first = bridge.host.session;

  await bridge.mirror.setToken("token-2");
  await bridge.settle(() => bridge.host.session !== first);

  // A socket presents its token once, when it connects, so a token applied in place would leave a
  // connection open under the credential the person just stopped using.
  assert.deepEqual(bridge.tokens, ["token-1", "token-2"], "the second credential did not build its own transport");
});

test("§8.7 discarding quarantined work drops it and says so", async () => {
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();
  await bridge.mirror.setToken("token-1");
  await bridge.settle(() => bridge.mirror.status() !== undefined);

  // A row this device made and the relay refused, which is what quarantine holds (§5.5).
  await bridge.quarantine("todo-1");
  await bridge.settle(() => (bridge.mirror.status()?.quarantined ?? 0) > 0);

  await bridge.mirror.discardQuarantine();
  await bridge.settle(() => bridge.mirror.status()?.quarantined === 0);

  assert.equal(bridge.host.client?.listQuarantine().length, 0, "the worker kept work the page discarded");
});

test("§8.7 a session verb reaching a worker that has none is refused rather than ignored", async () => {
  using bridge = await Bridge.open({ withSession: false });
  await bridge.mirror.hydrate();

  // Silence would be worse than an error here. A page that asked to sync and was told nothing
  // would show a device that never syncs and never says why.
  await assert.rejects(bridge.transport.request({ type: "sync" }), /session options/u);
  await assert.rejects(bridge.transport.request({ type: "auth", token: "token-1" }), /session options/u);
});

test("§8.7 syncing before a token has been given says which of the two is missing", async () => {
  using bridge = await Bridge.open();
  await bridge.mirror.hydrate();

  await assert.rejects(bridge.transport.request({ type: "sync" }), /token/u);
});

/**
 * Both halves joined by a real `MessageChannel`, with a relay the worker's session talks to.
 * `openSqliteExecutor(":memory:")` behind `asyncSqlExecutor` stands in for OPFS, because what the
 * host needs of a database is the four asynchronous statements either of them answers.
 */
class Bridge {
  readonly mirror: WeftClientMirror;
  readonly transport: WorkerPortTransport;
  readonly host: WeftWorkerHost;
  readonly store: SqliteClientStore;
  readonly server = new WeftServer();
  /** Every token a transport was built from, in order, so "per credential" is an assertion. */
  readonly tokens: string[] = [];
  /** Set to cut the relay off, which is an ordinary state rather than an error (§10). */
  offline = false;
  readonly #close: () => void;
  readonly #channel: MessageChannel;

  private constructor(
    executor: AsyncSqlExecutor,
    store: SqliteClientStore,
    close: () => void,
    withSession: boolean,
    pollMs: number,
  ) {
    this.store = store;
    this.#close = close;
    this.#channel = new MessageChannel();
    this.host = serveWeftWorker({
      port: new PortEndpoint<WorkerRequest>(this.#channel.port2),
      executor,
      store,
      schemaHash: HASH,
      ...(withSession
        ? {
            session: {
              schemaHash: HASH,
              transport: (token: string) => this.#relay(token),
              // Milliseconds by default, so a test that waits on a poll waits milliseconds.
              pollWhileBlindMs: pollMs,
              pollWhileLiveMs: pollMs,
              debounceMs: 1,
              // Stopped, so `lastSyncedAt` is not a difference between two otherwise identical
              // statuses. With a real clock every sync moves it and every sync publishes, which
              // is correct and would leave nothing for the repeat test to observe.
              now: () => 1_000,
            },
          }
        : {}),
    });
    const page = new PortEndpoint<WorkerMessage>(this.#channel.port1);
    this.transport = new WorkerPortTransport(page);
    this.mirror = new WeftClientMirror({ transport: this.transport, scopeId: SCOPE, deviceId: DEVICE });
  }

  /** `pollMs` is how long the session waits between polls, in both of its intervals. */
  static async open(options: { readonly withSession?: boolean; readonly pollMs?: number } = {}): Promise<Bridge> {
    const file = openSqliteExecutor(":memory:");
    const executor = asyncSqlExecutor(file);
    const store = new SqliteClientStore(executor, schema);
    await store.installSchema();
    return new Bridge(
      executor,
      store,
      () => {
        file.close();
      },
      options.withSession ?? true,
      options.pollMs ?? 20,
    );
  }

  /** A row on the relay that this device has never seen, as a neighbour would have left it. */
  async neighbourWrites(id: string, title: string): Promise<void> {
    const neighbour = new WeftClient(SCOPE, deviceId("device-elsewhere"), schema);
    await neighbour.create(
      TODOS,
      rowId(id),
      { [fieldName("title")]: title, [fieldName("done")]: false, [fieldName("rank")]: 1 },
      txnId(`neighbour-${id}`),
    );
    await neighbour.syncWith(inProcessTransport(this.server), HASH);
  }

  /** Work the relay refuses, which is the only way to reach quarantine (§5.5). */
  async quarantine(id: string): Promise<void> {
    const client = this.host.client;
    if (client === undefined) throw new Error("the worker has not hydrated");
    // A row the scope already holds: this device's create is refused as `row_exists`, and the whole
    // transaction is set aside for the person to decide about.
    await this.neighbourWrites(id, "theirs");
    await client.create(
      TODOS,
      rowId(id),
      { [fieldName("title")]: "mine", [fieldName("done")]: false, [fieldName("rank")]: 2 },
      txnId(`mine-${id}`),
    );
  }

  #relay(token: string): AsyncSyncTransport {
    this.tokens.push(token);
    const reachable = <T>(answer: () => T): Promise<T> =>
      this.offline ? Promise.reject(new Error("the relay is unreachable")) : Promise.resolve(answer());
    return {
      handshake: (request) => reachable(() => this.server.handshake(request)),
      push: (scopeId: ScopeId, ops: WeftOp[]) => reachable(() => this.server.push(scopeId, ops)),
      pull: (scopeId: ScopeId, lastServerSeq: number) => reachable(() => this.server.pull(scopeId, lastServerSeq)),
      snapshot: (scopeId: ScopeId) => reachable(() => this.server.snapshot(scopeId)),
    };
  }

  /** A port delivers on a later turn, so a test waits on the condition rather than on a tick count. */
  async settle(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("the bridge never reached the expected state");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  [Symbol.dispose](): void {
    this.mirror.dispose();
    this.transport.dispose();
    this.host.stop();
    this.#channel.port1.close();
    this.#channel.port2.close();
    this.#close();
  }
}
