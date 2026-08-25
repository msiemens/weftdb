// The reactive SQL read path: a compiled statement decides which rows match and in what order,
// and `client.rows` decides what a row is. The two halves are tested together because the point
// of the split is that filtering gains `where`, `order by`, `limit` and `offset` without giving
// up the row identity that `React.memo` and the query delta both rest on.
import assert from "node:assert/strict";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId } from "weftdb/core";
import type { SqlExecutor, SqlStatement } from "weftdb/shared";
import { defineSchema, S } from "weftdb/schema";
import {
  compileOnlyKysely,
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

test("a compiled query filters, orders, and pages the rows a subscription answers with", () => {
  using fixture = Fixture.open();
  fixture.add("todo-1", { title: "alpha", done: false, rank: 3 });
  fixture.add("todo-2", { title: "beta", done: true, rank: 1 });
  fixture.add("todo-3", { title: "gamma", done: false, rank: 2 });
  fixture.save();

  const query = reactiveSqlQuery({
    tableName: TODOS,
    query: fixture.db
      .selectFrom("todos")
      .select("id")
      .where("scope_id", "=", SCOPE)
      .where("done", "=", false)
      .orderBy("rank"),
  });

  assert.deepEqual(fixture.ids(query), ["todo-3", "todo-1"], "the statement's filter and order were not honoured");
});

test("a boolean bind reaches the driver as something SQLite takes", () => {
  using fixture = Fixture.open();
  fixture.add("todo-1", { title: "alpha", done: true, rank: 1 });
  fixture.add("todo-2", { title: "beta", done: false, rank: 2 });
  fixture.save();

  // Kysely compiles `= false` to a JS boolean parameter, which `node:sqlite` refuses to bind.
  // Coercing it at this seam is what keeps a predicate over a boolean field from throwing.
  const query = reactiveSqlQuery({
    tableName: TODOS,
    query: fixture.db.selectFrom("todos").select("id").where("scope_id", "=", SCOPE).where("done", "=", true),
  });

  assert.deepEqual(fixture.ids(query), ["todo-1"]);
});

test("limit and offset page a result the row map never sees whole", () => {
  using fixture = Fixture.open();
  for (const index of [1, 2, 3, 4, 5]) {
    fixture.add(`todo-${index}`, { title: `t${index}`, done: false, rank: index });
  }
  fixture.save();

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

  assert.deepEqual(fixture.ids(page(0)), ["todo-1", "todo-2"]);
  assert.deepEqual(fixture.ids(page(2)), ["todo-3", "todo-4"]);
  assert.deepEqual(fixture.ids(page(4)), ["todo-5"]);
});

test("an unchanged result is the same object, and an unchanged row is the same row", () => {
  using fixture = Fixture.open();
  fixture.add("todo-1", { title: "alpha", done: false, rank: 1 });
  fixture.add("todo-2", { title: "beta", done: false, rank: 2 });
  fixture.save();

  const query = fixture.allTodos();
  const first = fixture.snapshot(query);
  // `useSyncExternalStore` re-renders whenever the snapshot is a new reference, so an unchanged
  // answer has to be the same object rather than an equal one (§8.3).
  assert.equal(fixture.snapshot(query), first, "an unchanged result came back as a new object");

  fixture.update("todo-2", { title: "beta prime" });
  const second = fixture.snapshot(query);
  assert.notEqual(second, first, "a changed result came back as the cached object");
  assert.equal(second.rows[0], first.rows[0], "an untouched row lost its identity");
  assert.notEqual(second.rows[1], first.rows[1], "a changed row kept its old object");
});

test("the statement runs once per change rather than once per render", () => {
  using fixture = Fixture.open();
  fixture.add("todo-1", { title: "alpha", done: false, rank: 1 });
  fixture.save();

  const query = fixture.allTodos();
  fixture.counting.reset();
  // React asks for a snapshot more than once in one render pass. Re-running the statement per
  // call would put a SQLite query in the render path, and answering from the cache is also what
  // keeps two calls inside one pass tearing-free.
  fixture.snapshot(query);
  fixture.snapshot(query);
  fixture.snapshot(query);
  assert.equal(fixture.counting.calls, 1, "the statement ran more than once for one generation");

  fixture.update("todo-1", { title: "alpha prime" });
  fixture.snapshot(query);
  assert.equal(fixture.counting.calls, 2, "a change did not make the cached result stale");
});

test("the delta names what moved between two answers", () => {
  using fixture = Fixture.open();
  fixture.add("todo-1", { title: "alpha", done: false, rank: 1 });
  fixture.add("todo-2", { title: "beta", done: false, rank: 2 });
  fixture.save();

  const query = fixture.allTodos();
  fixture.snapshot(query);

  fixture.update("todo-1", { title: "alpha prime" });
  fixture.add("todo-3", { title: "gamma", done: false, rank: 3 });
  fixture.save();
  const delta = fixture.snapshot(query).delta;

  assert.deepEqual(delta.added.map(String), ["todo-3"], "a row that appeared was not reported as added");
  assert.deepEqual(
    delta.changed.map((row) => String(row.id)),
    ["todo-1"],
  );
  assert.deepEqual(delta.removed, []);
});

test("a row the statement matched but the client does not hold is dropped", () => {
  using fixture = Fixture.open();
  fixture.add("todo-1", { title: "alpha", done: false, rank: 1 });
  fixture.save();

  // The database outlives any one hydrate, and a scope holds only its own rows. A statement that
  // names a row this client never loaded must answer with the rows it does hold rather than
  // throwing or reporting a hole.
  const other = new WeftClient(scopeId("scope-2"), deviceId("device"), schema, () => 1_000);
  other.create(TODOS, rowId("todo-9"), { [fieldName("title")]: "elsewhere" }, txnId("t9"));
  fixture.store.save(other);

  const query = reactiveSqlQuery({
    tableName: TODOS,
    query: fixture.db.selectFrom("todos").select("id").where("scope_id", "in", [SCOPE, "scope-2"]).orderBy("id"),
  });
  assert.deepEqual(fixture.ids(query), ["todo-1"], "a row from another scope reached this client's result");
});

test("a generated-shape builder scopes the statement whatever the caller chains onto it", () => {
  using fixture = Fixture.open();
  fixture.add("todo-1", { title: "buy milk", done: false, rank: 2 });
  fixture.add("todo-2", { title: "walk dog", done: false, rank: 1 });
  fixture.save();

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
  assert.deepEqual(fixture.ids(filtered), ["todo-1"], "a predicate over a string field did not match");
  assert.match(filtered.compiled.sql, /scope_id/u, "the builder handed over an unscoped statement");

  const paged = todosSqlQuery(SCOPE, (statement) => statement.orderBy("rank").limit(1));
  assert.deepEqual(fixture.ids(paged), ["todo-2"]);
  assert.match(paged.compiled.sql, /scope_id/u, "chaining dropped the scope predicate");
});

test("a statement that does not constrain the scope is refused", () => {
  using fixture = Fixture.open();
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

/** An executor that counts the statements run through it, to prove the caching claim. */
class CountingExecutor implements SqlExecutor {
  calls = 0;
  readonly #inner: SqlExecutor;

  constructor(inner: SqlExecutor) {
    this.#inner = inner;
  }

  reset(): void {
    this.calls = 0;
  }

  all<Decoded>(statement: SqlStatement<Decoded>): readonly Decoded[] {
    this.calls += 1;
    return this.#inner.all(statement);
  }

  get<Decoded>(statement: SqlStatement<Decoded>): Decoded | undefined {
    return this.#inner.get(statement);
  }

  run(statement: { readonly sql: string; readonly parameters: readonly never[] }): void {
    this.#inner.run(statement);
  }

  transaction<Result>(body: () => Result): Result {
    return this.#inner.transaction(body);
  }
}

class Fixture {
  readonly db = compileOnlyKysely<Database>();
  readonly engine = new SubscriptionEngine();
  readonly counting: CountingExecutor;
  readonly store: SqliteClientStore;
  readonly client: WeftClient;
  readonly #executor: ReturnType<typeof openSqliteExecutor>;
  #txn = 0;

  private constructor(executor: ReturnType<typeof openSqliteExecutor>) {
    this.#executor = executor;
    this.counting = new CountingExecutor(executor);
    this.store = new SqliteClientStore(executor, schema);
    this.store.installSchema();
    this.client = new WeftClient(SCOPE, deviceId("device"), schema, () => 1_000);
    this.client.persistence = this.store;
  }

  static open(): Fixture {
    return new Fixture(openSqliteExecutor(":memory:"));
  }

  add(id: string, values: { title: string; done: boolean; rank: number }): void {
    this.#txn += 1;
    this.client.create(
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

  update(id: string, values: { title: string }): void {
    this.#txn += 1;
    this.client.update(TODOS, rowId(id), { [fieldName("title")]: values.title }, txnId(`txn-${this.#txn}`));
    this.engine.notify();
  }

  save(): void {
    this.store.save(this.client);
    this.engine.notify();
  }

  allTodos() {
    return reactiveSqlQuery({
      tableName: TODOS,
      query: this.db.selectFrom("todos").select("id").where("scope_id", "=", SCOPE).orderBy("rank"),
    });
  }

  snapshot(query: ReturnType<typeof reactiveSqlQuery>) {
    return this.engine.getSqlSnapshot(query, this.counting, this.client.rows);
  }

  ids(query: ReturnType<typeof reactiveSqlQuery>): readonly string[] {
    return this.snapshot(query).rows.map((row) => String(row.id));
  }

  [Symbol.dispose](): void {
    this.#executor.close();
  }
}
