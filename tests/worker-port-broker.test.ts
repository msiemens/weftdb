// §8.7 the handover: how a tab that may not touch OPFS comes to hold a `MessagePort` to the one
// worker that may, and what the worker does once it holds several.
//
// Two mechanisms, and each has a failure the other cannot show. The broker's is that a
// `MessagePort` cannot be cloned — only moved — so a `BroadcastChannel` can never carry one and a
// relay that copied instead of transferring would hand two documents the same end. The host's is
// quieter: with one port there is only one place a reply can go, and with several there is a right
// one and a wrong one. A response addressed to the wrong port settles
// whatever request that tab happened to have outstanding under the same number — request ids are
// per tab and every tab counts from one — and nothing anywhere reports a fault.
//
// The broker under test is the shipped one. Only the process boundary is stood in for: see
// `BrokerHub` in `./multitab-fixtures.ts`.
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId } from "weftdb/core";
import { defineSchema, S } from "weftdb/schema";
import {
  compileOnlyKysely,
  reactiveSqlQuery,
  serveWeftWorker,
  WeftBrokerClient,
  weftDatabaseKey,
  WorkerPortTransport,
  type ReactiveSqlQuery,
  type WeftWorkerHost,
  type WorkerMessage,
  type WorkerRequest,
} from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import { BrokerHub, delay, PortEndpoint, settle } from "./multitab-fixtures.ts";

const schema = defineSchema({
  todos: S.collection({ title: S.string(), done: S.boolean(), rank: S.number() }),
});

interface Database {
  todos: { id: string; scope_id: string; created: string; title: string; done: boolean; rank: number };
}

const SCOPE = scopeId("scope-1");
const OTHER_SCOPE = scopeId("scope-2");
const DEVICE = deviceId("device-1");
const TODOS = tableName("todos");

test("§8.7 the broker moves a port from one document to another", async () => {
  const hub = new BrokerHub();
  const provider = new WeftBrokerClient(hub.connect(), SCOPE);
  const consumer = new WeftBrokerClient(hub.connect(), SCOPE);
  try {
    const delivered: unknown[] = [];
    provider.onPort((port) => delivered.push(port));
    provider.provide();

    const brokered = consumer.requestPort();
    await settle(() => delivered.length === 1);

    // A port, not a copy of one. The consumer holds one end and the provider now holds the other,
    // so a message posted on this side comes out on that side and nowhere else.
    const arrived = delivered[0] as { postMessage(value: unknown): void; addEventListener: unknown } | undefined;
    assert.notEqual(arrived, undefined, "the broker delivered nothing");
    const heard: unknown[] = [];
    const far = new PortEndpoint(arrived as never);
    far.addEventListener("message", (event: MessageEvent<unknown>) => heard.push(event.data));
    (brokered.port as unknown as { postMessage(value: unknown): void }).postMessage("hello");
    await settle(() => heard.length === 1);
    assert.deepEqual(heard, ["hello"]);

    brokered.discard();
  } finally {
    consumer.dispose();
    provider.dispose();
    hub.close();
  }
});

test("§8.7 a request with nobody providing is refused rather than left waiting", async () => {
  const hub = new BrokerHub();
  const consumer = new WeftBrokerClient(hub.connect(), SCOPE);
  try {
    const brokered = consumer.requestPort();
    // The refusal is the whole liveness story on this path: the broker keeps no heartbeat, so a
    // request it cannot place has to come back as a refusal or the tab waits on a port that is
    // never going to be delivered.
    assert.equal(
      await Promise.race([brokered.refused.then(() => "refused"), delay(500).then(() => "pending")]),
      "refused",
      "a request the broker could not place was never answered",
    );
    brokered.discard();
  } finally {
    consumer.dispose();
    hub.close();
  }
});

test("§8.7 a port asked for in one scope is never delivered to another scope's provider", async () => {
  const hub = new BrokerHub();
  const provider = new WeftBrokerClient(hub.connect(), OTHER_SCOPE);
  const consumer = new WeftBrokerClient(hub.connect(), SCOPE);
  try {
    const delivered: unknown[] = [];
    provider.onPort((port) => delivered.push(port));
    provider.provide();

    const brokered = consumer.requestPort();
    // One broker serves every scope the origin has open, and a tab signed into two scopes runs two
    // workers. A port delivered across that line is a tab reading a database it is not signed into.
    assert.equal(
      await Promise.race([brokered.refused.then(() => "refused"), delay(500).then(() => "pending")]),
      "refused",
      "a port asked for in one scope was accepted by another scope's provider",
    );
    assert.deepEqual(delivered, [], "another scope's provider was handed a port");
    brokered.discard();
  } finally {
    consumer.dispose();
    provider.dispose();
    hub.close();
  }
});

test("§8.7 a port asked for in one namespace is never delivered to another namespace's provider", async () => {
  const hub = new BrokerHub();
  const provider = new WeftBrokerClient(hub.connect(), SCOPE, "beta");
  const consumer = new WeftBrokerClient(hub.connect(), SCOPE, "alpha");
  try {
    const delivered: unknown[] = [];
    provider.onPort((port) => delivered.push(port));
    provider.provide();

    // Same scope, different applications. One broker serves the whole origin, so a registry keyed on
    // the scope alone hands this port to a database the asking tab is not in — the same rows, the
    // same statements, and another application's file underneath.
    const brokered = consumer.requestPort();
    assert.equal(
      await Promise.race([brokered.refused.then(() => "refused"), delay(500).then(() => "pending")]),
      "refused",
      "a port asked for in one namespace was accepted by another namespace's provider",
    );
    assert.deepEqual(delivered, [], "another namespace's provider was handed a port");
    // And the two are registered apart rather than one having replaced the other.
    assert.deepEqual(hub.broker.providers(), [weftDatabaseKey(SCOPE, "beta")]);
    brokered.discard();
  } finally {
    consumer.dispose();
    provider.dispose();
    hub.close();
  }
});

test("§8.7 the last tab to register is the one ports are delivered to", async () => {
  const hub = new BrokerHub();
  const first = new WeftBrokerClient(hub.connect(), SCOPE);
  const second = new WeftBrokerClient(hub.connect(), SCOPE);
  const consumer = new WeftBrokerClient(hub.connect(), SCOPE);
  try {
    const toFirst: unknown[] = [];
    const toSecond: unknown[] = [];
    first.onPort((port) => toFirst.push(port));
    second.onPort((port) => toSecond.push(port));
    first.provide();
    // Succession, from the broker's point of view: the tab that took the Web Lock says so, and
    // that is the whole of what the broker has to be told. There is no death for it to notice.
    second.provide();

    const brokered = consumer.requestPort();
    await settle(() => toSecond.length === 1);
    assert.deepEqual(toFirst, [], "a port went to the tab that had been replaced");
    brokered.discard();

    // And a predecessor standing down does not deregister the tab that replaced it.
    first.dispose();
    const again = consumer.requestPort();
    await settle(() => toSecond.length === 2);
    again.discard();
    assert.deepEqual(
      hub.broker.providers(),
      [weftDatabaseKey(SCOPE)],
      "the successor's registration was withdrawn by its predecessor",
    );
  } finally {
    consumer.dispose();
    second.dispose();
    hub.close();
  }
});

test("§8.7 a successor's claim reaches every other tab, and never the tab that made it", async () => {
  // How a succession is announced, and the reason it is announced here. A Web Lock wakes the
  // one waiter at the head of the queue and tells nobody else, so every follower further back would
  // go on holding a port into a document that has gone — no error, no rejection, just lists that
  // stop moving. The broker is the only per-origin thing with a live connection to each of them,
  // and a successor has to register with it anyway before it can serve a port.
  const hub = new BrokerHub();
  const holder = new WeftBrokerClient(hub.connect(), SCOPE);
  const nextInLine = new WeftBrokerClient(hub.connect(), SCOPE);
  const behind = new WeftBrokerClient(hub.connect(), SCOPE);
  const elsewhere = new WeftBrokerClient(hub.connect(), OTHER_SCOPE);
  const heard = { holder: 0, nextInLine: 0, behind: 0, elsewhere: 0, successor: 0 };
  try {
    holder.onProvider(() => {
      heard.holder += 1;
    });
    nextInLine.onProvider(() => {
      heard.nextInLine += 1;
    });
    behind.onProvider(() => {
      heard.behind += 1;
    });
    elsewhere.onProvider(() => {
      heard.elsewhere += 1;
    });

    holder.provide();
    await settle(() => heard.behind === 1);
    assert.deepEqual(heard, { holder: 0, nextInLine: 1, behind: 1, elsewhere: 0, successor: 0 });

    // The succession: whichever tab the browser handed the lock to registers, and every tab of the
    // scope hears it — the one that would have been next in the lock queue and the one that would
    // not. That second one is the half a Web Lock cannot do, and the whole reason this lives here.
    const successor = new WeftBrokerClient(hub.connect(), SCOPE);
    try {
      successor.onProvider(() => {
        heard.successor += 1;
      });
      successor.provide();
      await settle(() => heard.behind === 2);

      assert.equal(heard.successor, 0, "the successor was told about its own claim");
      assert.equal(heard.nextInLine, 2, "the tab next in the lock queue never heard about the succession");
      assert.equal(heard.behind, 2, "a tab that was not next in line never heard about the succession");
      // Not the tab that already holds a worker. It would tear down the one thing serving the scope
      // on the strength of a message, which is the mirror image of concluding leadership from one.
      assert.equal(heard.holder, 0, "a tab holding the worker was told to go and reconnect to somebody else");
      // And not across scopes. One broker serves every scope the origin has open, and a tab signed
      // into another one has no worker of this scope's to reconnect to.
      assert.equal(heard.elsewhere, 0, "another scope's tab was told to reconnect");
    } finally {
      successor.dispose();
    }
  } finally {
    elsewhere.dispose();
    behind.dispose();
    nextInLine.dispose();
    holder.dispose();
    hub.close();
  }
});

test("§8.7 a response goes to the tab that asked and to no other", async () => {
  using worker = Worker.open();
  const first = worker.connect();
  const second = worker.connect();
  try {
    // Both tabs count their requests from one, so both have a request numbered 1 outstanding at the
    // same moment. That is the arrangement this design introduces and the reason the host has to
    // route by port: with the two answers swapped, each tab settles the other's request with a
    // value of the wrong shape — and both promises resolve, so nothing raises.
    const executed = first.request({ type: "execute", query: query("one").compiled });
    const hydrated = second.request({ type: "hydrate", scopeId: SCOPE, deviceId: "device-2" });

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
  using worker = Worker.open();
  const first = worker.connect();
  const second = worker.connect();
  try {
    // `sync` needs a session and this worker has none, so it is refused. A refusal routed to every
    // port would reject a request another tab is waiting on — an edit reported as failed when it
    // never was.
    const refused = second.request({ type: "sync" }).then(
      () => "resolved",
      () => "rejected",
    );
    const answered = first.request({ type: "hydrate", scopeId: SCOPE, deviceId: DEVICE }).then(
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
  using worker = Worker.open();
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
    await first.request({ type: "hydrate", scopeId: SCOPE, deviceId: "device-1" });

    // One tab mutates. The delta belongs to all of them: the worker recomputes every watched
    // statement after every mutation, whichever tab caused it.
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
  using worker = Worker.open();
  const first = worker.connect();
  const second = worker.connect();
  try {
    await first.request({ type: "hydrate", scopeId: SCOPE, deviceId: "device-1" });
    const shared = query("shared");
    const only = query("only");
    await first.request({ type: "watch", cacheKey: shared.cacheKey, tableName: "todos", query: shared.compiled });
    await second.request({ type: "watch", cacheKey: shared.cacheKey, tableName: "todos", query: shared.compiled });
    await second.request({ type: "watch", cacheKey: only.cacheKey, tableName: "todos", query: only.compiled });

    await second.request({ type: "disconnect" });
    second.dispose();
    // Two left: the port this worker was made with, and the tab that stayed.
    await settle(() => worker.host.connections === 2);

    // The statement the leaving tab held alone is retired; the one the staying tab is also reading
    // is not. Retiring both would freeze a list the remaining tab is rendering, and retiring
    // neither would leave the worker re-running a statement nobody reads for the rest of the
    // session.
    //
    // Both halves of that are asserted, because one port cannot see the whole of it: a delta
    // carries only the statements its own tab registered, so the retired one is invisible from here
    // whether or not the worker is still running it.
    assert.deepEqual(worker.host.watching, [shared.cacheKey], "a disconnect released the wrong registrations");
    const results = await worker.recompute(first);
    assert.deepEqual(results, [shared.cacheKey], "the staying tab stopped being answered for its own statement");
  } finally {
    first.dispose();
  }
});

/** One worker over an in-memory database, plus however many ports a test connects to it. */
class Worker {
  readonly host: WeftWorkerHost;
  readonly #executor: ReturnType<typeof openSqliteExecutor>;
  readonly #channel: MessageChannel;
  readonly #page: PortEndpoint<WorkerMessage>;
  readonly #opened: WorkerPortTransport[] = [];
  readonly #ports: MessageChannel[] = [];

  private constructor() {
    this.#executor = openSqliteExecutor(":memory:");
    const store = new SqliteClientStore(this.#executor, schema);
    store.installSchema();
    // A row already in the file, so `execute` has something to answer with that a hydrate's delta
    // could never be mistaken for.
    const seeding = store.hydrate(SCOPE, DEVICE);
    seeding.create(
      TODOS,
      rowId("todo-one"),
      { [fieldName("title")]: "one", [fieldName("done")]: false, [fieldName("rank")]: 1 },
      txnId("seed"),
    );
    this.#channel = new MessageChannel();
    this.host = serveWeftWorker({
      port: new PortEndpoint<WorkerRequest>(this.#channel.port2),
      executor: this.#executor,
      store,
    });
    this.#page = new PortEndpoint<WorkerMessage>(this.#channel.port1);
  }

  static open(): Worker {
    return new Worker();
  }

  /** One more tab, connected the way the broker connects one: by transferring a port in. */
  connect(): WorkerPortTransport {
    const channel = new MessageChannel();
    this.#ports.push(channel);
    this.#page.postMessage({ weft: "connect", port: channel.port2 }, [channel.port2]);
    const transport = new WorkerPortTransport(channel.port1 as never);
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
    for (const channel of this.#ports) {
      channel.port1.close();
      channel.port2.close();
    }
    this.#channel.port1.close();
    this.#channel.port2.close();
    this.#executor.close();
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
