// What the outbox does when the scope talks back: which queued work a pull retires, which it
// sets aside, and what stays true of the bookkeeping that decides whether a row is dirty. Each
// of these covers a rule the rest of the suite could not tell from its own negation.
import assert from "node:assert/strict";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId, type FieldName, type WireValue } from "weftdb/core";
import { WeftClient, type ClientPersistence } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { defineSchema, S, schemaHash } from "weftdb/schema";

const schema = defineSchema({
  notes: S.collection({ title: S.string() }),
  // A second collection, so a row id can be made to name a row in each of them.
  drafts: S.collection({ title: S.string() }),
});

const HASH = schemaHash(schema);
const SCOPE = scopeId("one-scope");
const NOTES = tableName("notes");
const DRAFTS = tableName("drafts");
const TITLE = fieldName("title");
const ROW = rowId("row-1");

function values(input: Record<string, WireValue>): Record<FieldName, WireValue> {
  return input;
}

function device(name: string): WeftClient {
  return new WeftClient(SCOPE, deviceId(name), schema, () => Date.parse("2026-03-01T09:00:00.000Z"));
}

test("a delete the scope has already carried out retires the queued one instead of quarantining it", () => {
  // A subscribed socket is told about a delete by the same relay that is still answering the
  // push carrying it, so a device routinely hears about its own delete before that push has
  // drained. Hearing it must retire the queued op: setting it aside would ask a person to
  // resolve a divergence between what they asked for and what happened, which are the same.
  const server = new WeftServer();
  const first = device("tab-1");
  const second = device("tab-2");

  first.create(NOTES, ROW, values({ title: "draft" }), txnId("create"));
  first.sync(server, HASH);
  second.sync(server, HASH);

  // Both devices delete it, and the second one gets there first.
  first.delete(NOTES, ROW, txnId("delete-first"));
  second.delete(NOTES, ROW, txnId("delete-second"));
  second.sync(server, HASH);

  first.applyPull(server.pull(SCOPE, first.lastServerSeq));

  assert.deepEqual(
    first.outbox.filter((op) => op.kind === "delete"),
    [],
    "the device's own delete stayed queued after the scope confirmed it",
  );
  assert.deepEqual(first.listQuarantine(), [], "agreeing with the scope was treated as divergence");
});

test("a row whose only queued work was appended straight to the outbox still reads as dirty", () => {
  // Hydration appends to the outbox directly rather than going through the queueing path, so
  // the per-row counts behind the dirty flag have to notice a length they did not cause.
  const server = new WeftServer();
  const client = device("tab-1");

  client.create(NOTES, ROW, values({ title: "first" }), txnId("create"));
  client.sync(server, HASH);
  assert.equal(client.isRowDirty(NOTES, ROW), false, "a fully synced row started out dirty");

  const restored = rowId("row-2");
  client.create(NOTES, restored, values({ title: "second" }), txnId("create-second"));
  client.sync(server, HASH);

  // What a store's `hydrate` does: put the op back where it was, without the client's help.
  client.outbox.push({
    scopeId: SCOPE,
    tableName: NOTES,
    rowId: restored,
    kind: "set",
    field: TITLE,
    value: "written while offline, then reloaded",
    hlc: client.clock.next(),
    txnId: txnId("hydrated"),
  });

  // The next queued write is what decides whether the counts notice. It has to be one that
  // queues without reading them first — an edit asks them what is already queued for its field,
  // and that question rebuilds them on the way past, hiding the staleness this is about.
  client.create(NOTES, rowId("row-3"), values({ title: "third" }), txnId("later"));

  assert.equal(client.isRowDirty(NOTES, restored), true, "the hydrated op left its row reading as clean");
});

test("quarantined work on one collection does not mark a row of the same id in another", () => {
  // A row id is unique within its collection and nowhere else, so anything keyed by id alone
  // conflates two rows that merely share a name.
  const server = new WeftServer();
  const client = device("tab-1");

  client.create(DRAFTS, ROW, values({ title: "kept" }), txnId("create-draft"));
  client.sync(server, HASH);

  // A set against a row the scope has never seen is refused, and refused work is set aside.
  client.outbox.push({
    scopeId: SCOPE,
    tableName: NOTES,
    rowId: ROW,
    kind: "set",
    field: TITLE,
    value: "orphan",
    hlc: client.clock.next(),
    txnId: txnId("orphan"),
  });
  client.sync(server, HASH);

  assert.equal(client.listQuarantine().length > 0, true, "the orphaned write was not set aside");
  assert.equal(
    client.isRowDirty(DRAFTS, ROW),
    false,
    "a quarantined write against one collection dirtied a row of the same id in another",
  );
});

test("a snapshot writes the client through to its store", () => {
  // §4.1 makes local storage the client's state rather than a cache of it. A snapshot replaces
  // most of what a device holds, so a snapshot that is not written through is the largest
  // possible divergence between what the client shows and what survives a reload.
  const server = new WeftServer();
  const author = device("tab-1");
  author.create(NOTES, ROW, values({ title: "shared" }), txnId("create"));
  author.sync(server, HASH);

  const reader = device("tab-2");
  let saves = 0;
  const persistence: ClientPersistence = {
    save: () => {
      saves += 1;
    },
  };
  reader.persistence = persistence;

  const before = saves;
  reader.applySnapshot(server.snapshot(SCOPE));

  assert.equal(saves > before, true, "applying a snapshot never reached the store");
  assert.equal(reader.getRow(NOTES, ROW)?.fields.get(TITLE), "shared", "the snapshot did not land locally");
});
