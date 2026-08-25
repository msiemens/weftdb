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

test("a pull does not settle a field whose write is sitting in quarantine", () => {
  // Quarantine means the local state has diverged for good and only the person can resolve it
  // (§5.5), which is why quarantined ops keep their row dirty (§5.8). A pull that applies the
  // scope's value over the write anyway resolves that divergence on their behalf and without
  // telling them: the row goes on reading as dirty, quarantine goes on offering to retry a
  // write, and the text they typed is nowhere on screen. Whether it survived would come down to
  // whether a pull happened to carry the field.
  const server = new WeftServer();
  const client = device("tab-1");

  // Made offline, so the scope has never heard of the row, and then edited.
  client.create(NOTES, ROW, values({ title: "as created" }), txnId("create"));
  client.update(NOTES, ROW, values({ title: "as edited" }), txnId("edit"));

  // A resync finds the row absent, which sets every unsent op for it aside — the edit included.
  client.applySnapshot(server.snapshot(SCOPE));
  assert.equal(
    client.listQuarantine().some((op) => op.txnId === txnId("edit")),
    true,
    "the unsent edit was not set aside when the resync found the row absent",
  );

  // The person repairs the creation but not the edit, so the row reaches the scope carrying the
  // value it was created with, and the very next pull offers that value back.
  client.retryQuarantinedTxn(txnId("create"));
  client.sync(server, HASH);

  assert.equal(client.getRow(NOTES, ROW)?.fields.get(TITLE), "as edited", "the pull overwrote the quarantined write");
  assert.equal(
    client.listQuarantine().some((op) => op.txnId === txnId("edit")),
    true,
    "the edit left quarantine without the person deciding anything",
  );
  assert.equal(client.isRowDirty(NOTES, ROW), true, "a row still holding quarantined work read as clean");
});

test("a quarantined write does not withhold a field from the next life of its row", () => {
  // The other edge of the rule above. A quarantined write protects the value it left in the row,
  // and a row that has been deleted and had its id used again does not hold that value any more —
  // the delete took it. Reading the quarantined op as a claim on the field regardless would leave
  // the new row missing the field altogether: not the person's text, not the scope's, nothing.
  const server = new WeftServer();
  const author = device("tab-1");
  const editor = device("tab-2");

  author.create(NOTES, ROW, values({ title: "first life" }), txnId("create"));
  author.sync(server, HASH);
  editor.sync(server, HASH);

  // The editor's unsent edit meets the author's delete, which is what sets the edit aside.
  editor.update(NOTES, ROW, values({ title: "as edited" }), txnId("edit"));
  author.delete(NOTES, ROW, txnId("delete"));
  author.sync(server, HASH);
  editor.applyPull(server.pull(SCOPE, editor.lastServerSeq));
  assert.equal(
    editor.listQuarantine().some((op) => op.txnId === txnId("edit")),
    true,
    "the edit was not set aside when the row was deleted under it",
  );

  // The tombstone is purged and the id is used again by a device that never saw the first life.
  server.pruneTombstones(SCOPE, 0);
  const stranger = device("tab-3");
  stranger.sync(server, HASH);
  stranger.create(NOTES, ROW, values({ title: "second life" }), txnId("create-again"));
  stranger.sync(server, HASH);

  editor.applyPull(server.pull(SCOPE, editor.lastServerSeq));

  assert.equal(
    editor.getRow(NOTES, ROW)?.fields.get(TITLE),
    "second life",
    "the new life of the row arrived without the field the quarantined write named",
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
