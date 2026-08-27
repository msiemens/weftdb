import assert from "node:assert/strict";
import { test } from "vitest";
import { fieldName, rowId, tableName } from "weftdb/core";
import {
  Diff3EditorBuffer,
  WorkerPortTransport,
  compileOnlyKysely,
  queryCacheKey,
  reactiveSqlQuery,
  type WorkerRequest,
  type WorkerResponse,
} from "weftdb/client";

// The shape `weft generate`'s `database.d.ts` gives a `tasks` collection, written out here so the
// builder below is typed the way an application's is.
interface Database {
  tasks: {
    id: string;
    scope_id: string;
    title: string;
    done: boolean;
  };
}

test("a Kysely builder reaches a reactive query as the statement it compiled to", async () => {
  const db = compileOnlyKysely<Database>();
  // `QueryBuilderLike` asks only for `compile()`, so a Kysely builder is handed straight to
  // `reactiveSqlQuery`. What the worker runs is what the builder produced, parameters included.
  const query = reactiveSqlQuery({
    tableName: tableName("tasks"),
    query: db.selectFrom("tasks").select("id").where("scope_id", "=", "scope-1").where("done", "=", false),
  });
  assert.equal(query.compiled.sql, 'select "id" from "tasks" where "scope_id" = ? and "done" = ?');
  assert.deepEqual(query.compiled.parameters, ["scope-1", false]);
  assert.equal(query.cacheKey, queryCacheKey(query.compiled));
});

test("a Kysely query's cache key is stable across builds and differs for a different query", async () => {
  const db = compileOnlyKysely<Database>();
  const build = () => db.selectFrom("tasks").select(["id", "title"]).where("done", "=", false);
  assert.equal(queryCacheKey(build().compile()), queryCacheKey(build().compile()));

  const different = db.selectFrom("tasks").select(["id", "title"]).where("done", "=", true);
  assert.notEqual(queryCacheKey(build().compile()), queryCacheKey(different.compile()));
});

test("editor buffer holds remote edits while focused", async () => {
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

test("worker transport correlates requests and responses", async () => {
  const worker = new LoopbackWorker();
  const transport = new WorkerPortTransport(worker);
  // Two requests in flight at once, answered out of order by the worker below. Each caller gets the
  // reply carrying its own number, so a transport that matched replies by arrival order would hand
  // one tab's rows to whoever asked first, and a single round trip would never catch the mistake.
  const hydrated = transport.request({ type: "hydrate", scopeId: "scope", deviceId: "device", namespace: "weft" });
  const executed = transport.execute({ sql: "select 1", parameters: [] });
  assert.deepEqual(await executed, { rows: [] });
  assert.deepEqual(await hydrated, { hydrated: "scope" });
  transport.dispose();
});

/** A worker that answers out of order, so correlation is what the test above is reading. */
class LoopbackWorker {
  #listener: ((event: MessageEvent<WorkerResponse>) => void) | undefined;

  postMessage(message: WorkerRequest): void {
    const response: WorkerResponse =
      message.type === "hydrate"
        ? { id: message.id, ok: true, value: { hydrated: message.scopeId } }
        : message.type === "execute"
          ? { id: message.id, ok: true, value: { rows: [] } }
          : { id: message.id, ok: true, value: null };
    const answer = (): void => this.#listener?.({ data: response } as MessageEvent<WorkerResponse>);
    // A hydrate reads the whole scope, so it answers after whatever was asked next.
    if (message.type === "hydrate") setTimeout(answer, 0);
    else queueMicrotask(answer);
  }

  // Kept by type. The transport listens for `close` as well as `message`, and one field for both
  // would send responses to whichever was registered last.
  addEventListener(type: "message" | "close", listener: (event: MessageEvent<WorkerResponse>) => void): void {
    if (type === "message") this.#listener = listener;
  }

  removeEventListener(type: "message" | "close", listener: (event: MessageEvent<WorkerResponse>) => void): void {
    if (type === "message" && this.#listener === listener) this.#listener = undefined;
  }
}
