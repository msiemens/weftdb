// DESIGN.md §9 "Convergence" — the invariants that need a specific arrangement rather than
// a generated history. Commutativity, idempotence, snapshot equivalence, floor
// independence and stale-client safety. §9.3, §9.4, §9.8, §9.8a, §9.8b and §9.15 are
// checked continuously by the world model instead (property-invariants.ts).
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { fieldName, rowId, txnId, type RowId, type WeftOp } from "weftdb/shared";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import {
  at,
  createWorld,
  DAY_MS,
  deviceAt,
  localState,
  MODEL_ROWS,
  propertySchema,
  propertySchemaHash,
  propertyScope,
  quiesce,
  runWorld,
  serverRowFingerprints,
  SCENARIO_RUNS,
  STATUS,
  TASKS,
  TITLE,
  TOMBSTONE_FLOOR_MS,
  worldCommands,
  type PropertyWorld,
} from "./property-model.ts";

type Mutation =
  | { readonly kind: "update"; readonly row: number; readonly onTitle: boolean; readonly value: string }
  | { readonly kind: "delete"; readonly row: number }
  | { readonly kind: "restore"; readonly row: number; readonly value: string };

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({
    kind: fc.constant("update" as const),
    row: fc.integer({ min: 0, max: MODEL_ROWS.length - 1 }),
    onTitle: fc.boolean(),
    value: fc.string({ minLength: 1, maxLength: 10 }),
  }),
  fc.record({ kind: fc.constant("delete" as const), row: fc.integer({ min: 0, max: MODEL_ROWS.length - 1 }) }),
  fc.record({
    kind: fc.constant("restore" as const),
    row: fc.integer({ min: 0, max: MODEL_ROWS.length - 1 }),
    value: fc.string({ minLength: 1, maxLength: 10 }),
  }),
);

const historyArb = fc.array(mutationArb, { minLength: 1, maxLength: 30 });
const permutationKeysArb = fc.array(fc.integer({ min: 0, max: 1_000 }), { minLength: 64, maxLength: 64 });

test("§9.1 any delivery order of the same op set yields identical state", () => {
  fc.assert(
    fc.property(historyArb, permutationKeysArb, permutationKeysArb, (history, leftKeys, rightKeys) => {
      const batches = transactionsFor(history);
      assert.deepEqual(
        serverRowFingerprints(deliver(batches, leftKeys)),
        serverRowFingerprints(deliver(batches, rightKeys)),
      );
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.2 duplicate delivery of any op is a no-op", () => {
  fc.assert(
    fc.property(historyArb, permutationKeysArb, (history, keys) => {
      const batches = transactionsFor(history);
      assert.deepEqual(
        serverRowFingerprints(deliver(batches, keys)),
        serverRowFingerprints(deliver(batches, keys, { duplicate: true })),
      );
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.5 snapshot plus outbox replay equals incremental pull plus outbox replay", () => {
  fc.assert(
    fc.property(worldCommands(60), fc.string({ minLength: 1, maxLength: 10 }), (commands, replayed) => {
      const world = runWorld(commands);
      quiesce(world);

      const snapshot = world.server.snapshot(world.scopeId);
      const incremental = world.server.pull(world.scopeId, 0);
      const fromSnapshot = freshClient(world);
      const fromPull = freshClient(world);
      fromSnapshot.applySnapshot(snapshot);
      fromPull.applyPull(incremental);

      if (incremental.tombstoneFloorSeq > 0) {
        // Purging destroys the records a from-zero stream would need, so the equivalence is
        // only claimed above the floor: below it the client must resync instead (§1.5).
        assert.equal(fromPull.resyncRequired, true, "an unusable incremental stream was applied anyway");
        fromPull.applySnapshot(snapshot);
      }
      for (const client of [fromSnapshot, fromPull]) replayOutbox(client, replayed);

      assert.deepEqual(clientState(fromSnapshot), clientState(fromPull));
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.6 pruning tombstones leaves every device above the floor unchanged", () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }), (doomed) => {
      const world = createWorld(3);
      const owner = deviceAt(world, 0).client;
      const rows = doomed.map((_, index) => rowId(`floor-${index}`));
      for (const row of rows) owner.create(TASKS, row, taskValues(String(row)), txnId(`create-${row}`));
      quiesce(world);
      for (const [index, row] of rows.entries()) {
        if (at(doomed, index)) owner.delete(TASKS, row, txnId(`delete-${row}`));
      }
      quiesce(world);

      const cursors = world.devices.map((device) => device.client.lastServerSeq);
      const before = world.devices.map((device) => clientState(device.client));
      world.now += TOMBSTONE_FLOOR_MS + DAY_MS;
      world.server.pruneTombstones(world.scopeId);
      quiesce(world);

      const floor = world.server.scopes.get(world.scopeId)?.tombstoneFloorSeq ?? 0;
      assert.equal(
        cursors.every((cursor) => cursor >= floor),
        true,
        "a device was below the floor",
      );
      assert.deepEqual(
        world.devices.map((device) => clientState(device.client)),
        before,
      );
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.7 a client one schema version behind cannot alter a newer field", () => {
  const newerSchema = defineSchema(
    {
      tasks: S.collection({
        title: S.string(),
        status: S.string(),
        notes: S.string({ merge: "diff3" }),
        rank: S.string({ merge: "fracIndex" }),
        priority: S.number({ nullable: true }),
      }),
    },
    2,
  );
  const priority = fieldName("priority");

  fc.assert(
    fc.property(fc.integer({ min: 1, max: 9_000 }), fc.string({ minLength: 1, maxLength: 10 }), (value, staleTitle) => {
      const world = createWorld(1);
      const stale = deviceAt(world, 0).client;
      const upgraded = new WeftClient(world.scopeId, stale.deviceId, newerSchema, () => world.now);
      const row = rowId("versioned");
      upgraded.create(TASKS, row, { [TITLE]: "upgraded", [priority]: value }, txnId("upgraded"));
      upgraded.sync(world.server, schemaHash(newerSchema));

      stale.applyPull(world.server.pull(world.scopeId, 0));
      stale.update(TASKS, row, { [TITLE]: staleTitle }, txnId("stale-write"));
      const outbox = JSON.stringify(stale.outbox);
      stale.sync(world.server, propertySchemaHash);

      const stored = world.server
        .snapshot(world.scopeId)
        .fields.find((field) => field.rowId === row && field.field === priority);
      assert.equal(stored?.value, value, "a stale client altered a newer field");
      assert.equal(JSON.stringify(stale.outbox), outbox, "a blocked session moved the outbox");
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

/**
 * A valid local history from one device, captured as one op array per transaction. Only
 * `lww` fields take part: a `diff3` field makes acceptance depend on arrival order by
 * design (§5.4), which is the opposite of what commutativity asks about.
 */
function transactionsFor(history: readonly Mutation[]): {
  readonly creates: readonly (readonly WeftOp[])[];
  readonly rest: readonly (readonly WeftOp[])[];
} {
  const world = createWorld(1);
  const client = deviceAt(world, 0).client;
  const creates: WeftOp[][] = [];
  const rest: WeftOp[][] = [];
  let cursor = 0;
  const take = (): WeftOp[] => {
    const ops = client.outbox.slice(cursor).map((op) => ({ ...op }));
    cursor = client.outbox.length;
    return ops;
  };

  for (const row of MODEL_ROWS) {
    world.now += 1;
    client.create(TASKS, row, taskValues(String(row)), txnId(`create-${row}`));
    creates.push(take());
  }
  for (const [index, mutation] of history.entries()) {
    world.now += 1;
    const row = at(MODEL_ROWS, mutation.row);
    const state = localState(client, TASKS, row);
    if (mutation.kind === "update" && state === "live") {
      client.update(TASKS, row, { [mutation.onTitle ? TITLE : STATUS]: mutation.value }, txnId(`update-${index}`));
    } else if (mutation.kind === "delete" && state === "live") {
      client.delete(TASKS, row, txnId(`delete-${index}`));
    } else if (mutation.kind === "restore" && state === "tombstoned") {
      client.restore(TASKS, row, { [TITLE]: mutation.value }, txnId(`restore-${index}`));
    }
    const ops = take();
    if (ops.length > 0) rest.push(ops);
  }
  return { creates, rest };
}

function deliver(
  batches: { readonly creates: readonly (readonly WeftOp[])[]; readonly rest: readonly (readonly WeftOp[])[] },
  keys: readonly number[],
  options: { readonly duplicate?: boolean } = {},
): PropertyWorld {
  const world = createWorld(0);
  // Creating transactions land first: a `set` ahead of its `create` is `row_absent` by
  // design (§5.9), not a delivery order the server is expected to absorb.
  for (const batch of permute(batches.creates, keys)) push(world.server, batch, keys, options.duplicate ?? false);
  for (const batch of permute(batches.rest, keys.slice(8))) push(world.server, batch, keys, options.duplicate ?? false);
  return world;
}

function push(server: WeftServer, batch: readonly WeftOp[], keys: readonly number[], duplicate: boolean): void {
  server.push(
    propertyScope,
    permute(batch, keys).map((op) => ({ ...op })),
  );
  if (duplicate)
    server.push(
      propertyScope,
      batch.map((op) => ({ ...op })),
    );
}

/** A generated permutation: sort by the generated keys, ties broken by original position. */
function permute<T>(items: readonly T[], keys: readonly number[]): readonly T[] {
  return items
    .map((item, index) => ({ item, index, key: keys[index % keys.length] ?? index }))
    .sort((left, right) => left.key - right.key || left.index - right.index)
    .map((entry) => entry.item);
}

function freshClient(world: PropertyWorld): WeftClient {
  return new WeftClient(world.scopeId, deviceAt(world, 0).client.deviceId, propertySchema, () => world.now);
}

/** The same local writes on top of either sync path, standing in for an undrained outbox. */
function replayOutbox(client: WeftClient, value: string): void {
  const target = [...client.rows.keys()].filter((key) => key.startsWith(`${TASKS}\0`)).sort()[0];
  if (target === undefined) return;
  client.update(TASKS, target.slice(`${TASKS}\0`.length) as RowId, { [TITLE]: value }, txnId("replayed"));
}

function clientState(client: WeftClient): readonly string[] {
  return [
    ...[...client.rows.entries()].map(
      ([key, row]) =>
        `row:${key}:${JSON.stringify([...row.fields.entries()].sort(([left], [right]) => left.localeCompare(right)))}`,
    ),
    ...[...client.tombstones.keys()].map((key) => `tombstone:${key}`),
  ].sort();
}

function taskValues(label: string): Record<string, string> {
  return {
    [TITLE]: `title-${label}`,
    [STATUS]: "open",
  };
}
