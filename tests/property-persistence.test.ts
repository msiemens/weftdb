// Storage and wire-format fidelity: whatever a generated history produced has to survive a
// reload, a save/hydrate cycle, and a trip through the snapshot format unchanged.
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { asyncSqlExecutor, type AsyncSqlExecutor } from "weftdb/shared";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { openSqliteExecutor, type SqliteExecutor } from "weftdb/server/node-sqlite";
import { SqliteWeftServer } from "weftdb/server/sqlite";
import { snapshotDigest, snapshotFromNdjson, snapshotToNdjson, type SnapshotLine } from "weftdb/server/snapshot";
import type { Snapshot } from "weftdb/server";
import {
  deviceAt,
  propertySchema,
  quiesce,
  runWorld,
  SCENARIO_RUNS,
  serverRowFingerprints,
  worldCommands,
} from "./property-model.ts";

const BASE_FIELDS: ReadonlySet<string> = new Set(["id", "scope_id", "created"]);

test("§4.2 a history run against the SQLite server survives a reload", async () => {
  await fc.assert(
    fc.asyncProperty(worldCommands(40), async (commands) => {
      using database = temporaryDatabase();
      const world = await runWorld(commands, 3, (now) => new SqliteWeftServer(database.connection, now));
      await quiesce(world);

      const before = serverRowFingerprints(world);
      const reloaded = new SqliteWeftServer(database.connection, () => world.now);
      assert.deepEqual(
        snapshotState(reloaded.snapshotInReadTransaction(world.scopeId)),
        snapshotState(world.server.snapshot(world.scopeId)),
      );
      assert.deepEqual(serverRowFingerprints({ ...world, server: reloaded }), before);
      assert.equal(
        reloaded.scopes.get(world.scopeId)?.tombstoneFloorSeq,
        world.server.scopes.get(world.scopeId)?.tombstoneFloorSeq,
        "the tombstone floor did not survive the reload",
      );
      assert.equal(reloaded.devices.size, world.server.devices.size, "the device registry did not survive the reload");
    }),
    { numRuns: Math.min(SCENARIO_RUNS, 40) },
  );
});

test("§4.1 a client survives a save and hydrate cycle", async () => {
  await fc.assert(
    fc.asyncProperty(worldCommands(40), async (commands) => {
      using database = temporaryDatabase();
      const world = await runWorld(commands);
      await quiesce(world);

      const store = new SqliteClientStore(database.executor, propertySchema);
      await store.installSchema();
      const client = deviceAt(world, 0).client;
      await store.save(client);
      const hydrated = await store.hydrate(client.scopeId, client.deviceId);

      assert.deepEqual(localState(hydrated), localState(client), "rows did not survive the round trip");
      assert.deepEqual(hydrated.outbox, client.outbox, "the outbox did not survive the round trip");
      assert.deepEqual(hydrated.quarantine, client.quarantine, "quarantine did not survive the round trip");
      assert.deepEqual(
        [...hydrated.tombstones.keys()].sort(),
        [...client.tombstones.keys()].sort(),
        "tombstones were lost",
      );
      assert.equal(hydrated.lastServerSeq, client.lastServerSeq, "the sync cursor was lost");
    }),
    { numRuns: Math.min(SCENARIO_RUNS, 40) },
  );
});

test("§5.2 the snapshot format round-trips every record", async () => {
  await fc.assert(
    fc.asyncProperty(worldCommands(40), async (commands) => {
      const world = await runWorld(commands);
      await quiesce(world);
      const snapshot = world.server.snapshot(world.scopeId);

      const lines = snapshotToNdjson(snapshot)
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as SnapshotLine);

      const header = lines[0];
      assert.equal(header?.type, "header");
      if (header?.type === "header") {
        assert.equal(header.serverSeq, snapshot.serverSeq);
        assert.equal(header.tombstoneFloorSeq, snapshot.tombstoneFloorSeq);
      }
      assert.deepEqual(
        lines.flatMap((line) => (line.type === "field" ? [canonical(line.record)] : [])).sort(),
        snapshot.fields.map(canonical).sort(),
        "a field record changed shape in the snapshot format",
      );
      assert.deepEqual(
        lines.flatMap((line) => (line.type === "row" ? [canonical(line.record)] : [])).sort(),
        snapshot.rows.map(canonical).sort(),
        "a row record changed shape in the snapshot format",
      );
    }),
    { numRuns: Math.min(SCENARIO_RUNS, 40) },
  );
});

test("§5.2 snapshot input refuses unknown line types instead of treating them as rows", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 16 }).filter((type) => !["header", "field", "row"].includes(type)),
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        { maxKeys: 4 },
      ),
      (type, record) => {
        const body = [
          JSON.stringify({ type: "header", serverSeq: 0, tombstoneFloorSeq: 0, schemaHash: null }),
          JSON.stringify({ type, record }),
        ].join("\n");

        assert.throws(() => snapshotFromNdjson(body), /snapshot|line|type|record/u);
      },
    ),
    { numRuns: Math.min(SCENARIO_RUNS, 100) },
  );
});

test("§5.2 snapshot input refuses non-finite cursors and malformed records", () => {
  const badNumber = fc.oneof(fc.string(), fc.boolean(), fc.constant(null), fc.constant({}), fc.constant([]));
  fc.assert(
    fc.property(
      fc.oneof(
        badNumber.map((serverSeq) => [{ type: "header", serverSeq, tombstoneFloorSeq: 0, schemaHash: null }]),
        badNumber.map((tombstoneFloorSeq) => [{ type: "header", serverSeq: 0, tombstoneFloorSeq, schemaHash: null }]),
        fc.constant([{ type: "header", serverSeq: Number.POSITIVE_INFINITY, tombstoneFloorSeq: 0, schemaHash: null }]),
        fc.constant([{ type: "header", serverSeq: 0, tombstoneFloorSeq: Number.POSITIVE_INFINITY, schemaHash: null }]),
        fc.constant([{ type: "header", serverSeq: 0, tombstoneFloorSeq: 0, schemaHash: null }, { type: "field" }]),
        fc.constant([{ type: "header", serverSeq: 0, tombstoneFloorSeq: 0, schemaHash: null }, { type: "row" }]),
      ),
      (lines) => {
        const body = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
        assert.throws(() => snapshotFromNdjson(body), /snapshot|line|type|record|serverSeq|tombstone/u);
      },
    ),
    { numRuns: Math.min(SCENARIO_RUNS, 100) },
  );
});

test("§5.2 the content address is a function of the records, not of their order", async () => {
  await fc.assert(
    fc.asyncProperty(
      worldCommands(30),
      fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 16, maxLength: 16 }),
      fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 16, maxLength: 16 }),
      async (commands, fieldKeys, rowKeys) => {
        // Storage iteration order is an implementation detail; two servers holding the same
        // records may hold them in any order. If the digest disagreed, snapshot caching and
        // backup verification would both be defeated.
        const world = await runWorld(commands);
        await quiesce(world);
        const snapshot = world.server.snapshot(world.scopeId);
        const reordered: Snapshot = {
          ...snapshot,
          fields: [...permute(snapshot.fields, fieldKeys)],
          rows: [...permute(snapshot.rows, rowKeys)],
        };

        assert.equal(snapshotDigest(reordered), snapshotDigest(snapshot), "the digest depends on record order");
        assert.equal(
          snapshotToNdjson(reordered),
          snapshotToNdjson(snapshot),
          "the serialized bytes depend on record order",
        );
      },
    ),
    { numRuns: Math.min(SCENARIO_RUNS, 60) },
  );
});

/**
 * Both ports over the one connection. The server takes `connection`, the client store takes
 * `executor`. A second `asyncSqlExecutor` over the same connection would hold a second
 * transaction queue, and the two would issue overlapping `BEGIN`s.
 */
interface TemporaryDatabase extends Disposable {
  readonly connection: SqliteExecutor;
  readonly executor: AsyncSqlExecutor;
}

function temporaryDatabase(): TemporaryDatabase {
  const directory = mkdtempSync(join(tmpdir(), "weft-persistence-"));
  const connection = openSqliteExecutor(join(directory, "weft.sqlite"));
  return {
    connection,
    executor: asyncSqlExecutor(connection),
    [Symbol.dispose]: () => {
      connection.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Rows as the application sees them, plus the internals the client store must preserve. */
function localState(client: import("weftdb/client").WeftClient): readonly string[] {
  return [...client.rows.entries()]
    .map(([key, row]) => {
      const fields = [...row.fields.entries()]
        .filter(([field]) => !BASE_FIELDS.has(String(field)))
        .sort(([left], [right]) => left.localeCompare(right));
      return JSON.stringify({
        key,
        id: row.id,
        scopeId: row.scopeId,
        created: row.created,
        fields,
        firstSyncedAt: row.internals._weft_first_synced_at,
        dirty: row.internals._weft_dirty,
        hlc: [...row.internals.hlc.entries()].sort(([left], [right]) => left.localeCompare(right)),
        diff3Base: [...row.internals.diff3Base.entries()].sort(([left], [right]) => left.localeCompare(right)),
      });
    })
    .sort();
}

/** Key order is not part of a record's identity, so records compare by sorted keys. */
function canonical(record: object): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function snapshotState(snapshot: Snapshot): readonly string[] {
  // Through `canonical`, because a record's key order reflects where it was built. A record
  // read back out of storage names its keys in column order, an artifact of how it was stored.
  return [...snapshot.fields.map(canonical), ...snapshot.rows.map(canonical)].sort();
}

function permute<T>(items: readonly T[], keys: readonly number[]): readonly T[] {
  return items
    .map((item, index) => ({ item, index, key: keys[index % keys.length] ?? index }))
    .sort((left, right) => left.key - right.key || left.index - right.index)
    .map((entry) => entry.item);
}
