import assert from "node:assert/strict";
import { test } from "vitest";
import {
  compareHlc,
  deviceId,
  diff3,
  fieldName,
  hasConflictMarkers,
  rowId,
  schemaHashValue,
  scopeId,
  tableName,
  txnId,
} from "weftdb/shared";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { WeftServer } from "weftdb/server";
import { applyRetentionDeletes, planRetentionDeletes, WeftClient } from "weftdb/client";

const scope = scopeId("scope-a");
const tasks = tableName("tasks");
const row = rowId("task-1");
const title = fieldName("title");

const schema = defineSchema({
  tasks: S.collection({
    title: S.string(),
    notes: S.string({ merge: "diff3" }),
  }),
  task_status_history: S.eventLog({
    status: S.string(),
  }),
});

test("HLCs emitted by one client are strictly monotonic", () => {
  let now = 1_000;
  const client = new WeftClient(scope, deviceId("a"), schema, () => now);
  const first = client.clock.next();
  const second = client.clock.next();
  now += 1;
  const third = client.clock.next();
  assert.equal(compareHlc(first, second), -1);
  assert.equal(compareHlc(second, third), -1);
});

test("diff3 merges non-overlapping line edits and marks overlapping edits", () => {
  assert.deepEqual(diff3("a\nb", "A\nb", "a\nB"), { value: "A\nB", conflicted: false });
  const conflict = diff3("a", "local", "remote");
  assert.equal(conflict.conflicted, true);
  assert.equal(hasConflictMarkers(conflict.value), true);
});

test("server rejects a transaction atomically", () => {
  const server = new WeftServer(() => 1_000);
  const client = new WeftClient(scope, deviceId("a"), schema, () => 1_000);
  client.create(tasks, row, { [title]: "one" }, txnId("t1"));
  client.flush(server);

  const before = server.fields.size;
  const existingRow = rowId("task-2");
  const other = new WeftClient(scope, deviceId("b"), schema, () => 1_001);
  other.create(tasks, existingRow, { [title]: "two" }, txnId("t2"));
  other.flush(server);
  other.update(tasks, existingRow, { [fieldName("created")]: "mutated", [title]: "mutated" }, txnId("bad"));
  other.flush(server);

  assert.equal(server.fields.size, before + 4);
  assert.equal(other.quarantine.length, 2);
  assert.equal(other.outbox.length, 0);
});

test("append rows reject later mutation, whoever sends it", () => {
  const server = new WeftServer(() => 1_000);
  const client = new WeftClient(scope, deviceId("a"), schema, () => 1_000);
  const eventTable = tableName("task_status_history");
  client.append(eventTable, rowId("event-1"), { [fieldName("status")]: "open" }, txnId("append"));
  client.flush(server);

  // A well-behaved client refuses to queue this at all, so the op is built by hand: the rule
  // is the server's to enforce, against any client, including one older than this rule or one
  // that does not care for it (§9.23).
  const result = server.push(scope, [
    {
      scopeId: scope,
      tableName: eventTable,
      rowId: rowId("event-1"),
      kind: "set",
      field: fieldName("status"),
      value: "done",
      hlc: client.clock.next(),
      txnId: txnId("mutate"),
    },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection.reason, "append_class_violation");
  assert.equal(
    server
      .snapshot(scope)
      .fields.find((field) => field.rowId === rowId("event-1") && field.field === fieldName("status"))?.value,
    "open",
    "the append row was changed after all",
  );
});

test("a client refuses to edit an append row rather than queue work that cannot land", () => {
  const client = new WeftClient(scope, deviceId("a"), schema, () => 1_000);
  const eventTable = tableName("task_status_history");
  client.append(eventTable, rowId("event-1"), { [fieldName("status")]: "open" }, txnId("append"));
  const queued = client.outbox.length;

  assert.throws(
    () => client.update(eventTable, rowId("event-1"), { [fieldName("status")]: "done" }, txnId("mutate")),
    /append-class/u,
  );
  assert.equal(client.outbox.length, queued, "the refused edit was queued anyway");
});

test("field writes do not resurrect tombstoned rows", () => {
  const server = new WeftServer(() => 1_000);
  const creator = new WeftClient(scope, deviceId("a"), schema, () => 1_000);
  creator.create(tasks, row, { [title]: "one" }, txnId("create"));
  creator.flush(server);
  creator.delete(tasks, row, txnId("delete"));
  creator.flush(server);

  const writer = new WeftClient(scope, deviceId("b"), schema, () => 1_001);
  writer.applySnapshot(server.snapshot(scope));
  writer.restore(tasks, row, { [title]: "one" }, txnId("local-restore"));
  writer.update(tasks, row, { [title]: "changed" }, txnId("write"));
  const setOnly = writer.outbox.filter((op) => op.kind === "set");
  const result = server.push(scope, setOnly);
  assert.equal(result.ok, true);
  assert.notEqual(
    server.snapshot(scope).rows.find((candidate) => candidate.tableName === tasks && candidate.rowId === row)
      ?.deletedHlc,
    null,
  );
});

test("schema versions only roll forward", () => {
  const server = new WeftServer(() => 1_000);
  assert.deepEqual(
    server.handshake({
      scopeId: scope,
      deviceId: deviceId("a"),
      schemaHash: schemaHash(schema),
      schemaVersion: 1,
      lastServerSeq: 0,
    }),
    {
      ok: true,
      serverSeq: 0,
    },
  );
  assert.deepEqual(
    server.handshake({
      scopeId: scope,
      deviceId: deviceId("b"),
      schemaHash: schemaHashValue("other"),
      schemaVersion: 1,
      lastServerSeq: 0,
    }),
    {
      ok: false,
      reason: "schema_mismatch",
    },
  );
  assert.deepEqual(
    server.handshake({
      scopeId: scope,
      deviceId: deviceId("c"),
      schemaHash: schemaHashValue("new"),
      schemaVersion: 2,
      lastServerSeq: 0,
    }),
    {
      ok: true,
      serverSeq: 0,
    },
  );
});

test("clock skew rejection is restamped and retried without quarantine", () => {
  const server = new WeftServer(() => 1_000);
  const client = new WeftClient(scope, deviceId("future"), schema, () => 10_000_000);
  client.create(tasks, rowId("future-row"), { [title]: "future" }, txnId("future-txn"));
  client.flush(server);
  assert.equal(client.outbox.length, 0);
  assert.equal(client.quarantine.length, 0);
  assert.equal(
    server.snapshot(scope).rows.some((candidate) => candidate.rowId === rowId("future-row")),
    true,
  );
});

test("quarantine repair API exports, retries, and discards by transaction", () => {
  const server = new WeftServer(() => 1_000);
  const client = new WeftClient(scope, deviceId("repair"), schema, () => 1_000);
  client.create(tasks, rowId("repair-row"), { [title]: "repair" }, txnId("repair-create"));
  client.flush(server);
  client.update(tasks, rowId("repair-row"), { [fieldName("created")]: "bad" }, txnId("repair-bad"));
  client.flush(server);

  assert.equal(client.exportQuarantinedTxn(txnId("repair-bad")).length, 1);
  client.retryQuarantinedTxn(txnId("repair-bad"));
  assert.equal(client.quarantine.length, 0);
  assert.equal(client.outbox.length, 1);
  client.flush(server);
  assert.equal(client.quarantine.length, 1);
  client.discardQuarantinedTxn(txnId("repair-bad"));
  assert.equal(client.quarantine.length, 0);
});

test("retention planner uses max retention anchor and first synced time", () => {
  const retentionSchema = defineSchema({
    entries: S.collection({
      consumed_at: S.number({ retentionAnchor: true }),
      auto_delete_days: S.number({ nullable: true }),
    }),
  });
  const server = new WeftServer(() => 10_000);
  const client = new WeftClient(scope, deviceId("retention"), retentionSchema, () => 1_000);
  const entries = tableName("entries");
  const entry = rowId("entry-1");
  client.create(
    entries,
    entry,
    {
      [fieldName("consumed_at")]: 1_000,
      [fieldName("auto_delete_days")]: 1,
    },
    txnId("retention-create"),
  );
  client.sync(server, schemaHash(retentionSchema));
  assert.deepEqual(planRetentionDeletes(client, retentionSchema, { defaultAutoDeleteDays: 30 }, 20_000), []);
  assert.equal(planRetentionDeletes(client, retentionSchema, { defaultAutoDeleteDays: 30 }, 90_000_000).length, 1);
});

test("applyRetentionDeletes deletes exactly the rows the planner returned, and queues those deletes for sync", () => {
  const retentionSchema = defineSchema({
    entries: S.collection({
      consumed_at: S.number({ retentionAnchor: true }),
      auto_delete_days: S.number({ nullable: true }),
    }),
  });
  const server = new WeftServer(() => 10_000);
  const client = new WeftClient(scope, deviceId("retention-driver"), retentionSchema, () => 1_000);
  const entries = tableName("entries");
  const expired = rowId("expired-1");
  const fresh = rowId("fresh-1");
  client.create(
    entries,
    expired,
    {
      [fieldName("consumed_at")]: 1_000,
      [fieldName("auto_delete_days")]: 1,
    },
    txnId("expired-create"),
  );
  client.create(
    entries,
    fresh,
    {
      [fieldName("consumed_at")]: 1_000,
      [fieldName("auto_delete_days")]: 365,
    },
    txnId("fresh-create"),
  );
  client.sync(server, schemaHash(retentionSchema));

  const nowMs = 90_000_000;
  const planned = planRetentionDeletes(client, retentionSchema, { defaultAutoDeleteDays: 30 }, nowMs);
  const deleted = applyRetentionDeletes(client, retentionSchema, { defaultAutoDeleteDays: 30 }, nowMs);
  assert.deepEqual(deleted, planned, "applyRetentionDeletes acted on a different set than the planner returned");
  assert.deepEqual(
    deleted.map((candidate) => candidate.rowId),
    [expired],
  );

  assert.equal(client.getRow(entries, expired), undefined, "the expired row was not deleted locally");
  assert.notEqual(client.getRow(entries, fresh), undefined, "a row that had not expired was deleted");

  // A local delete is a tombstone plus a queued op (§4.1); both are how the caller can tell the
  // driver did more than plan.
  assert.equal(
    [...client.tombstones.values()].some((tombstone) => tombstone.tableName === entries && tombstone.rowId === expired),
    true,
    "the expired row was not tombstoned",
  );
  const queuedDeletes = client.outbox.filter((op) => op.kind === "delete");
  assert.deepEqual(
    queuedDeletes.map((op) => op.rowId),
    [expired],
    "the retention delete never reached the outbox",
  );
});

test("applyRetentionDeletes never deletes an event-log row", () => {
  const retentionSchema = defineSchema({
    readings: S.eventLog({
      recorded_at: S.number({ retentionAnchor: true }),
      auto_delete_days: S.number({ nullable: true }),
    }),
  });
  const client = new WeftClient(scope, deviceId("retention-eventlog"), retentionSchema, () => 1_000);
  const readings = tableName("readings");
  const reading = rowId("reading-1");
  // planRetentionDeletes skips eventLog collections outright (retention.ts), so there is nothing
  // here for a sync to make eligible; the row would still fail client.delete() if it ever became
  // a candidate, since append-class rows refuse deletion (§9.23).
  client.append(
    readings,
    reading,
    {
      [fieldName("recorded_at")]: 1_000,
      [fieldName("auto_delete_days")]: 1,
    },
    txnId("reading-create"),
  );

  const deleted = applyRetentionDeletes(client, retentionSchema, { defaultAutoDeleteDays: 30 }, 90_000_000);
  assert.deepEqual(deleted, []);
  assert.notEqual(client.getRow(readings, reading), undefined, "an event-log row was deleted by retention");
});
