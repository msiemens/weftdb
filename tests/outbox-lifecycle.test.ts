// What the outbox does when the scope talks back: which queued work a pull retires, which it
// sets aside, and what stays true of the bookkeeping that decides whether a row is dirty. Each
// of these covers a rule the rest of the suite could not tell from its own negation.
import assert from "node:assert/strict";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId, type FieldName, type WireValue } from "weftdb/core";
import { type ClientPersistence, inProcessTransport, WeftClient } from "weftdb/client";
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

test("a delete the scope has already carried out retires the queued one instead of quarantining it", async () => {
  // A subscribed socket is told about a delete by the same relay that is still answering the
  // push carrying it, so a device routinely hears about its own delete before that push has
  // drained. Hearing it must retire the queued op: setting it aside would ask a person to
  // resolve a divergence between what they asked for and what happened, which are the same.
  const server = new WeftServer();
  const first = device("tab-1");
  const second = device("tab-2");

  await first.create(NOTES, ROW, values({ title: "draft" }), txnId("create"));
  await first.syncWith(inProcessTransport(server), HASH);
  await second.syncWith(inProcessTransport(server), HASH);

  // Both devices delete it, and the second one gets there first.
  await first.delete(NOTES, ROW, txnId("delete-first"));
  await second.delete(NOTES, ROW, txnId("delete-second"));
  await second.syncWith(inProcessTransport(server), HASH);

  await first.applyPull(server.pull(SCOPE, first.lastServerSeq));

  assert.deepEqual(
    first.outbox.filter((op) => op.kind === "delete"),
    [],
    "the device's own delete stayed queued after the scope confirmed it",
  );
  assert.deepEqual(first.listQuarantine(), [], "agreeing with the scope was treated as divergence");
});

test("a row whose only queued work was appended straight to the outbox still reads as dirty", async () => {
  // Hydration appends to the outbox directly rather than going through the queueing path, so
  // the per-row counts behind the dirty flag have to notice a length they did not cause.
  const server = new WeftServer();
  const client = device("tab-1");

  await client.create(NOTES, ROW, values({ title: "first" }), txnId("create"));
  await client.syncWith(inProcessTransport(server), HASH);
  assert.equal(client.isRowDirty(NOTES, ROW), false, "a fully synced row started out dirty");

  const restored = rowId("row-2");
  await client.create(NOTES, restored, values({ title: "second" }), txnId("create-second"));
  await client.syncWith(inProcessTransport(server), HASH);

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
  await client.create(NOTES, rowId("row-3"), values({ title: "third" }), txnId("later"));

  assert.equal(client.isRowDirty(NOTES, restored), true, "the hydrated op left its row reading as clean");
});

test("a snapshot rebuilds a row dirty for the work this device still holds", async () => {
  // The per-row counts behind the dirty flag pass for a description of the outbox whenever their
  // length matches its length, so counts kept across a removal are read as current again the
  // moment later writes bring the outbox back to that length. Every row is then answered for out
  // of the emptied queue: `isRowDirty` reports clean over unsent work, and a row a snapshot
  // rebuilds is constructed to match, showing a person their edit as saved (§9.25).
  const server = new WeftServer();
  const author = device("tab-1");
  await author.create(NOTES, ROW, values({ title: "shared" }), txnId("create-shared"));
  await author.syncWith(inProcessTransport(server), HASH);

  const client = device("tab-2");
  await client.syncWith(inProcessTransport(server), HASH);

  // A row the scope has never heard of: a resync sets its unsent work aside, and the delete queued
  // behind that is refused on the next push. The row is gone locally by then, so the removal that
  // refusal makes is followed by no recompute for anything.
  const local = rowId("row-local");
  await client.create(NOTES, local, values({ title: "never pushed" }), txnId("create-local"));
  await client.applySnapshot(server.snapshot(SCOPE));
  await client.delete(NOTES, local, txnId("delete-local"));
  await client.syncWith(inProcessTransport(server), HASH);
  assert.equal(client.outbox.length, 0, "the refused delete stayed queued");

  // One op queued against a row the scope does hold, which is what brings the outbox back to the
  // length the counts were taken at.
  await client.delete(NOTES, ROW, txnId("delete-shared"));
  assert.equal(client.isRowDirty(NOTES, ROW), true, "a row whose delete is still queued read as clean");

  await client.applySnapshot(server.snapshot(SCOPE));

  assert.equal(
    client.outbox.some((op) => op.rowId === ROW),
    true,
    "the queued delete left the outbox, so the flag has nothing to disagree with",
  );
  assert.equal(client.isRowDirty(NOTES, ROW), true, "the rebuilt row read as clean");
  assert.equal(
    client.rows.get(`${NOTES}\0${ROW}`)?.internals._weft_dirty,
    1,
    "the snapshot rebuilt the row clean while its own delete waited in the outbox",
  );
});

test("quarantined work on one collection does not mark a row of the same id in another", async () => {
  // A row id is unique within its collection and nowhere else, so anything keyed by id alone
  // conflates two rows that merely share a name.
  const server = new WeftServer();
  const client = device("tab-1");

  await client.create(DRAFTS, ROW, values({ title: "kept" }), txnId("create-draft"));
  await client.syncWith(inProcessTransport(server), HASH);

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
  await client.syncWith(inProcessTransport(server), HASH);

  assert.equal(client.listQuarantine().length > 0, true, "the orphaned write was not set aside");
  assert.equal(
    client.isRowDirty(DRAFTS, ROW),
    false,
    "a quarantined write against one collection dirtied a row of the same id in another",
  );
});

test("a pull does not settle a field whose write is sitting in quarantine", async () => {
  // Quarantine means the local state has diverged for good and only the person can resolve it
  // (§5.5), which is why quarantined ops keep their row dirty (§5.8). A pull that applies the
  // scope's value over the write anyway resolves that divergence on their behalf and without
  // telling them: the row goes on reading as dirty, quarantine goes on offering to retry a
  // write, and the text they typed is nowhere on screen. Whether it survived would come down to
  // whether a pull happened to carry the field.
  const server = new WeftServer();
  const client = device("tab-1");

  // Made offline, so the scope has never heard of the row, and then edited.
  await client.create(NOTES, ROW, values({ title: "as created" }), txnId("create"));
  await client.update(NOTES, ROW, values({ title: "as edited" }), txnId("edit"));

  // A resync finds the row absent, which sets every unsent op for it aside — the edit included.
  await client.applySnapshot(server.snapshot(SCOPE));
  assert.equal(
    client.listQuarantine().some((op) => op.txnId === txnId("edit")),
    true,
    "the unsent edit was not set aside when the resync found the row absent",
  );

  // The person repairs the creation but not the edit, so the row reaches the scope carrying the
  // value it was created with, and the very next pull offers that value back.
  await client.retryQuarantinedTxn(txnId("create"));
  await client.syncWith(inProcessTransport(server), HASH);

  assert.equal(client.getRow(NOTES, ROW)?.fields.get(TITLE), "as edited", "the pull overwrote the quarantined write");
  assert.equal(
    client.listQuarantine().some((op) => op.txnId === txnId("edit")),
    true,
    "the edit left quarantine without the person deciding anything",
  );
  assert.equal(client.isRowDirty(NOTES, ROW), true, "a row still holding quarantined work read as clean");
});

test("retrying a quarantined write queues the row's current value", async () => {
  const server = new WeftServer();
  const client = device("tab-1");

  await client.create(NOTES, ROW, values({ title: "first" }), txnId("create"));
  await client.applySnapshot(server.snapshot(SCOPE));
  await client.update(NOTES, ROW, values({ title: "second" }), txnId("second"));
  await client.syncWith(inProcessTransport(server), HASH);

  await client.retryQuarantinedTxn(txnId("create"));
  await client.update(NOTES, ROW, values({ title: "third" }), txnId("third"));
  client.outbox.push(...client.outbox.splice(0, 1));
  await client.syncWith(inProcessTransport(server), HASH);

  assert.equal(client.getRow(NOTES, ROW)?.fields.get(TITLE), "third", "the later local edit never landed");
  assert.equal(
    client.listQuarantine().some((op) => op.txnId === txnId("second")),
    true,
    "the older edit was not left for repair",
  );

  await client.retryQuarantinedTxn(txnId("second"));

  assert.equal(client.outbox.length, 1, "the repaired write did not return to the outbox");
  assert.equal(
    client.getRow(NOTES, ROW)?.fields.get(TITLE),
    "third",
    "retrying the older write rewrote the row away from what the device still shows",
  );
  assert.equal(client.outbox[0]?.kind, "set");
  assert.equal(client.outbox[0]?.kind === "set" ? client.outbox[0].value : undefined, "third");
});

test("a quarantined write does not withhold a field from the next life of its row", async () => {
  // The other edge of the rule above. A quarantined write protects the value it left in the row,
  // and a row that has been deleted and had its id used again does not hold that value any more —
  // the delete took it. Reading the quarantined op as a claim on the field regardless would leave
  // the new row missing the field altogether: not the person's text, not the scope's, nothing.
  const server = new WeftServer();
  const author = device("tab-1");
  const editor = device("tab-2");

  await author.create(NOTES, ROW, values({ title: "first life" }), txnId("create"));
  await author.syncWith(inProcessTransport(server), HASH);
  await editor.syncWith(inProcessTransport(server), HASH);

  // The editor's unsent edit meets the author's delete, which is what sets the edit aside.
  await editor.update(NOTES, ROW, values({ title: "as edited" }), txnId("edit"));
  await author.delete(NOTES, ROW, txnId("delete"));
  await author.syncWith(inProcessTransport(server), HASH);
  await editor.applyPull(server.pull(SCOPE, editor.lastServerSeq));
  assert.equal(
    editor.listQuarantine().some((op) => op.txnId === txnId("edit")),
    true,
    "the edit was not set aside when the row was deleted under it",
  );

  // The tombstone is purged and the id is used again by a device that never saw the first life.
  server.pruneTombstones(SCOPE, 0);
  const stranger = device("tab-3");
  await stranger.syncWith(inProcessTransport(server), HASH);
  await stranger.create(NOTES, ROW, values({ title: "second life" }), txnId("create-again"));
  await stranger.syncWith(inProcessTransport(server), HASH);

  await editor.applyPull(server.pull(SCOPE, editor.lastServerSeq));

  assert.equal(
    editor.getRow(NOTES, ROW)?.fields.get(TITLE),
    "second life",
    "the new life of the row arrived without the field the quarantined write named",
  );
});

test("a snapshot writes the client through to its store", async () => {
  // §4.1 makes local storage the client's state rather than a cache of it. A snapshot replaces
  // most of what a device holds, so a snapshot that is not written through is the largest
  // possible divergence between what the client shows and what survives a reload.
  const server = new WeftServer();
  const author = device("tab-1");
  await author.create(NOTES, ROW, values({ title: "shared" }), txnId("create"));
  await author.syncWith(inProcessTransport(server), HASH);

  const reader = device("tab-2");
  let saves = 0;
  const persistence: ClientPersistence = {
    save: async () => {
      saves += 1;
    },
  };
  reader.persistence = persistence;

  const before = saves;
  await reader.applySnapshot(server.snapshot(SCOPE));

  assert.equal(saves > before, true, "applying a snapshot never reached the store");
  assert.equal(reader.getRow(NOTES, ROW)?.fields.get(TITLE), "shared", "the snapshot did not land locally");
});
