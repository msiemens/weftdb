// Typing is only worth having if it refuses things, so the refusals are the test. Every
// `@ts-expect-error` below fails the build if the line it marks stops being an error — this
// file is checked by `tsc --noEmit` along with everything else, so these are assertions.
import assert from "node:assert/strict";
import { test } from "vitest";
import { fieldName, tableName } from "weftdb/shared";
import { queryKey, type MaterializedRow, type TypedQueryKey } from "weftdb/client";
import { useWeftQuery, useWeftRows, type SubscriptionSource } from "weftdb-react";
import { defineSchema, S } from "weftdb/schema";
import { decodeTodoEvents, decodeTodos, todoEventsQuery, todosQuery, type TodosRow } from "weftdb-demo-todo/bindings";

const schema = defineSchema({
  todos: S.collection({ title: S.string(), done: S.boolean() }),
});

test("a query the schema agrees with is built from its own field names", () => {
  const key = queryKey(schema, "todos", { fields: ["title", "done"], orderBy: "title" });
  assert.equal(key.tableName, tableName("todos"));
  assert.deepEqual([...key.fields], [fieldName("title"), fieldName("done")]);
  assert.equal(key.orderBy, fieldName("title"));

  // Selecting nothing in particular means every field the collection has, which includes the
  // base fields the framework adds to all of them.
  assert.deepEqual(
    [...queryKey(schema, "todos").fields],
    ["id", "scope_id", "created", "title", "done"].map((field) => fieldName(field)),
  );
});

test("a schema loaded at runtime that disagrees is refused rather than queried", () => {
  const empty = defineSchema({ todos: S.collection({ title: S.string() }) });
  // The compiler was told about `title`; a schema without it still has to say so at runtime.
  assert.throws(() => queryKey(empty, "todos", { fields: ["missing"] as never[] }), /no such field/u);
  assert.throws(() => queryKey(empty, "elsewhere" as never), /no such collection/u);
});

test("a query naming something the schema does not declare does not compile", () => {
  // Never called: the point is that the compiler refuses them, and calling one would only
  // prove the runtime guard fires, which the previous test already does.
  // @ts-expect-error - `titel` is not a field of `todos`
  () => queryKey(schema, "todos", { fields: ["titel"] });
  // @ts-expect-error - ordering by a field that does not exist
  () => queryKey(schema, "todos", { orderBy: "created_at" });
  // @ts-expect-error - no such collection
  () => queryKey(schema, "elsewhere");
  assert.ok(true);
});

test("a key cannot be paired with another collection's decoder", () => {
  const source = { engine: undefined, rows: new Map() } as never;
  // The generated keys carry their row type, so this pairing is caught before it can run.
  // @ts-expect-error - the todos query does not decode into a todo_events row
  () => useWeftRows(source, todosQuery(), decodeTodoEvents);
  // @ts-expect-error - and not the other way round either
  () => useWeftRows(source, todoEventsQuery(), decodeTodos);
  // The right pairings are what the generated hooks do.
  () => useWeftRows(source, todosQuery("title"), decodeTodos);
  assert.ok(true);
});

test("a decoder that does not produce the row type the key promises does not compile", () => {
  const source = { engine: undefined, rows: new Map() } as never;
  const key: TypedQueryKey<TodosRow> = todosQuery();
  // @ts-expect-error - a decoder returning something else entirely
  () => useWeftRows(source, key, (row: MaterializedRow) => row.id);
  assert.ok(true);
});

test("a source's key type is the source's, not any string", () => {
  // A store that knows which queries it holds says so, and asking for anything else is an
  // error rather than an `undefined` at runtime.
  type Known = "greeting" | "farewell";
  const source: SubscriptionSource<string, Known> = {
    getSnapshot: (key) => key,
    subscribe: () => () => undefined,
  };

  () => useWeftQuery(source, "greeting");
  // @ts-expect-error - not a key this source has
  () => useWeftQuery(source, "something-else");
  assert.ok(true);
});
