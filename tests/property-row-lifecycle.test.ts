// DESIGN.md §9 "Application" and "Retention", the row-lifecycle rules that need a
// specific arrangement. §9.20, §9.21, §9.23f, §9.24 and §9.25 are checked continuously by
// the world model instead (property-invariants.ts).
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import {
  deviceId,
  encodeHlc,
  fieldName,
  rankBetween,
  rowId,
  txnId,
  wireText,
  type FieldName,
  type HlcString,
  type RankString,
  type RowId,
  type WeftOp,
  type WireValue,
} from "weftdb/core";
import {
  inProcessTransport,
  type MaterializedRow,
  planRetentionDeletes,
  visibleChildren,
  WeftClient,
} from "weftdb/client";
import { WeftServer } from "weftdb/server";
import {
  AMOUNT,
  AUTO_DELETE_DAYS,
  BASE_NOTES,
  BASE_TIME,
  CONSUMED_AT,
  createWorld,
  DAY_MS,
  derivedTotal,
  deviceAt,
  EVENTS,
  INVOICE_ID,
  INVOICES,
  isOverridden,
  LINE_ITEMS,
  localKey,
  localState,
  NOTES,
  OVERRIDE,
  propertySchema,
  PROPERTY_RUNS,
  propertySchemaHash,
  propertyScope,
  quiesce,
  RANK,
  runWorld,
  SCENARIO_RUNS,
  STATUS,
  TASKS,
  TITLE,
  TOMBSTONE_FLOOR_MS,
  worldCommands,
  type PropertyWorld,
} from "./property-model.ts";

const overrideArb = fc.option(fc.integer({ min: 0, max: 900 }));
const amountsArb = fc.array(fc.integer({ min: 0, max: 400 }), { maxLength: 6 });

test("§9.App14 a child row always carries its parent's scope", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 4 }), async (childCounts) => {
      const world = createWorld(2);
      const owner = deviceAt(world, 0).client;
      for (const [index, children] of childCounts.entries()) {
        const invoice = rowId(`invoice-${index}`);
        await owner.create(INVOICES, invoice, { [OVERRIDE]: null }, txnId(`invoice-${index}`));
        for (let child = 0; child < children; child += 1) {
          await owner.create(
            LINE_ITEMS,
            rowId(`line-${index}-${child}`),
            { [INVOICE_ID]: invoice, [AMOUNT]: 100 },
            txnId(`line-${index}-${child}`),
          );
        }
      }
      await quiesce(world);

      for (const device of world.devices) {
        for (const child of device.client.listRows(LINE_ITEMS)) {
          const parent = device.client.getRow(INVOICES, rowId(wireText(child.fields.get(INVOICE_ID) ?? "")));
          assert.equal(child.fields.get(fieldName("scope_id")), world.scopeId);
          if (parent !== undefined) {
            assert.equal(parent.fields.get(fieldName("scope_id")), child.fields.get(fieldName("scope_id")));
          }
        }
      }
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.App15 no child row is visible under a tombstoned parent", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }), async (doomed) => {
      const world = createWorld(2);
      const owner = deviceAt(world, 0).client;
      for (const [index] of doomed.entries()) {
        const invoice = rowId(`invoice-${index}`);
        await owner.create(INVOICES, invoice, { [OVERRIDE]: null }, txnId(`invoice-${index}`));
        await owner.create(
          LINE_ITEMS,
          rowId(`line-${index}`),
          { [INVOICE_ID]: invoice, [AMOUNT]: 100 },
          txnId(`line-${index}`),
        );
      }
      await quiesce(world);
      for (const [index, remove] of doomed.entries()) {
        if (remove) await owner.delete(INVOICES, rowId(`invoice-${index}`), txnId(`delete-${index}`));
      }
      await quiesce(world);

      for (const device of world.devices) {
        const visible = visibleChildren(
          device.client.listRows(INVOICES),
          device.client.listRows(LINE_ITEMS),
          INVOICE_ID,
        );
        for (const child of visible) {
          const parent = rowId(wireText(child.fields.get(INVOICE_ID) ?? ""));
          assert.equal(localState(device.client, INVOICES, parent), "live", `${child.id} outlived its parent`);
        }
        assert.equal(
          visible.length,
          doomed.filter((remove) => !remove).length,
          "orphan filtering dropped a live child",
        );
      }
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.16 overriddenness is exactly total_override IS NOT NULL", async () => {
  await fc.assert(
    fc.asyncProperty(overrideArb, async (override) => {
      const invoice = materialized(rowId("invoice"), [[OVERRIDE, override]]);
      assert.equal(isOverridden(invoice, OVERRIDE), override !== null);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.17 the derived total is the override, otherwise the sum of visible children", async () => {
  await fc.assert(
    fc.asyncProperty(overrideArb, amountsArb, async (override, amounts) => {
      const invoiceId = rowId("invoice");
      const invoice = materialized(invoiceId, [[OVERRIDE, override]]);
      const children = amounts.map((value, index) =>
        materialized(rowId(`line-${index}`), [
          [INVOICE_ID, invoiceId],
          [AMOUNT, value],
        ]),
      );
      const orphan = materialized(rowId("orphan"), [
        [INVOICE_ID, rowId("missing")],
        [AMOUNT, 999],
      ]);
      const visible = visibleChildren([invoice], [...children, orphan], INVOICE_ID);
      const summed = amounts.reduce((total, value) => total + value, 0);
      assert.equal(derivedTotal(invoice, visible, OVERRIDE, AMOUNT), override ?? summed);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.18 event-log rows are removed by no path", async () => {
  await fc.assert(
    fc.asyncProperty(worldCommands(60), async (commands) => {
      const world = await runWorld(commands);
      await quiesce(world);
      const events = world.server.snapshot(world.scopeId).rows.filter((row) => row.tableName === EVENTS);
      fc.pre(events.length > 0);

      world.now += TOMBSTONE_FLOOR_MS * 2;
      world.server.pruneTombstones(world.scopeId);
      assert.deepEqual(
        world.server
          .snapshot(world.scopeId)
          .rows.filter((row) => row.tableName === EVENTS)
          .map((row) => row.rowId)
          .sort(),
        events.map((row) => row.rowId).sort(),
        "prune removed event rows",
      );

      const client = deviceAt(world, 0).client;
      const event = events[0]?.rowId;
      if (event !== undefined) {
        await assert.rejects(() => client.delete(EVENTS, event, txnId("delete-event")), /append-class/u);
      }
      assert.equal(
        planRetentionDeletes(client, propertySchema, { defaultAutoDeleteDays: 1 }, world.now).some(
          (entry) => entry.tableName === EVENTS,
        ),
        false,
        "retention planned an event-log delete",
      );
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.19 ranks are a total order under plain lexicographic comparison", () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 2 })), { minLength: 2, maxLength: 60 }),
      (insertions) => {
        const devices = [deviceId("d0"), deviceId("d1"), deviceId("d2")] as const;
        const ranks: RankString[] = [];
        for (const [offset, device] of insertions) {
          const position = ranks.length === 0 ? 0 : offset % (ranks.length + 1);
          const left = position === 0 ? null : (ranks[position - 1] ?? null);
          const right = position === ranks.length ? null : (ranks[position] ?? null);
          const rank = rankBetween(left, right, devices[device] ?? devices[0]);
          if (left !== null) assert.equal(left < rank, true, `${rank} did not sort after ${left}`);
          if (right !== null) assert.equal(rank < right, true, `${rank} did not sort before ${right}`);
          ranks.splice(position, 0, rank);
        }
        assert.equal(new Set(ranks).size, ranks.length, "two ranks collided");
        assert.deepEqual([...ranks].sort(), ranks, "insertion order and sort order disagree");
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.22 a dirty row deleted remotely is quarantined, never dropped", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 10 }), async (edit) => {
      const world = createWorld(2);
      const owner = deviceAt(world, 0).client;
      const editor = deviceAt(world, 1).client;
      const row = rowId("contested");
      await owner.create(TASKS, row, taskValues("contested"), txnId("create"));
      await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
      await editor.syncWith(inProcessTransport(world.server), propertySchemaHash);

      world.now += 1;
      await editor.update(TASKS, row, { [TITLE]: edit }, txnId("unsynced"));
      await owner.delete(TASKS, row, txnId("remote-delete"));
      await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
      await editor.applyPull(world.server.pull(world.scopeId, editor.lastServerSeq));

      assert.equal(
        editor.quarantine.some((op) => op.txnId === txnId("unsynced")),
        true,
        "the unsynced edit was dropped",
      );
      assert.equal(editor.isRowDirty(TASKS, row), true, "a diverged row is not dirty");
      assert.equal(localState(editor, TASKS, row), "tombstoned", "a remotely deleted dirty row stayed visible as live");
      assert.equal(editor.getRow(TASKS, row), undefined, "a remotely deleted dirty row stayed query-visible");
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.23 an append row accepts neither set nor delete from any client", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 10 }), async (status) => {
      const world = createWorld(2);
      const author = deviceAt(world, 0).client;
      const other = deviceAt(world, 1).client;
      const event = rowId("event");
      await author.append(
        EVENTS,
        event,
        { [fieldName("task_id")]: "task", [fieldName("status")]: "open" },
        txnId("append"),
      );
      await author.syncWith(inProcessTransport(world.server), propertySchemaHash);
      await other.syncWith(inProcessTransport(world.server), propertySchemaHash);

      await assert.rejects(() => other.delete(EVENTS, event, txnId("delete")), /append-class/u);
      const rawDelete = world.server.push(world.scopeId, [
        {
          scopeId: world.scopeId,
          tableName: EVENTS,
          rowId: event,
          kind: "delete",
          hlc: stamp(world.now, 1),
          txnId: txnId("raw-delete"),
        },
      ]);
      assert.equal(rawDelete.ok, false, "a raw delete reached an append row");

      // A client refuses to queue the edit at all, for the same reason it refuses the delete.
      // The work could only ever be rejected, and quarantining it would ask a person to decide
      // about something that was never going to land.
      await assert.rejects(
        () => other.update(EVENTS, event, { [fieldName("status")]: status }, txnId("late-set")),
        /append-class/u,
      );

      // The rule is still the server's to enforce, against a client that does not know it.
      const rawSet = world.server.push(world.scopeId, [
        {
          scopeId: world.scopeId,
          tableName: EVENTS,
          rowId: event,
          kind: "set",
          field: fieldName("status"),
          value: status,
          hlc: stamp(world.now, 2),
          txnId: txnId("raw-set"),
        },
      ]);
      assert.equal(rawSet.ok, false, "a raw set reached an append row");
      if (!rawSet.ok) assert.equal(rawSet.rejection.reason, "append_class_violation");
      assert.equal(serverField(world, event, fieldName("status")), "open", "the append row was mutated");
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.23a no sequence of field writes resurrects a tombstoned row", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.tuple(fc.boolean(), fc.string({ minLength: 1, maxLength: 8 })), { minLength: 1, maxLength: 8 }),
      async (writes) => {
        const world = createWorld(1);
        const client = deviceAt(world, 0).client;
        const row = rowId("buried");
        await client.create(TASKS, row, taskValues("buried"), txnId("create"));
        await client.syncWith(inProcessTransport(world.server), propertySchemaHash);
        await client.delete(TASKS, row, txnId("delete"));
        await client.syncWith(inProcessTransport(world.server), propertySchemaHash);
        const deletedHlc = serverRow(world, row)?.deletedHlc;

        for (const [index, [onTitle, value]] of writes.entries()) {
          world.now += 1;
          world.server.push(world.scopeId, [
            {
              scopeId: world.scopeId,
              tableName: TASKS,
              rowId: row,
              kind: "set",
              field: onTitle ? TITLE : STATUS,
              value,
              hlc: stamp(world.now, index),
              txnId: txnId(`late-${index}`),
            },
          ]);
          assert.equal(serverRow(world, row)?.deletedHlc, deletedHlc, "a field write moved the liveness register");
        }
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.23b delete and restore converge by HLC under any interleaving", () => {
  fc.assert(
    fc.property(
      fc.array(fc.boolean(), { minLength: 2, maxLength: 6 }),
      fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 8, maxLength: 8 }),
      fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 8, maxLength: 8 }),
      (kinds, leftKeys, rightKeys) => {
        const row = rowId("register");
        const registerOps = kinds.map((isDelete, index) => ({
          kind: isDelete ? ("delete" as const) : ("restore" as const),
          wallMs: BASE_TIME + (index + 1) * 1_000,
          index,
        }));
        const winner = registerOps.reduce((left, right) => (right.wallMs > left.wallMs ? right : left));

        const outcomes = [leftKeys, rightKeys, leftKeys.slice().reverse()].map((keys) => {
          const server = new WeftServer(() => BASE_TIME + 60 * 60 * 1000);
          const creation = txnId("create");
          server.push(propertyScope, [
            {
              scopeId: propertyScope,
              tableName: TASKS,
              rowId: row,
              kind: "create",
              hlc: stamp(BASE_TIME, 0),
              txnId: creation,
            },
            {
              scopeId: propertyScope,
              tableName: TASKS,
              rowId: row,
              kind: "set",
              field: TITLE,
              value: "seed",
              hlc: stamp(BASE_TIME, 1),
              txnId: creation,
            },
          ]);
          for (const op of permute(registerOps, keys)) {
            server.push(propertyScope, [
              {
                scopeId: propertyScope,
                tableName: TASKS,
                rowId: row,
                kind: op.kind,
                hlc: stamp(op.wallMs, op.index),
                txnId: txnId(`register-${op.index}`),
              },
            ]);
          }
          return server.snapshot(propertyScope).rows.find((record) => record.rowId === row)?.deletedHlc === null
            ? "live"
            : "deleted";
        });

        assert.deepEqual(
          [...new Set(outcomes)],
          [winner.kind === "delete" ? "deleted" : "live"],
          "the register did not converge",
        );
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.23c a restored row comes back with every field it had at deletion", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 10 }), async (title) => {
      const world = createWorld(2);
      const owner = deviceAt(world, 0).client;
      const watcher = deviceAt(world, 1).client;
      const row = rowId("revived");
      await owner.create(TASKS, row, taskValues(title), txnId("create"));
      await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
      await watcher.syncWith(inProcessTransport(world.server), propertySchemaHash);
      const atDeletion = fieldsOf(watcher, row);

      await owner.delete(TASKS, row, txnId("delete"));
      await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
      await watcher.syncWith(inProcessTransport(world.server), propertySchemaHash);
      assert.equal(localState(watcher, TASKS, row), "tombstoned", "the delete never reached the watcher");

      world.now += 1;
      await owner.restore(TASKS, row, {}, txnId("restore"));
      await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
      await watcher.syncWith(inProcessTransport(world.server), propertySchemaHash);

      assert.deepEqual(fieldsOf(watcher, row), atDeletion, "an incremental pull returned a partial row");
      const fresh = new WeftClient(world.scopeId, owner.deviceId, propertySchema, () => world.now);
      await fresh.applySnapshot(world.server.snapshot(world.scopeId));
      assert.deepEqual(fieldsOf(fresh, row), atDeletion, "a snapshot returned a partial row");
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.23c restoring with field values sends those values with the restore", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.string({ minLength: 1, maxLength: 10 }),
      async (before, after) => {
        fc.pre(before !== after);
        const world = createWorld(2);
        const owner = deviceAt(world, 0).client;
        const watcher = deviceAt(world, 1).client;
        const row = rowId("revived-with-values");
        await owner.create(TASKS, row, taskValues(before), txnId("create"));
        await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
        await watcher.syncWith(inProcessTransport(world.server), propertySchemaHash);

        await owner.delete(TASKS, row, txnId("delete"));
        await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
        await watcher.syncWith(inProcessTransport(world.server), propertySchemaHash);
        assert.equal(localState(watcher, TASKS, row), "tombstoned", "the delete never reached the watcher");

        await watcher.restore(TASKS, row, { [TITLE]: after, [STATUS]: "restored" }, txnId("restore"));
        await watcher.syncWith(inProcessTransport(world.server), propertySchemaHash);
        await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);

        for (const device of world.devices) {
          assert.equal(
            device.client.getRow(TASKS, row)?.fields.get(TITLE),
            after,
            `${device.client.deviceId} did not receive the restored title`,
          );
          assert.equal(
            device.client.getRow(TASKS, row)?.fields.get(STATUS),
            "restored",
            `${device.client.deviceId} did not receive the restored status`,
          );
        }
      },
    ),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.23c a locally restored row exposes its base fields before sync", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 10 }), async (title) => {
      const world = createWorld(2);
      const owner = deviceAt(world, 0).client;
      const restorer = deviceAt(world, 1).client;
      const row = rowId("locally-restored");
      await owner.create(TASKS, row, taskValues("before"), txnId("create"));
      await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
      await restorer.syncWith(inProcessTransport(world.server), propertySchemaHash);

      await owner.delete(TASKS, row, txnId("delete"));
      await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
      await restorer.syncWith(inProcessTransport(world.server), propertySchemaHash);

      await restorer.restore(TASKS, row, { [TITLE]: title }, txnId("restore"));
      const restored = restorer.getRow(TASKS, row);
      assert.notEqual(restored, undefined, "restore did not materialize a local row");
      assert.equal(restored?.fields.get(fieldName("id")), row, "restored row did not expose id");
      assert.equal(restored?.fields.get(fieldName("scope_id")), world.scopeId, "restored row did not expose scope_id");
      assert.equal(typeof restored?.fields.get(fieldName("created")), "string", "restored row did not expose created");
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.23c restoring a diff3 field value sends that value with the restore", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.string({ minLength: 1, maxLength: 20 }),
      async (before, after) => {
        fc.pre(before !== after);
        const world = createWorld(2);
        const owner = deviceAt(world, 0).client;
        const watcher = deviceAt(world, 1).client;
        const row = rowId("revived-diff3");
        await owner.create(TASKS, row, taskValues(before), txnId("create"));
        await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
        await watcher.syncWith(inProcessTransport(world.server), propertySchemaHash);

        await owner.delete(TASKS, row, txnId("delete"));
        await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
        await watcher.syncWith(inProcessTransport(world.server), propertySchemaHash);

        await watcher.restore(TASKS, row, { [NOTES]: after }, txnId("restore"));
        await watcher.syncWith(inProcessTransport(world.server), propertySchemaHash);
        await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);

        assert.equal(
          owner.getRow(TASKS, row)?.fields.get(NOTES),
          after,
          "the restored diff3 value did not reach another device",
        );
        assert.equal(serverField(world, row, NOTES), after, "the restored diff3 value did not reach the server");
      },
    ),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.23c a restore does not reset a field: its opening writes are resolved by HLC like any other", async () => {
  // This pins a specific failure. A restore's opening `set` is accepted, the pushing device is
  // told the push succeeded, and the field still ends on somebody else's value. That looks like
  // silent loss, and §5.1.acked read it as one for three separate generated histories, though it
  // is what §5.9 asks for. A restore moves the liveness register and nothing else; "a delete
  // does not remove fields", so the row it revives is the same row with the same field history,
  // which is the only way §9.23c's "every field it had at deletion, not a subset" can hold.
  //
  // An alternative design, where a restore's own writes win outright because the row is "new
  // again," has no stamp to decide by, so the answer would depend on which transaction reached
  // the relay first. §9.1 requires any delivery order of the same op set to give byte-identical
  // state, so both orders are pushed here for exactly that reason.
  const row = rowId("revived-against-concurrent");
  const restorer = deviceId("device-restorer");
  const writer = deviceId("device-writer");
  const deleteAt = BASE_TIME + 1_000;
  // One wall millisecond holds every op that competes, so the comparison lands on the counter
  // and the arrangement does not depend on how fast the clocks happen to run.
  const contested = BASE_TIME + 2_000;
  const restoreTxn = txnId("restore-txn");

  const restoreOps: readonly WeftOp[] = [
    {
      scopeId: propertyScope,
      tableName: TASKS,
      rowId: row,
      kind: "restore",
      hlc: encodeHlc({ wallMs: contested, counter: 0, deviceId: restorer }),
      txnId: restoreTxn,
    },
    {
      scopeId: propertyScope,
      tableName: TASKS,
      rowId: row,
      kind: "set",
      field: TITLE,
      value: "title-restored",
      hlc: encodeHlc({ wallMs: contested, counter: 1, deviceId: restorer }),
      txnId: restoreTxn,
    },
  ];
  // Strictly above the restore's write, and concurrent with it, because this device never saw
  // the delete or the restore, so it had nothing to stamp itself after.
  const concurrentOps: readonly WeftOp[] = [
    {
      scopeId: propertyScope,
      tableName: TASKS,
      rowId: row,
      kind: "set",
      field: TITLE,
      value: "title-concurrent",
      hlc: encodeHlc({ wallMs: contested, counter: 2, deviceId: writer }),
      txnId: txnId("concurrent-txn"),
    },
  ];

  for (const [first, second] of [
    [restoreOps, concurrentOps],
    [concurrentOps, restoreOps],
  ] as const) {
    const server = new WeftServer(() => contested + 60 * 60 * 1000);
    const creation = txnId("create-txn");
    server.push(propertyScope, [
      {
        scopeId: propertyScope,
        tableName: TASKS,
        rowId: row,
        kind: "create",
        hlc: encodeHlc({ wallMs: BASE_TIME, counter: 0, deviceId: restorer }),
        txnId: creation,
      },
      {
        scopeId: propertyScope,
        tableName: TASKS,
        rowId: row,
        kind: "set",
        field: TITLE,
        value: "title-original",
        hlc: encodeHlc({ wallMs: BASE_TIME, counter: 1, deviceId: restorer }),
        txnId: creation,
      },
    ]);
    server.push(propertyScope, [
      {
        scopeId: propertyScope,
        tableName: TASKS,
        rowId: row,
        kind: "delete",
        hlc: encodeHlc({ wallMs: deleteAt, counter: 0, deviceId: restorer }),
        txnId: txnId("delete-txn"),
      },
    ]);

    // Both are accepted. Acceptance is about validity, separate from winning the field-wise
    // comparison the write then goes through (§5.3 step 6). A losing `set` is still an accepted
    // one, not a rejected one, and reporting it as rejected is what would leave a client
    // retrying forever.
    for (const batch of [first, second]) {
      assert.equal(server.push(propertyScope, [...batch]).ok, true, "a valid transaction was rejected");
    }

    const snapshot = server.snapshot(propertyScope);
    assert.equal(
      snapshot.rows.find((record) => record.rowId === row)?.deletedHlc,
      null,
      "the restore did not win the liveness register",
    );
    assert.equal(
      snapshot.fields.find((record) => record.rowId === row && record.field === TITLE)?.value,
      "title-concurrent",
      "the restore reset a field it is only supposed to leave alone",
    );
  }
});

test("§9.23c a restore's opening write still wins when its stamp is the highest", async () => {
  // The other half of the rule above, so narrowing it cannot be mistaken for dropping it. A
  // restore's `set` is an ordinary write, which means it takes the field whenever it is the
  // later one. Losing to *nothing* would be the real silent loss.
  const row = rowId("revived-uncontested");
  const device = deviceId("device-restorer");
  const server = new WeftServer(() => BASE_TIME + 60 * 60 * 1000);
  const creation = txnId("create-txn");
  server.push(propertyScope, [
    {
      scopeId: propertyScope,
      tableName: TASKS,
      rowId: row,
      kind: "create",
      hlc: encodeHlc({ wallMs: BASE_TIME, counter: 0, deviceId: device }),
      txnId: creation,
    },
    {
      scopeId: propertyScope,
      tableName: TASKS,
      rowId: row,
      kind: "set",
      field: TITLE,
      value: "title-original",
      hlc: encodeHlc({ wallMs: BASE_TIME, counter: 1, deviceId: device }),
      txnId: creation,
    },
  ]);
  server.push(propertyScope, [
    {
      scopeId: propertyScope,
      tableName: TASKS,
      rowId: row,
      kind: "delete",
      hlc: encodeHlc({ wallMs: BASE_TIME + 1_000, counter: 0, deviceId: device }),
      txnId: txnId("delete-txn"),
    },
  ]);
  const restoreTxn = txnId("restore-txn");
  server.push(propertyScope, [
    {
      scopeId: propertyScope,
      tableName: TASKS,
      rowId: row,
      kind: "restore",
      hlc: encodeHlc({ wallMs: BASE_TIME + 2_000, counter: 0, deviceId: device }),
      txnId: restoreTxn,
    },
    {
      scopeId: propertyScope,
      tableName: TASKS,
      rowId: row,
      kind: "set",
      field: TITLE,
      value: "title-restored",
      hlc: encodeHlc({ wallMs: BASE_TIME + 2_000, counter: 1, deviceId: device }),
      txnId: restoreTxn,
    },
  ]);

  const snapshot = server.snapshot(propertyScope);
  assert.equal(
    snapshot.fields.find((record) => record.rowId === row && record.field === TITLE)?.value,
    "title-restored",
    "a restore's own write lost the field to a stamp below it",
  );
});

test("§9.23d a set against an absent row is rejected, and only a create brings the id back", async () => {
  type AbsentOpKind = Extract<WeftOp["kind"], "set" | "delete" | "restore">;
  await fc.assert(
    fc.asyncProperty(fc.constantFrom<AbsentOpKind[]>("set", "delete", "restore"), async (kind) => {
      const world = createWorld(1);
      const client = deviceAt(world, 0).client;
      const row = rowId("purged");
      await client.create(TASKS, row, taskValues("purged"), txnId("create"));
      await client.syncWith(inProcessTransport(world.server), propertySchemaHash);
      await client.delete(TASKS, row, txnId("delete"));
      await client.syncWith(inProcessTransport(world.server), propertySchemaHash);
      world.now += TOMBSTONE_FLOOR_MS + DAY_MS;
      world.server.pruneTombstones(world.scopeId);

      const op: WeftOp =
        kind === "set"
          ? {
              scopeId: world.scopeId,
              tableName: TASKS,
              rowId: row,
              kind,
              field: TITLE,
              value: "ghost",
              hlc: stamp(world.now, 1),
              txnId: txnId("ghost"),
            }
          : {
              scopeId: world.scopeId,
              tableName: TASKS,
              rowId: row,
              kind,
              hlc: stamp(world.now, 1),
              txnId: txnId("ghost"),
            };
      const rejected = world.server.push(world.scopeId, [op]);
      assert.equal(rejected.ok, false, `${kind} recreated a purged row`);
      assert.equal(rejected.ok ? "" : rejected.rejection.reason, "row_absent");

      const recreate = txnId("recreate");
      const created = world.server.push(world.scopeId, [
        {
          scopeId: world.scopeId,
          tableName: TASKS,
          rowId: row,
          kind: "create",
          hlc: stamp(world.now, 2),
          txnId: recreate,
        },
        {
          scopeId: world.scopeId,
          tableName: TASKS,
          rowId: row,
          kind: "set",
          field: TITLE,
          value: "explicit",
          hlc: stamp(world.now, 3),
          txnId: recreate,
        },
      ]);
      assert.equal(created.ok, true, "an explicit create was refused");
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.23e a tombstoned row keeps its fields until prune takes both", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.integer({ min: 1, max: 60 }),
      async (title, extraDays) => {
        const world = createWorld(1);
        const client = deviceAt(world, 0).client;
        const row = rowId("retained");
        await client.create(TASKS, row, taskValues(title), txnId("create"));
        await client.syncWith(inProcessTransport(world.server), propertySchemaHash);
        const beforeDelete = serverFieldNames(world, row);

        await client.delete(TASKS, row, txnId("delete"));
        await client.syncWith(inProcessTransport(world.server), propertySchemaHash);
        assert.deepEqual(serverFieldNames(world, row), beforeDelete, "delete purged fields");

        world.now += TOMBSTONE_FLOOR_MS + extraDays * DAY_MS;
        world.server.pruneTombstones(world.scopeId);
        assert.deepEqual(serverFieldNames(world, row), [], "prune left orphaned fields");
        assert.equal(serverRow(world, row), undefined, "prune left the row record");
      },
    ),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.23g liveness is never inferred from presence in a snapshot", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 10 }), async (title) => {
      const world = createWorld(2);
      const owner = deviceAt(world, 0).client;
      const row = rowId("presence");
      await owner.create(TASKS, row, taskValues(title), txnId("create"));
      await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
      await owner.delete(TASKS, row, txnId("delete"));
      await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);

      const snapshot = world.server.snapshot(world.scopeId);
      assert.equal(
        snapshot.rows.some((record) => record.rowId === row && record.deletedHlc !== null),
        true,
        "the tombstone left the snapshot",
      );

      const clean = new WeftClient(world.scopeId, owner.deviceId, propertySchema, () => world.now);
      await clean.applySnapshot(snapshot);
      assert.equal(localState(clean, TASKS, row), "tombstoned", "a tombstoned row was applied as live");

      const dirty = deviceAt(world, 1).client;
      await dirty.create(TASKS, rowId("local-only"), taskValues(title), txnId("local-only"));
      await dirty.applySnapshot(snapshot);
      assert.equal(
        dirty.quarantine.some((op) => op.rowId === rowId("local-only")),
        true,
        "a dirty row absent from the snapshot was erased instead of surfaced",
      );
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.R23 a row with no first_synced_at is never a retention candidate", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 100, max: 800 }), async (ageDays) => {
      const world = createWorld(1);
      const client = deviceAt(world, 0).client;
      const row = rowId("unsynced");
      await client.create(
        TASKS,
        row,
        {
          ...taskValues("unsynced"),
          [CONSUMED_AT]: world.now - ageDays * DAY_MS,
          [AUTO_DELETE_DAYS]: 1,
        },
        txnId("create"),
      );

      assert.deepEqual(
        planRetentionDeletes(client, propertySchema, { defaultAutoDeleteDays: 1 }, world.now),
        [],
        "an unsynced row was planned for purge",
      );
      await client.syncWith(inProcessTransport(world.server), propertySchemaHash);
      assert.equal(
        planRetentionDeletes(client, propertySchema, { defaultAutoDeleteDays: 1 }, world.now + 2 * DAY_MS).length,
        1,
        "a synced expired row was not planned",
      );
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.R24 purge is anchored on the later of the anchor field and first_synced_at", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 31, max: 500 }), fc.integer({ min: 1, max: 120 }), async (ageDays, days) => {
      const world = createWorld(1);
      const client = deviceAt(world, 0).client;
      const row = rowId("ancient");
      await client.create(
        TASKS,
        row,
        {
          ...taskValues("ancient"),
          [CONSUMED_AT]: world.now - ageDays * DAY_MS,
          [AUTO_DELETE_DAYS]: days,
        },
        txnId("create"),
      );
      await client.syncWith(inProcessTransport(world.server), propertySchemaHash);
      const firstSyncedAt = client.rows.get(localKey(TASKS, row))?.internals._weft_first_synced_at ?? 0;

      assert.deepEqual(
        planRetentionDeletes(client, propertySchema, {}, firstSyncedAt + days * DAY_MS - 1),
        [],
        "purged before the sync-anchored window closed",
      );
      const [candidate] = planRetentionDeletes(client, propertySchema, {}, firstSyncedAt + days * DAY_MS);
      assert.equal(candidate?.anchorMs, firstSyncedAt, "the anchor ignored first_synced_at");
      assert.equal(candidate?.expiresAt, firstSyncedAt + days * DAY_MS, "the expiry ignored the anchor");
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.R25b first_synced_at is server-authoritative and identical per row in a transaction", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 10 }), async (title) => {
      const world = createWorld(3);
      const owner = deviceAt(world, 0).client;
      const row = rowId("stamped");
      await owner.create(TASKS, row, taskValues(title), txnId("create"));
      const ack = world.server.push(world.scopeId, [...owner.outbox]);
      assert.equal(ack.ok, true);
      const stamps = ack.ok ? (ack.acks[0]?.firstSeenAtByRow.filter((entry) => entry.rowId === row) ?? []) : [];
      assert.equal(stamps.length, 1, "one row was stamped more than once in a transaction");

      await quiesce(world);
      const perDevice = world.devices.map(
        (device) => device.client.rows.get(localKey(TASKS, row))?.internals._weft_first_synced_at,
      );
      assert.equal(new Set(perDevice).size, 1, "devices disagree on first_synced_at");
      assert.equal(perDevice[0], stamps[0]?.firstSeenAt, "devices did not take the server value");
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.R26 purge uses the converged auto_delete_days", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 90 }),
      fc.integer({ min: 2, max: 90 }),
      async (firstDays, secondDays) => {
        fc.pre(firstDays !== secondDays);
        const world = createWorld(2);
        const first = deviceAt(world, 0).client;
        const second = deviceAt(world, 1).client;
        const row = rowId("policy");
        await first.create(TASKS, row, { ...taskValues("policy"), [AUTO_DELETE_DAYS]: 1 }, txnId("create"));
        await quiesce(world);

        world.now += 1;
        await first.update(TASKS, row, { [AUTO_DELETE_DAYS]: firstDays }, txnId("policy-first"));
        world.now += 1;
        await second.update(TASKS, row, { [AUTO_DELETE_DAYS]: secondDays }, txnId("policy-second"));
        await quiesce(world);

        const converged = world.devices.map((device) => device.client.getRow(TASKS, row)?.fields.get(AUTO_DELETE_DAYS));
        assert.equal(new Set(converged).size, 1, "auto_delete_days did not converge");
        const days = Number(converged[0]);
        for (const device of world.devices) {
          const anchor = device.client.rows.get(localKey(TASKS, row))?.internals._weft_first_synced_at ?? 0;
          assert.deepEqual(
            planRetentionDeletes(device.client, propertySchema, {}, anchor + days * DAY_MS - 1).map(
              (entry) => entry.rowId,
            ),
            [],
            "purged before the converged window closed",
          );
          assert.deepEqual(
            planRetentionDeletes(device.client, propertySchema, {}, anchor + days * DAY_MS).map((entry) => entry.rowId),
            [row],
            "the converged window never expired",
          );
        }
      },
    ),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.R27 a purged row never resurrects through a device returning from below the floor", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 10 }), async (edit) => {
      const world = createWorld(2);
      const owner = deviceAt(world, 0).client;
      const stale = deviceAt(world, 1).client;
      const row = rowId("buried");
      await owner.create(TASKS, row, taskValues("buried"), txnId("create"));
      await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
      await stale.syncWith(inProcessTransport(world.server), propertySchemaHash);

      await owner.delete(TASKS, row, txnId("delete"));
      await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);
      world.now += TOMBSTONE_FLOOR_MS + DAY_MS;
      world.server.pruneTombstones(world.scopeId);
      // Enough traffic to lift the floor above the stale device's cursor.
      await owner.create(TASKS, rowId("fresh"), taskValues("fresh"), txnId("fresh"));
      await owner.syncWith(inProcessTransport(world.server), propertySchemaHash);

      await stale.update(TASKS, row, { [TITLE]: edit }, txnId("offline-edit"));
      await stale.syncWith(inProcessTransport(world.server), propertySchemaHash);

      assert.equal(serverRow(world, row), undefined, "the purged row came back");
      assert.equal(
        stale.quarantine.some((op) => op.txnId === txnId("offline-edit")),
        true,
        "the offline edit was neither applied nor surfaced",
      );
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

function taskValues(label: string): Record<FieldName, WireValue> {
  return {
    [TITLE]: `title-${label}`,
    [STATUS]: "open",
    [NOTES]: BASE_NOTES,
    [RANK]: "a:seed",
    [CONSUMED_AT]: BASE_TIME,
    [AUTO_DELETE_DAYS]: 30,
  };
}

function materialized(id: RowId, fields: readonly (readonly [FieldName, WireValue])[]): MaterializedRow {
  return {
    id,
    scope_id: propertyScope,
    created: "2024-01-01T00:00:00.000Z",
    fields: new Map(fields),
  };
}

function stamp(wallMs: number, counter: number): HlcString {
  return encodeHlc({ wallMs, counter, deviceId: deviceId("lifecycle-device") });
}

function permute<T>(items: readonly T[], keys: readonly number[]): readonly T[] {
  return items
    .map((item, index) => ({ item, index, key: keys[index % keys.length] ?? index }))
    .sort((left, right) => left.key - right.key || left.index - right.index)
    .map((entry) => entry.item);
}

function serverRow(world: PropertyWorld, row: RowId) {
  return world.server.snapshot(world.scopeId).rows.find((record) => record.rowId === row);
}

function serverField(world: PropertyWorld, row: RowId, field: FieldName): WireValue | undefined {
  return world.server.snapshot(world.scopeId).fields.find((record) => record.rowId === row && record.field === field)
    ?.value;
}

function serverFieldNames(world: PropertyWorld, row: RowId): readonly string[] {
  return world.server
    .snapshot(world.scopeId)
    .fields.filter((field) => field.rowId === row)
    .map((field) => String(field.field))
    .sort();
}

function fieldsOf(client: WeftClient, row: RowId): readonly string[] {
  const local = client.rows.get(localKey(TASKS, row));
  return [...(local?.fields.entries() ?? [])].map(([field, value]) => `${field}=${JSON.stringify(value)}`).sort();
}
