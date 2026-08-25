// The typed facade — the surface an application is meant to hold a client through, and until
// now the only public entry point with no tests at all. What it has to do is narrow: name a
// collection once, take values the schema declares, and pass them down unchanged. What it must
// not do is lose a value, invent one, or let a write reach a field the schema has no idea about.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId } from "weftdb/shared";
import { createWeftDb, WeftClient, WeftDb } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { defineSchema, S, schemaHash } from "weftdb/schema";

const SCOPE = scopeId("facade");
const RUNS = Number(process.env["WEFT_PROPERTY_RUNS"] ?? 300);

const schema = defineSchema({
  todos: S.collection({
    title: S.string(),
    notes: S.string({ nullable: true, merge: "diff3" }),
    done: S.boolean(),
    weight: S.number({ nullable: true }),
  }),
  todo_events: S.eventLog({ kind: S.string() }),
});

function db(): { readonly db: WeftDb<typeof schema>; readonly client: WeftClient } {
  const client = new WeftClient(SCOPE, deviceId("laptop"), schema, () => 1_000);
  return { db: createWeftDb(client, schema), client };
}

test("a row written through the facade is the row the client holds", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 12 }),
      fc.boolean(),
      fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: undefined }),
      (title, done, weight) => {
        const { db: database, client } = db();
        const todos = database.collection("todos");
        todos.create("todo-1", { title, done, ...(weight === undefined ? {} : { weight }) });

        const row = client.getRow(tableName("todos"), rowId("todo-1"));
        assert.equal(row?.fields.get(fieldName("title")), title);
        assert.equal(row?.fields.get(fieldName("done")), done);
        assert.equal(row?.fields.get(fieldName("weight")), weight);
        // And the facade reads back what it wrote, without going round the client itself.
        assert.deepEqual(todos.get("todo-1"), row);
      },
    ),
    { numRuns: RUNS },
  );
});

test("a field left out is left alone, not written as empty", () => {
  const { db: database, client } = db();
  const todos = database.collection("todos");
  todos.create("todo-1", { title: "plan", done: false });
  todos.update("todo-1", { done: true });

  // An update naming one field must not quietly blank the others, and `undefined` has to mean
  // "not mentioned" rather than "set to nothing" — the wire has no undefined.
  const row = todos.get("todo-1");
  assert.equal(row?.fields.get(fieldName("title")), "plan");
  assert.equal(row?.fields.get(fieldName("done")), true);
  todos.update("todo-1", { notes: undefined });
  assert.equal(todos.get("todo-1")?.fields.has(fieldName("notes")), false, "an omitted field was written anyway");

  const written = client.outbox.filter((op) => op.kind === "set").map((op) => (op.kind === "set" ? op.field : ""));
  assert.equal(written.includes(fieldName("notes")), false, "an omitted field was put on the wire");
});

test("the facade's writes are ordinary writes: they sync, merge and converge", () => {
  const server = new WeftServer(() => 1_000);
  const { db: first, client: firstClient } = db();
  const second = new WeftClient(SCOPE, deviceId("phone"), schema, () => 1_000);
  const secondDb = createWeftDb(second, schema);

  first.collection("todos").create("todo-1", { title: "plan", done: false });
  firstClient.sync(server, schemaHash(schema));
  second.sync(server, schemaHash(schema));

  assert.equal(secondDb.collection("todos").get("todo-1")?.fields.get(fieldName("title")), "plan");

  secondDb.collection("todos").update("todo-1", { done: true });
  second.sync(server, schemaHash(schema));
  firstClient.sync(server, schemaHash(schema));
  assert.equal(first.collection("todos").get("todo-1")?.fields.get(fieldName("done")), true);
});

test("listing a collection returns that collection and nothing else", () => {
  const { db: database } = db();
  database.collection("todos").create("todo-1", { title: "plan", done: false });
  database.collection("todos").create("todo-2", { title: "other", done: false });
  database.collection("todo_events").create("event-1", { kind: "added" });

  assert.deepEqual(
    database
      .collection("todos")
      .list()
      .map((row) => row.id)
      .sort(),
    [rowId("todo-1"), rowId("todo-2")],
  );
  assert.deepEqual(
    database
      .collection("todo_events")
      .list()
      .map((row) => row.id),
    [rowId("event-1")],
  );
});

test("deleting through the facade removes the row and leaves a tombstone to push", () => {
  const { db: database, client } = db();
  const todos = database.collection("todos");
  todos.create("todo-1", { title: "plan", done: false }, txnId("create"));
  todos.delete("todo-1", txnId("remove"));

  assert.equal(todos.get("todo-1"), undefined);
  assert.equal(
    client.outbox.some((op) => op.kind === "delete" && op.txnId === txnId("remove")),
    true,
    "the delete never reached the outbox",
  );
});

test("a transaction id passed in is the one the ops carry", () => {
  // Transactions are how a caller groups writes that have to land together, so the facade
  // passing its own id would silently split them.
  const { db: database, client } = db();
  const todos = database.collection("todos");
  todos.create("todo-1", { title: "plan", done: false }, txnId("mine"));
  todos.update("todo-1", { title: "changed" }, txnId("mine-too"));

  const transactions = new Set(client.outbox.map((op) => String(op.txnId)));
  assert.deepEqual([...transactions].sort(), ["mine", "mine-too"]);
});

test("an event log has no update or delete on its facade", () => {
  // Append-only rows are written once. The type says so; this is the runtime half — the server
  // rejects the op either way, and refusing locally keeps the event log intact.
  const { db: database } = db();
  const events = database.collection("todo_events");
  events.create("event-1", { kind: "added" });

  assert.throws(() => events.delete("event-1"), /append-class/u);
  assert.throws(
    () => events.update("event-1", { kind: "changed" }),
    /append-class|immutable/u,
    "an event-log row was editable through the facade",
  );
});

test("event-log rows created through the facade sync as append-class rows", () => {
  const server = new WeftServer(() => 1_000);
  const { db: database, client } = db();

  database.collection("todo_events").create("event-1", { kind: "added" }, txnId("event"));
  client.sync(server, schemaHash(schema));

  const [row] = server.snapshot(SCOPE).rows.filter((record) => record.tableName === tableName("todo_events"));
  assert.equal(row?.class, "append", "an event-log facade create reached the server as a mutable row");
});

test("the facade is a view of one client, not a copy of its state", () => {
  const { db: database, client } = db();
  // Writes made directly on the client are visible through the facade and the other way
  // round: two views of the same rows, not two stores that have to be kept in step.
  client.create(tableName("todos"), rowId("todo-1"), { [fieldName("title")]: "direct" }, txnId("direct"));
  assert.equal(database.collection("todos").get("todo-1")?.fields.get(fieldName("title")), "direct");

  database.collection("todos").update("todo-1", { title: "through the facade" });
  assert.equal(
    client.getRow(tableName("todos"), rowId("todo-1"))?.fields.get(fieldName("title")),
    "through the facade",
  );
});
