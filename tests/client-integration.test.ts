import assert from "node:assert/strict";
import test from "node:test";
import { fieldName, rowId, tableName } from "weftdb/shared";
import {
  AuthorizerDependencyRecorder,
  BroadcastDbProxy,
  Diff3EditorBuffer,
  DragFrozenList,
  MultiTabCoordinator,
  OpfsWorkerTransport,
  compileOnlyKysely,
  compileQuery,
  invalidatesQuery,
  queryCacheKey,
  type ProxyRequest,
  type ProxyResponse,
  type WorkerRequest,
  type WorkerResponse,
} from "weftdb/client";

// A stand-in for what `weft generate`'s `kysely.d.ts` artifact would emit for a `tasks`
// collection (see `generateKyselyDatabaseTypes` in packages/weftdb/src/codegen): the real
// artifact wraps each column in `ColumnType<Select, Insert, Update>`, which only matters for
// inserts/updates, so a select-only test collapses it to the plain read shape.
interface Database {
  tasks: {
    id: string;
    title: string;
    done: boolean;
  };
}

test("query compilation produces stable cache keys and dependency invalidation", () => {
  const tasks = tableName("tasks");
  const recorder = new AuthorizerDependencyRecorder();
  recorder.recordRead(tasks, fieldName("title"));
  const query = compileQuery(
    { compile: () => ({ sql: "select * from tasks where id = ?", parameters: ["1"] }) },
    recorder.snapshot(),
  );
  assert.equal(
    query.key,
    compileQuery(
      { compile: () => ({ sql: "select * from tasks where id = ?", parameters: ["1"] }) },
      recorder.snapshot(),
    ).key,
  );
  assert.equal(invalidatesQuery(new Set([tasks]), query), true);
});

test("a Kysely query compiles through compileQuery unchanged", () => {
  const tasks = tableName("tasks");
  const recorder = new AuthorizerDependencyRecorder();
  recorder.recordRead(tasks, fieldName("title"));
  const db = compileOnlyKysely<Database>();
  const builder = db.selectFrom("tasks").select(["id", "title"]).where("done", "=", false);
  // `QueryBuilderLike` only asks for `compile()`; a Kysely builder is passed straight in rather
  // than adapted, which is the point — Kysely is a typed surface over the same seam, not a
  // second one.
  const registered = compileQuery(builder, recorder.snapshot());
  assert.equal(registered.compiled.sql, 'select "id", "title" from "tasks" where "done" = ?');
  assert.deepEqual(registered.compiled.parameters, [false]);
  assert.equal(invalidatesQuery(new Set([tasks]), registered), true);
});

test("a Kysely query's cache key is stable across builds and differs for a different query", () => {
  const db = compileOnlyKysely<Database>();
  const build = () => db.selectFrom("tasks").select(["id", "title"]).where("done", "=", false);
  assert.equal(queryCacheKey(build().compile()), queryCacheKey(build().compile()));

  const different = db.selectFrom("tasks").select(["id", "title"]).where("done", "=", true);
  assert.notEqual(queryCacheKey(build().compile()), queryCacheKey(different.compile()));
});

test("editor buffer holds remote edits while focused", () => {
  const buffer = new Diff3EditorBuffer();
  const edit = {
    tableName: tableName("tasks"),
    rowId: rowId("row"),
    fieldName: fieldName("notes"),
    value: "remote",
  };
  buffer.focus();
  assert.deepEqual(buffer.receiveRemote(edit), []);
  assert.deepEqual(buffer.blur(), [edit]);
});

test("drag-frozen list applies pending updates on drop", () => {
  const list = new DragFrozenList(["a", "b"]);
  assert.deepEqual(list.startDrag(), ["a", "b"]);
  assert.deepEqual(list.update(["b", "a"]), ["a", "b"]);
  assert.deepEqual(list.drop(), ["b", "a"]);
});

test("worker transport correlates requests and responses", async () => {
  const worker = new LoopbackWorker();
  const transport = new OpfsWorkerTransport(worker);
  assert.deepEqual(await transport.open("scope"), { opened: "scope" });
  assert.deepEqual(await transport.execute({ sql: "select 1", parameters: [] }), { rows: [] });
  transport.dispose();
});

test("multi-tab coordinator elects leader and follower roles", async () => {
  const leader = new MultiTabCoordinator({
    scopeId: "scope",
    locks: { request: async (_name, _options, callback) => callback({}) },
    channel: new BroadcastChannel("weft-test-leader"),
  });
  const follower = new MultiTabCoordinator({
    scopeId: "scope",
    locks: { request: async (_name, _options, callback) => callback(null) },
    channel: new BroadcastChannel("weft-test-follower"),
  });
  assert.equal(await leader.elect(), "leader");
  assert.equal(await follower.elect(), "follower");
  leader.close();
  follower.close();
});

test("broadcast proxy resolves matching responses", async () => {
  const channelName = `weft-test-${Date.now()}`;
  const followerChannel = new BroadcastChannel(channelName);
  const leaderChannel = new BroadcastChannel(channelName);
  const proxy = new BroadcastDbProxy(followerChannel);
  // The reply is addressed to the tab that asked. Every tab on the channel hears every message,
  // so a reply that named only the request id would settle whichever tab happened to have an
  // outstanding request under that number.
  leaderChannel.addEventListener("message", (event: MessageEvent<ProxyRequest>) => {
    const response: WorkerResponse = { id: event.data.request.id, ok: true, value: "proxied" };
    leaderChannel.postMessage({ client: event.data.client, response } satisfies ProxyResponse);
  });
  assert.deepEqual(await proxy.request({ type: "close" }), { id: 1, ok: true, value: "proxied" });
  proxy.dispose();
  followerChannel.close();
  leaderChannel.close();
});

class LoopbackWorker {
  #listener: ((event: MessageEvent<WorkerResponse>) => void) | undefined;

  postMessage(message: WorkerRequest): void {
    const response: WorkerResponse =
      message.type === "open"
        ? { id: message.id, ok: true, value: { opened: message.scopeId } }
        : message.type === "execute"
          ? { id: message.id, ok: true, value: { rows: [] } }
          : { id: message.id, ok: true, value: null };
    queueMicrotask(() => this.#listener?.({ data: response } as MessageEvent<WorkerResponse>));
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<WorkerResponse>) => void): void {
    this.#listener = listener;
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent<WorkerResponse>) => void): void {
    if (this.#listener === listener) this.#listener = undefined;
  }
}
