// A durable relay writes what the last operation touched rather than the whole scope, which
// makes the cost of accepting an edit independent of how much has been written before it. The
// risk that buys is silence: a mutation nobody recorded as touched is simply not written, and
// nothing goes wrong until the process restarts and the change is gone.
//
// So the property is not "a reload works" — that can pass while a record quietly lags — but
// that the database and the server's own memory agree, record for record, after every history.
// A full rewrite would satisfy that by construction; an incremental one has to earn it.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { rowId, txnId, type SqlRow } from "weftdb/shared";
import type { WeftClient } from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { SqliteWeftServer } from "weftdb/server/sqlite";
import { openSqliteExecutor, type SqliteExecutor } from "weftdb/server/node-sqlite";
import {
  AUTO_DELETE_DAYS,
  BASE_NOTES,
  CONSUMED_AT,
  deviceAt,
  NOTES,
  propertySchema,
  quiesce,
  RANK,
  runWorld,
  SCENARIO_RUNS,
  STATUS,
  TASKS,
  TITLE,
  worldCommands,
} from "./property-model.ts";

test("everything the server holds is everything the database holds", () => {
  fc.assert(
    fc.property(worldCommands(40), (commands) => {
      using database = temporaryDatabase();
      const world = runWorld(commands, 3, (now) => new SqliteWeftServer(database.executor, now));
      quiesce(world);
      const server = world.server as SqliteWeftServer;

      assert.deepEqual(
        storedFields(database.executor),
        heldFields(server),
        "the fields table disagrees with the server",
      );
      assert.deepEqual(storedRows(database.executor), heldRows(server), "the rows table disagrees with the server");
      assert.deepEqual(
        storedDevices(database.executor),
        heldDevices(server),
        "the devices table disagrees with the server",
      );
    }),
    { numRuns: Math.min(SCENARIO_RUNS, 40) },
  );
});

test("a reloaded server answers as the one that was running", () => {
  fc.assert(
    fc.property(worldCommands(40), (commands) => {
      using database = temporaryDatabase();
      const world = runWorld(commands, 3, (now) => new SqliteWeftServer(database.executor, now));
      quiesce(world);
      const reloaded = new SqliteWeftServer(database.executor, () => world.now);

      // Answering the same pull with the same records is what a device would notice, and it
      // covers the state a comparison of tables alone would not — the scope's cursor and floor.
      const before = world.server.pull(world.scopeId, 0);
      const after = reloaded.pull(world.scopeId, 0);
      assert.equal(after.serverSeq, before.serverSeq, "the reloaded server is at another sequence");
      assert.equal(after.tombstoneFloorSeq, before.tombstoneFloorSeq, "the tombstone floor did not survive");
      assert.deepEqual(canonical(after.fields), canonical(before.fields), "a pull came back with other records");
      assert.deepEqual(canonical(after.rows), canonical(before.rows), "a pull came back with other rows");
    }),
    { numRuns: Math.min(SCENARIO_RUNS, 40) },
  );
});

test("everything a device holds is everything its database holds", () => {
  // The client store writes per changed row for the same reason the relay does, and carries the
  // same risk: a mutation nobody recorded is a row that silently stops being written, and the
  // device only finds out when it reloads.
  fc.assert(
    fc.property(worldCommands(40), (commands) => {
      using database = temporaryDatabase();
      const world = runWorld(commands);
      quiesce(world);
      const source = deviceAt(world, 0).client;

      const store = new SqliteClientStore(database.executor, propertySchema);
      store.installSchema();
      // Attach rather than save: from here on the client writes itself through on every change,
      // which is the incremental path rather than the opening full write.
      store.attach(source);
      for (const command of REPLAY) command(source);

      const hydrated = store.hydrate(source.scopeId, source.deviceId);
      assert.deepEqual(rowsOf(hydrated), rowsOf(source), "the stored rows are not the rows the device holds");
      assert.deepEqual(
        [...hydrated.tombstones.keys()].sort(),
        [...source.tombstones.keys()].sort(),
        "the stored tombstones are not the ones the device holds",
      );
      assert.deepEqual(hydrated.outbox, source.outbox, "the stored outbox is not the one the device holds");
    }),
    { numRuns: Math.min(SCENARIO_RUNS, 40) },
  );
});

/** Edits made after the store is attached, so every one of them takes the incremental path. */
const REPLAY: readonly ((client: WeftClient) => void)[] = [
  (client) => {
    // A task, because that is the collection with a title to edit.
    const key = [...client.rows.keys()].find((candidate) => candidate.startsWith(`${TASKS}\0`));
    const row = key?.split("\0")[1];
    if (row === undefined) return;
    client.update(TASKS, rowId(row), { [TITLE]: "edited after attach" }, txnId("replay-edit"));
  },
  (client) => {
    client.create(
      TASKS,
      rowId("attached-row"),
      {
        [TITLE]: "made after attach",
        [STATUS]: "open",
        [NOTES]: BASE_NOTES,
        [RANK]: "z0",
        [CONSUMED_AT]: null,
        [AUTO_DELETE_DAYS]: null,
      },
      txnId("replay-create"),
    );
  },
  (client) => {
    client.delete(TASKS, rowId("attached-row"), txnId("replay-delete"));
  },
];

/** Rows as a store has to preserve them, in a form two clients compare by. */
function rowsOf(client: WeftClient): readonly string[] {
  return [...client.rows.entries()]
    .map(([key, row]) =>
      JSON.stringify({
        key,
        created: row.created,
        fields: [...row.fields.entries()].sort(),
        hlc: [...row.internals.hlc.entries()].sort(),
        diff3Base: [...row.internals.diff3Base.entries()].sort(),
        dirty: row.internals._weft_dirty,
        firstSyncedAt: row.internals._weft_first_synced_at,
      }),
    )
    .sort();
}

interface TemporaryDatabase extends Disposable {
  readonly executor: SqliteExecutor;
}

function temporaryDatabase(): TemporaryDatabase {
  const directory = mkdtempSync(join(tmpdir(), "weft-incremental-"));
  const executor = openSqliteExecutor(join(directory, "weft.sqlite"));
  return {
    executor,
    [Symbol.dispose]: () => {
      executor.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function storedFields(executor: SqliteExecutor): readonly string[] {
  return [
    ...executor.all<string>({
      sql: "SELECT scope_id, table_name, row_id, field, value, hlc, server_seq, txn_id FROM fields",
      parameters: [],
      decode: (row) => line(row),
    }),
  ].sort();
}

function heldFields(server: SqliteWeftServer): readonly string[] {
  return [...server.fields.values()]
    .map((field) =>
      line({
        scope_id: field.scopeId,
        table_name: field.tableName,
        row_id: field.rowId,
        field: field.field,
        value: JSON.stringify(field.value),
        hlc: field.hlc,
        server_seq: field.serverSeq,
        txn_id: field.txnId,
      }),
    )
    .sort();
}

function storedRows(executor: SqliteExecutor): readonly string[] {
  return [
    ...executor.all<string>({
      sql: "SELECT scope_id, table_name, row_id, first_seen_at, class, deleted_hlc, register_hlc, server_seq FROM rows",
      parameters: [],
      decode: (row) => line(row),
    }),
  ].sort();
}

function heldRows(server: SqliteWeftServer): readonly string[] {
  return [...server.rows.values()]
    .map((row) =>
      line({
        scope_id: row.scopeId,
        table_name: row.tableName,
        row_id: row.rowId,
        first_seen_at: row.firstSeenAt,
        class: row.class,
        deleted_hlc: row.deletedHlc,
        register_hlc: row.registerHlc,
        server_seq: row.serverSeq,
      }),
    )
    .sort();
}

function storedDevices(executor: SqliteExecutor): readonly string[] {
  return [
    ...executor.all<string>({
      sql: "SELECT scope_id, device_id, last_seen FROM devices",
      parameters: [],
      decode: (row) => line(row),
    }),
  ].sort();
}

function heldDevices(server: SqliteWeftServer): readonly string[] {
  return [...server.devices.values()]
    .map((device) => line({ scope_id: device.scopeId, device_id: device.deviceId, last_seen: device.lastSeen }))
    .sort();
}

function line(row: SqlRow | Record<string, unknown>): string {
  return Object.entries(row)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${cellText(value)}`)
    .join(" ");
}

/**
 * Two rows are the same row when their lines are, so a cell that stringifies to `[object Object]`
 * would make every object-valued cell compare equal to every other. Scalars read as themselves.
 */
function cellText(value: unknown): string {
  if (value === null) return "null";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function canonical(records: readonly object[]): readonly string[] {
  return records.map((record) => line(record as Record<string, unknown>)).sort();
}
