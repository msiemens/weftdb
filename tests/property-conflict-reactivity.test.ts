// DESIGN.md §9 "Conflict handling" and "Reactivity", invariants 34 to 42.
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import {
  deviceId,
  diff3,
  fieldName,
  hasConflictMarkers,
  rowId,
  txnId,
  wireText,
  type FieldName,
  type RowId,
  type TableName,
  type WireValue,
} from "weftdb/core";
import {
  reactiveSqlQuery,
  RowIdentityCache,
  SubscriptionEngine,
  WeftClient,
  type LocalRow,
  type MaterializedRow,
  type QueryDelta,
  type QueryKey,
  type QuerySnapshot,
} from "weftdb/client";
import {
  BASE_NOTES,
  BASE_TIME,
  createWorld,
  deviceAt,
  EVENTS,
  localKey,
  NOTES,
  PROPERTY_RUNS,
  propertySchema,
  propertyScope,
  quiesce,
  RANK,
  replaceLine,
  SCENARIO_RUNS,
  STATUS,
  TASKS,
  TITLE,
} from "./property-model.ts";

const lineArb = fc.integer({ min: 0, max: BASE_NOTES.split("\n").length - 1 });
const textArb = fc.string({ minLength: 1, maxLength: 10 }).map((text) => `text ${text}`);

test("§9.34 diff3 on non-overlapping hunks keeps both edits and raises no markers", async () => {
  await fc.assert(
    fc.asyncProperty(lineArb, fc.integer({ min: 0, max: 2 }), textArb, textArb, async (line, offset, local, remote) => {
      const lines = BASE_NOTES.split("\n").length;
      const otherLine = (line + 1 + offset) % lines;
      fc.pre(otherLine !== line && local !== remote);

      const merged = diff3(
        BASE_NOTES,
        replaceLine(BASE_NOTES, line, local),
        replaceLine(BASE_NOTES, otherLine, remote),
      );
      assert.equal(merged.conflicted, false, "a clean merge reported a conflict");
      assert.equal(hasConflictMarkers(merged.value), false, "markers on a clean merge");
      assert.equal(merged.value.includes(local), true, "lost the local edit");
      assert.equal(merged.value.includes(remote), true, "lost the remote edit");
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.35 diff3 on overlapping hunks emits markers holding both sides verbatim", async () => {
  await fc.assert(
    fc.asyncProperty(lineArb, textArb, textArb, async (line, local, remote) => {
      fc.pre(local !== remote);
      const merged = diff3(BASE_NOTES, replaceLine(BASE_NOTES, line, local), replaceLine(BASE_NOTES, line, remote));
      assert.equal(merged.conflicted, true, "an overlapping edit merged silently");
      assert.equal(hasConflictMarkers(merged.value), true, "no markers on an overlapping edit");
      assert.equal(merged.value.includes(local), true, "the local side was not preserved verbatim");
      assert.equal(merged.value.includes(remote), true, "the remote side was not preserved verbatim");
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.36 a marker scan finds every conflicted note on every device", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
      textArb,
      textArb,
      async (conflicts, first, second) => {
        fc.pre(first !== second);
        const world = createWorld(2);
        const firstDevice = deviceAt(world, 0).client;
        const secondDevice = deviceAt(world, 1).client;
        const expected = new Set<RowId>();

        for (const [index, conflicted] of conflicts.entries()) {
          const row = rowId(`note-${index}`);
          await firstDevice.create(TASKS, row, taskValues(`note-${index}`), txnId(`create-${index}`));
          await quiesce(world);
          if (conflicted) {
            world.now += 1;
            await firstDevice.update(
              TASKS,
              row,
              { [NOTES]: replaceLine(BASE_NOTES, 1, first) },
              txnId(`first-${index}`),
            );
            world.now += 1;
            await secondDevice.update(
              TASKS,
              row,
              { [NOTES]: replaceLine(BASE_NOTES, 1, second) },
              txnId(`second-${index}`),
            );
            expected.add(row);
          }
          await quiesce(world);
        }

        for (const device of world.devices) {
          assert.deepEqual(
            scanForConflicts(device.client.listRows(TASKS))
              .map((record) => record.row.id)
              .sort(),
            [...expected].sort(),
            `${device.client.deviceId} scanned differently`,
          );
        }
      },
    ),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.37 removing the markers by hand clears the conflict with no residue", async () => {
  await fc.assert(
    fc.asyncProperty(textArb, textArb, textArb, async (first, second, resolvedLine) => {
      fc.pre(first !== second);
      const world = createWorld(2);
      const firstDevice = deviceAt(world, 0).client;
      const secondDevice = deviceAt(world, 1).client;
      const row = rowId("resolved");
      await firstDevice.create(TASKS, row, taskValues("resolved"), txnId("create"));
      await quiesce(world);

      world.now += 1;
      await firstDevice.update(TASKS, row, { [NOTES]: replaceLine(BASE_NOTES, 2, first) }, txnId("first"));
      world.now += 1;
      await secondDevice.update(TASKS, row, { [NOTES]: replaceLine(BASE_NOTES, 2, second) }, txnId("second"));
      await quiesce(world);
      assert.equal(
        world.devices.some((device) =>
          hasConflictMarkers(wireText(device.client.getRow(TASKS, row)?.fields.get(NOTES) ?? "")),
        ),
        true,
        "there was no conflict to resolve",
      );

      world.now += 1;
      const resolution = replaceLine(BASE_NOTES, 2, resolvedLine);
      await secondDevice.update(TASKS, row, { [NOTES]: resolution }, txnId("resolve"));
      await quiesce(world);

      for (const device of world.devices) {
        assert.equal(
          wireText(device.client.getRow(TASKS, row)?.fields.get(NOTES) ?? ""),
          resolution,
          `${device.client.deviceId} kept a stale value`,
        );
        assert.deepEqual(scanForConflicts(device.client.listRows(TASKS)), [], "a conflict record survived");
        assert.equal(device.client.quarantine.length, 0, "resolving left quarantine residue");
        assert.equal(
          device.client.rows.get(localKey(TASKS, row))?.internals.diff3Base.get(NOTES),
          resolution,
          "the diff3 base was not advanced to the resolved text",
        );
      }
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.38 a change re-runs every registered statement, whatever it reads", async () => {
  const query = reactiveSqlQuery({
    tableName: TASKS,
    query: { sql: `select id from tasks where scope_id = ?`, parameters: [propertyScope] },
  });
  await fc.assert(
    fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }), async (changes) => {
      const engine = new SubscriptionEngine();
      let runs = 0;
      const select = (): readonly RowId[] => {
        runs += 1;
        return [];
      };

      engine.getSqlSnapshot(query, select, new Map());
      // Two reads in one render pass answer from the same run, so a component cannot tear.
      engine.getSqlSnapshot(query, select, new Map());
      assert.equal(runs, 1, "one render pass ran the statement twice");

      for (const [index, changed] of changes.entries()) {
        if (changed) engine.notify();
        engine.getSqlSnapshot(query, select, new Map());
        assert.equal(
          runs,
          1 + changes.slice(0, index + 1).filter(Boolean).length,
          "a statement was not re-run after a change, or was re-run without one",
        );
      }
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.38 a query returns rows from its table, not every row with matching fields", async () => {
  await fc.assert(
    fc.asyncProperty(textArb, textArb, async (taskStatus, eventStatus) => {
      const client = new WeftClient(propertyScope, deviceId("query-device"), propertySchema, () => BASE_TIME);
      const engine = new SubscriptionEngine();
      const task = rowId("task-query-row");
      const event = rowId("event-query-row");
      await client.create(TASKS, task, taskValues("query"), txnId("create-task"));
      await client.update(TASKS, task, { [STATUS]: taskStatus }, txnId("status-task"));
      await client.append(
        EVENTS,
        event,
        { [STATUS]: eventStatus, [fieldName("task_id")]: task },
        txnId("append-event"),
      );

      const snapshot = engine.getSnapshot(
        { tableName: TASKS, fields: [STATUS], orderBy: STATUS },
        client.rows.values(),
      );
      assert.deepEqual(
        snapshot.rows.map((row) => row.id),
        [task],
        "a query included rows from another collection",
      );
      assert.equal(snapshot.rows[0]?.fields.get(STATUS), taskStatus);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.39 an unchanged _weft_rev yields the identical row object", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 25 }), async (revise) => {
      const cache = new RowIdentityCache();
      const row = localRow(rowId("identity"), [[TITLE, "title"]]);
      let previous = cache.materialize(row);

      for (const [index, changed] of revise.entries()) {
        if (!changed) {
          assert.equal(cache.materialize(row), previous, "identity changed without a revision");
          continue;
        }
        row.fields.set(TITLE, `title-${index}`);
        row.internals._weft_rev += 1;
        const next = cache.materialize(row);
        assert.notEqual(next, previous, "a revised row kept its identity");
        previous = next;
      }
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.39 row identity caching does not conflate equal ids from different collections", async () => {
  await fc.assert(
    fc.asyncProperty(textArb, textArb, async (title, status) => {
      const cache = new RowIdentityCache();
      const shared = rowId("shared-row-id");
      const task = localRow(shared, [[TITLE, title]], TASKS);
      const event = localRow(shared, [[STATUS, status]], EVENTS);

      assert.equal(cache.materialize(task).fields.get(TITLE), title);
      const materializedEvent = cache.materialize(event);

      assert.equal(
        materializedEvent.fields.get(STATUS),
        status,
        "a row from another collection was reused from the identity cache",
      );
      assert.equal(
        materializedEvent.fields.has(TITLE),
        false,
        "cached fields from another collection leaked into this row",
      );
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

type RowMutation =
  | { readonly kind: "add" }
  | { readonly kind: "remove"; readonly index: number }
  | { readonly kind: "edit"; readonly index: number; readonly value: string };

test("§9.40 applying a delta to the previous result equals a full re-fetch", async () => {
  const mutationArb: fc.Arbitrary<RowMutation> = fc.oneof(
    fc.record({ kind: fc.constant("add" as const) }),
    fc.record({ kind: fc.constant("remove" as const), index: fc.nat() }),
    fc.record({
      kind: fc.constant("edit" as const),
      index: fc.nat(),
      value: fc.string({ minLength: 1, maxLength: 8 }),
    }),
  );

  await fc.assert(
    fc.asyncProperty(fc.array(mutationArb, { minLength: 1, maxLength: 30 }), async (mutations) => {
      const engine = new SubscriptionEngine();
      const key: QueryKey = { tableName: TASKS, fields: [TITLE], orderBy: TITLE };
      const rows = new Map<RowId, LocalRow>();
      let previous: readonly MaterializedRow[] = engine.getSnapshot(key, rows.values()).rows;

      for (const [step, mutation] of mutations.entries()) {
        apply(rows, mutation, step);
        const snapshot = engine.getSnapshot(key, rows.values());
        assert.deepEqual(
          applyDelta(previous, snapshot).map(describe).sort(),
          snapshot.rows.map(describe).sort(),
          "the delta and a full re-fetch disagree",
        );
        previous = snapshot.rows;
      }
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.41 no notification is emitted mid-transaction", async () => {
  const engine = new SubscriptionEngine();
  const key: QueryKey = { tableName: TASKS, fields: [TITLE] };
  let notifications = 0;
  const unsubscribe = engine.subscribe(key, () => {
    notifications += 1;
  });

  // One transaction. Several mutations, each announcing itself, all before the microtask
  // checkpoint that ends it.
  for (let index = 0; index < 5; index += 1) engine.notify();
  assert.equal(notifications, 0, "a notification escaped mid-transaction");
  await Promise.resolve();
  assert.equal(notifications, 1, "one transaction produced more than one notification");

  engine.notify();
  await Promise.resolve();
  assert.equal(notifications, 2, "a later transaction was swallowed");
  unsubscribe();
});

interface ConflictRecord {
  readonly row: MaterializedRow;
  readonly field: FieldName;
  readonly value: string;
}

/** Conflicts are surfaced by scanning for marker syntax (§6). */
function scanForConflicts(rows: readonly MaterializedRow[]): readonly ConflictRecord[] {
  return rows.flatMap((row) =>
    [...row.fields.entries()].flatMap(([field, value]) =>
      typeof value === "string" && hasConflictMarkers(value) ? [{ row, field, value }] : [],
    ),
  );
}

function taskValues(label: string): Record<FieldName, WireValue> {
  return {
    [TITLE]: `title-${label}`,
    [STATUS]: "open",
    [NOTES]: BASE_NOTES,
    [RANK]: "a:seed",
  };
}

function localRow(id: RowId, fields: readonly (readonly [FieldName, WireValue])[], table: TableName = TASKS): LocalRow {
  return {
    id,
    scopeId: propertyScope,
    tableName: table,
    created: "2024-01-01T00:00:00.000Z",
    fields: new Map(fields),
    internals: {
      _weft_first_synced_at: null,
      _weft_rev: 1,
      _weft_dirty: 0,
      hlc: new Map(),
      diff3Base: new Map(),
    },
  };
}

function apply(rows: Map<RowId, LocalRow>, mutation: RowMutation, step: number): void {
  const ids = [...rows.keys()];
  if (mutation.kind === "add" || ids.length === 0) {
    const id = rowId(`row-${step}`);
    rows.set(id, localRow(id, [[TITLE, `title-${step}`]]));
    return;
  }
  const target = ids[mutation.index % ids.length];
  if (target === undefined) return;
  if (mutation.kind === "remove") {
    rows.delete(target);
    return;
  }
  const row = rows.get(target);
  if (row === undefined) return;
  row.fields.set(TITLE, mutation.value);
  row.internals._weft_rev += 1;
}

/** The wire delta: removed ids drop out, added and changed rows arrive as payloads. */
function applyDelta(previous: readonly MaterializedRow[], snapshot: QuerySnapshot): readonly MaterializedRow[] {
  const delta: QueryDelta = snapshot.delta;
  const removed = new Set(delta.removed);
  const changed = new Map(delta.changed.map((row) => [row.id, row]));
  const added = delta.added
    .map((id) => snapshot.rows.find((row) => row.id === id))
    .filter((row): row is MaterializedRow => row !== undefined);
  return [...previous.filter((row) => !removed.has(row.id)).map((row) => changed.get(row.id) ?? row), ...added];
}

function describe(row: MaterializedRow): string {
  return `${row.id}:${JSON.stringify([...row.fields.entries()].sort(([left], [right]) => left.localeCompare(right)))}`;
}
