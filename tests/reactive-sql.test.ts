// The reactive SQL read path: a compiled statement decides which rows match and in what order,
// and `client.rows` decides what a row is. The two halves are tested together because the point
// of the split is that filtering gains `where`, `order by`, `limit` and `offset` without giving
// up the row identity that `React.memo` and the query delta both rest on.
import assert from "node:assert/strict";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId } from "weftdb/core";
import { asyncSqlExecutor, type AsyncSqlExecutor } from "weftdb/shared";
import { defineSchema, S } from "weftdb/schema";
import {
  compileOnlyKysely,
  executorRowSelect,
  reactiveSqlQuery,
  SubscriptionEngine,
  WeftClient,
  type ScopedRowQuery,
} from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";

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

const SCOPE = scopeId("scope-1");
const TODOS = tableName("todos");

test("a compiled query filters, orders, and pages the rows a subscription answers with", async () => {
  using fixture = await Fixture.open();
  await fixture.add("todo-1", { title: "alpha", done: false, rank: 3 });
  await fixture.add("todo-2", { title: "beta", done: true, rank: 1 });
  await fixture.add("todo-3", { title: "gamma", done: false, rank: 2 });
  await fixture.save();

  const query = reactiveSqlQuery({
    tableName: TODOS,
    query: fixture.db
      .selectFrom("todos")
      .select("id")
      .where("scope_id", "=", SCOPE)
      .where("done", "=", false)
      .orderBy("rank"),
  });

  assert.deepEqual(
    await fixture.ids(query),
    ["todo-3", "todo-1"],
    "the statement's filter and order were not honoured",
  );
});

test("a boolean bind reaches the driver as something SQLite takes", async () => {
  using fixture = await Fixture.open();
  await fixture.add("todo-1", { title: "alpha", done: true, rank: 1 });
  await fixture.add("todo-2", { title: "beta", done: false, rank: 2 });
  await fixture.save();

  // Kysely compiles `= false` to a JS boolean parameter, which `node:sqlite` refuses to bind.
  // Coercing it at this seam is what keeps a predicate over a boolean field from throwing.
  const query = reactiveSqlQuery({
    tableName: TODOS,
    query: fixture.db.selectFrom("todos").select("id").where("scope_id", "=", SCOPE).where("done", "=", true),
  });

  assert.deepEqual(await fixture.ids(query), ["todo-1"]);
});

test("limit and offset page a result the row map never sees whole", async () => {
  using fixture = await Fixture.open();
  for (const index of [1, 2, 3, 4, 5]) {
    await fixture.add(`todo-${index}`, { title: `t${index}`, done: false, rank: index });
  }
  await fixture.save();

  const page = (offset: number) =>
    reactiveSqlQuery({
      tableName: TODOS,
      query: fixture.db
        .selectFrom("todos")
        .select("id")
        .where("scope_id", "=", SCOPE)
        .orderBy("rank")
        .limit(2)
        .offset(offset),
    });

  assert.deepEqual(await fixture.ids(page(0)), ["todo-1", "todo-2"]);
  assert.deepEqual(await fixture.ids(page(2)), ["todo-3", "todo-4"]);
  assert.deepEqual(await fixture.ids(page(4)), ["todo-5"]);
});

test("an unchanged result is the same object, and an unchanged row is the same row", async () => {
  using fixture = await Fixture.open();
  await fixture.add("todo-1", { title: "alpha", done: false, rank: 1 });
  await fixture.add("todo-2", { title: "beta", done: false, rank: 2 });
  await fixture.save();

  const query = fixture.allTodos();
  const first = await fixture.snapshot(query);
  // `useSyncExternalStore` re-renders whenever the snapshot is a new reference, so an unchanged
  // answer has to be the same object rather than an equal one (§8.3).
  assert.equal(await fixture.snapshot(query), first, "an unchanged result came back as a new object");

  await fixture.update("todo-2", { title: "beta prime" });
  const second = await fixture.snapshot(query);
  assert.notEqual(second, first, "a changed result came back as the cached object");
  assert.equal(second.rows[0], first.rows[0], "an untouched row lost its identity");
  assert.notEqual(second.rows[1], first.rows[1], "a changed row kept its old object");
});

test("the statement runs once per change rather than once per render", async () => {
  using fixture = await Fixture.open();
  await fixture.add("todo-1", { title: "alpha", done: false, rank: 1 });
  await fixture.save();

  const query = fixture.allTodos();
  // React asks for a snapshot more than once in one render pass. Asking again which rows matched
  // per call is a re-scan of the answer in the render path, and answering from the cache is also
  // what keeps two calls inside one pass tearing-free.
  await fixture.snapshot(query);
  await fixture.snapshot(query);
  await fixture.snapshot(query);
  assert.equal(fixture.selects, 1, "the statement's answer was read more than once for one generation");

  await fixture.update("todo-1", { title: "alpha prime" });
  await fixture.snapshot(query);
  assert.equal(fixture.selects, 2, "a change did not make the cached result stale");
});

test("the delta names what moved between two answers", async () => {
  using fixture = await Fixture.open();
  await fixture.add("todo-1", { title: "alpha", done: false, rank: 1 });
  await fixture.add("todo-2", { title: "beta", done: false, rank: 2 });
  await fixture.save();

  const query = fixture.allTodos();
  await fixture.snapshot(query);

  await fixture.update("todo-1", { title: "alpha prime" });
  await fixture.add("todo-3", { title: "gamma", done: false, rank: 3 });
  await fixture.save();
  const delta = (await fixture.snapshot(query)).delta;

  assert.deepEqual(delta.added.map(String), ["todo-3"], "a row that appeared was not reported as added");
  assert.deepEqual(
    delta.changed.map((row) => String(row.id)),
    ["todo-1"],
  );
  assert.deepEqual(delta.removed, []);
});

test("a row the statement matched but the client does not hold is dropped", async () => {
  using fixture = await Fixture.open();
  await fixture.add("todo-1", { title: "alpha", done: false, rank: 1 });
  await fixture.save();

  // The database outlives any one hydrate, and a scope holds only its own rows. A statement that
  // names a row this client never loaded must answer with the rows it does hold rather than
  // throwing or reporting a hole.
  const other = new WeftClient(scopeId("scope-2"), deviceId("device"), schema, () => 1_000);
  await other.create(TODOS, rowId("todo-9"), { [fieldName("title")]: "elsewhere" }, txnId("t9"));
  await fixture.store.save(other);

  const query = reactiveSqlQuery({
    tableName: TODOS,
    query: fixture.db.selectFrom("todos").select("id").where("scope_id", "in", [SCOPE, "scope-2"]).orderBy("id"),
  });
  assert.deepEqual(await fixture.ids(query), ["todo-1"], "a row from another scope reached this client's result");
});

test("a generated-shape builder scopes the statement whatever the caller chains onto it", async () => {
  using fixture = await Fixture.open();
  await fixture.add("todo-1", { title: "buy milk", done: false, rank: 2 });
  await fixture.add("todo-2", { title: "walk dog", done: false, rank: 1 });
  await fixture.save();

  // The shape `weft generate` emits: the scope predicate and the `id` projection are applied
  // before the callback ever sees the statement, so a caller can only add to it. Scoping stops
  // being something an application has to remember.
  const todosSqlQuery = (
    scope: string,
    build: (statement: ScopedRowQuery<Database, "todos">) => ScopedRowQuery<Database, "todos"> = (statement) =>
      statement,
  ) =>
    reactiveSqlQuery({
      tableName: TODOS,
      query: build(fixture.db.selectFrom("todos").select("id").where("scope_id", "=", scope)),
    });

  // A predicate over a string field is the case that matched nothing while columns held JSON.
  const filtered = todosSqlQuery(SCOPE, (statement) => statement.where("title", "=", "buy milk"));
  assert.deepEqual(await fixture.ids(filtered), ["todo-1"], "a predicate over a string field did not match");
  assert.match(filtered.compiled.sql, /scope_id/u, "the builder handed over an unscoped statement");

  const paged = todosSqlQuery(SCOPE, (statement) => statement.orderBy("rank").limit(1));
  assert.deepEqual(await fixture.ids(paged), ["todo-2"]);
  assert.match(paged.compiled.sql, /scope_id/u, "chaining dropped the scope predicate");
});

test("a statement that does not constrain the scope is refused", async () => {
  using fixture = await Fixture.open();
  // One database file holds every scope. A row id is unique only within its collection, so an
  // unscoped statement can match another scope's row and hand back this scope's row of that id.
  assert.throws(
    () =>
      reactiveSqlQuery({
        tableName: TODOS,
        query: fixture.db.selectFrom("todos").select("id").where("done", "=", false),
      }),
    /scope_id/u,
  );
});

class Fixture {
  readonly db = compileOnlyKysely<Database>();
  readonly engine = new SubscriptionEngine();
  readonly store: SqliteClientStore;
  readonly client: WeftClient;
  /**
   * How many times the engine has asked which rows a statement matched, to prove the caching
   * claim: a snapshot it can reuse is answered without consulting the selection again.
   */
  selects = 0;
  readonly #select: ReturnType<typeof executorRowSelect>;
  readonly #close: () => void;
  #txn = 0;

  private constructor(executor: AsyncSqlExecutor, store: SqliteClientStore, close: () => void) {
    this.store = store;
    this.#close = close;
    this.#select = executorRowSelect(executor);
    this.client = new WeftClient(SCOPE, deviceId("device"), schema, () => 1_000);
    this.client.persistence = this.store;
  }

  static async open(): Promise<Fixture> {
    const file = openSqliteExecutor(":memory:");
    const executor = asyncSqlExecutor(file);
    const store = new SqliteClientStore(executor, schema);
    await store.installSchema();
    return new Fixture(executor, store, () => {
      file.close();
    });
  }

  async add(id: string, values: { title: string; done: boolean; rank: number }): Promise<void> {
    this.#txn += 1;
    await this.client.create(
      TODOS,
      rowId(id),
      {
        [fieldName("title")]: values.title,
        [fieldName("done")]: values.done,
        [fieldName("rank")]: values.rank,
      },
      txnId(`txn-${this.#txn}`),
    );
  }

  async update(id: string, values: { title: string }): Promise<void> {
    this.#txn += 1;
    await this.client.update(TODOS, rowId(id), { [fieldName("title")]: values.title }, txnId(`txn-${this.#txn}`));
    this.engine.notify();
  }

  async save(): Promise<void> {
    await this.store.save(this.client);
    this.engine.notify();
  }

  allTodos() {
    return reactiveSqlQuery({
      tableName: TODOS,
      query: this.db.selectFrom("todos").select("id").where("scope_id", "=", SCOPE).orderBy("rank"),
    });
  }

  /**
   * The statement's ids, then the snapshot they materialize into. Running the statement is a
   * promise and a snapshot is read during render, so the two are separate steps: the ids are the
   * answer this fixture holds, and the closure below is what a render reads it through.
   */
  async snapshot(query: ReturnType<typeof reactiveSqlQuery>) {
    const ids = await this.#select(query);
    return this.engine.getSqlSnapshot(
      query,
      () => {
        this.selects += 1;
        return ids;
      },
      this.client.rows,
    );
  }

  async ids(query: ReturnType<typeof reactiveSqlQuery>): Promise<readonly string[]> {
    return (await this.snapshot(query)).rows.map((row) => String(row.id));
  }

  [Symbol.dispose](): void {
    this.#close();
  }
}
