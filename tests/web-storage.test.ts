// §4.1 makes local storage the client's state rather than a cache of it, and §10 leans on
// that: work made offline has to be on disk before the tab closes, and has to come back as the
// same work — not just the same rows. A store that restored rows but dropped the outbox would
// look perfectly healthy right up until someone's edit quietly never happened.
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import {
  compareHlc,
  deviceId,
  fieldName,
  rowId,
  scopeId,
  tableName,
  txnId,
  type FieldName,
  type WireValue,
} from "weftdb/core";
import { WebStorageClientStore, WeftClient, type StorageLike } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { schemaHash } from "weftdb/schema";
import { schema } from "weftdb-demo-todo/schema";

const SCOPE = scopeId("shared-list");
const DEVICE = deviceId("tab-1");
const TODOS = tableName("todos");
const TITLE = fieldName("title");
const HASH = schemaHash(schema);

function memoryStorage(): StorageLike & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, String(value)),
    removeItem: (key) => void entries.delete(key),
  };
}

function values(input: Record<string, WireValue>): Record<FieldName, WireValue> {
  return input;
}

function todo(title: string): Record<FieldName, WireValue> {
  return values({ title, notes: "", done: false, rank: "a0", due_at: null, auto_delete_days: null });
}

test("a reload brings back the rows, the outbox and the cursor", () => {
  const storage = memoryStorage();
  const store = new WebStorageClientStore(storage, schema, "weft-demo");
  const client = store.hydrate(SCOPE, DEVICE);
  client.create(TODOS, rowId("todo-1"), todo("buy milk"), txnId("create-1"));
  client.sync(new WeftServer(), HASH);
  client.update(TODOS, rowId("todo-1"), values({ title: "buy oat milk" }), txnId("edit-1"));

  const reloaded = store.hydrate(SCOPE, DEVICE);
  assert.equal(reloaded.getRow(TODOS, rowId("todo-1"))?.fields.get(TITLE), "buy oat milk");
  assert.deepEqual(
    reloaded.outbox.map((op) => op.txnId),
    client.outbox.map((op) => op.txnId),
  );
  assert.equal(reloaded.lastServerSeq, client.lastServerSeq, "the sync cursor was lost");
  assert.equal(reloaded.isRowDirty(TODOS, rowId("todo-1")), true, "restored work is not marked unsent");
});

test("unsent work restored from storage still pushes", () => {
  const storage = memoryStorage();
  const store = new WebStorageClientStore(storage, schema, "weft-demo");
  const offline = store.hydrate(SCOPE, DEVICE);
  offline.create(TODOS, rowId("todo-1"), todo("written offline"), txnId("create-1"));

  // The tab closes here. Nothing else ever sees this client again.
  const server = new WeftServer();
  const reloaded = store.hydrate(SCOPE, DEVICE);
  reloaded.sync(server, HASH);

  assert.equal(reloaded.outbox.length, 0, "the restored outbox never drained");
  assert.ok(
    server.snapshot(SCOPE).fields.some((field) => field.value === "written offline"),
    "work made before the reload never reached the server",
  );
});

test("quarantined work survives a reload rather than being retried behind the user's back", () => {
  const storage = memoryStorage();
  const store = new WebStorageClientStore(storage, schema, "weft-demo");
  let now = Date.parse("2026-03-01T09:00:00.000Z");
  const clock = (): number => now;
  const server = new WeftServer(clock);

  const client = store.hydrate(SCOPE, DEVICE, clock);
  client.create(TODOS, rowId("todo-1"), todo("plan"), txnId("create-1"));
  client.sync(server, HASH);

  const other = new WeftClient(SCOPE, deviceId("tab-2"), schema, clock);
  other.sync(server, HASH);
  other.delete(TODOS, rowId("todo-1"), txnId("delete-1"));
  other.sync(server, HASH);

  client.update(TODOS, rowId("todo-1"), values({ title: "plan (edited)" }), txnId("edit-1"));
  now += 31 * 24 * 60 * 60 * 1000;
  server.pruneTombstones(SCOPE);
  client.sync(server, HASH);
  assert.ok(client.listQuarantine().length > 0, "the setup produced no quarantined work");

  const reloaded = store.hydrate(SCOPE, DEVICE, clock);
  assert.deepEqual(
    reloaded.listQuarantine().map((op) => op.txnId),
    client.listQuarantine().map((op) => op.txnId),
    "quarantined work was lost by the reload",
  );
  assert.equal(reloaded.outbox.length, 0, "a reload put quarantined work back on the wire");
});

test("the clock does not rewind across a reload", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 5 }), (edits) => {
      const storage = memoryStorage();
      const store = new WebStorageClientStore(storage, schema, "weft-demo");
      // A clock frozen at one instant is the case a counter has to carry on its own: the wall
      // clock cannot prove that anything written after the reload came later.
      const frozen = (): number => 1_772_000_000_000;
      const client = store.hydrate(SCOPE, DEVICE, frozen);
      client.create(TODOS, rowId("todo-1"), todo("plan"), txnId("create-1"));
      for (let index = 0; index < edits; index += 1) {
        client.update(TODOS, rowId("todo-1"), values({ title: `plan ${index}` }), txnId(`edit-${index}`));
      }
      const highest = client.outbox
        .map((op) => op.hlc)
        .reduce((left, right) => (compareHlc(left, right) >= 0 ? left : right));

      const reloaded = store.hydrate(SCOPE, DEVICE, frozen);
      reloaded.update(TODOS, rowId("todo-1"), values({ title: "after the reload" }), txnId("edit-after"));
      const afterReload = reloaded.outbox.at(-1)?.hlc;

      assert.ok(afterReload !== undefined);
      assert.equal(
        compareHlc(afterReload, highest) > 0,
        true,
        "a write after the reload did not come after the ones before it",
      );
    }),
    { numRuns: 200 },
  );
});

test("state written by a format this build does not understand is ignored, not half-applied", () => {
  const storage = memoryStorage();
  const store = new WebStorageClientStore(storage, schema, "weft-demo");
  const client = store.hydrate(SCOPE, DEVICE);
  client.create(TODOS, rowId("todo-1"), todo("buy milk"), txnId("create-1"));

  const [key = ""] = [...storage.entries.keys()];
  const stored = JSON.parse(storage.entries.get(key) ?? "{}") as Record<string, unknown>;
  storage.entries.set(key, JSON.stringify({ ...stored, version: 99 }));

  const reloaded = store.hydrate(SCOPE, DEVICE);
  assert.equal(reloaded.rows.size, 0);
  assert.equal(reloaded.outbox.length, 0);
});

test("each device keeps its own state, so two tabs never overwrite each other", () => {
  const storage = memoryStorage();
  const store = new WebStorageClientStore(storage, schema, "weft-demo");
  const first = store.hydrate(SCOPE, deviceId("tab-1"));
  const second = store.hydrate(SCOPE, deviceId("tab-2"));

  first.create(TODOS, rowId("todo-1"), todo("first's row"), txnId("create-1"));
  second.create(TODOS, rowId("todo-2"), todo("second's row"), txnId("create-2"));

  assert.equal(store.hydrate(SCOPE, deviceId("tab-1")).rows.size, 1);
  assert.equal(store.hydrate(SCOPE, deviceId("tab-2")).rows.size, 1);
  assert.equal(storage.entries.size, 2, "two devices shared one slot");
});
