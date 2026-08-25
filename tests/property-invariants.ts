// The DESIGN.md §9 invariants that hold continuously, checked after every generated
// command, plus the ones that only hold once a history has settled.
//
// Invariants needing a specific arrangement rather than a generated history live in the
// targeted property files:
//
//   property-convergence          §9.1, §9.2, §9.5, §9.6, §9.7
//   property-rejection            §9.9 to §9.14, plus the §5.3 acceptance oracle
//   property-row-lifecycle        the two application rules numbered 14 and 15 (as §9.App14
//                                 and §9.App15, the numbers being reused by the rejection
//                                 section), §9.16 to §9.19, §9.22, §9.23 and its lettered
//                                 rules, and the retention rules as §9.R23 to §9.R27
//   property-scope-schema         §9.28, §9.29, §9.31, §9.32, §9.33, §9.43 to §9.45
//   property-conflict-reactivity  §9.34 to §9.42
import assert from "node:assert/strict";
import {
  compareHlc,
  parseHlc,
  type FieldName,
  type HlcString,
  type RowId,
  type TableName,
  type WeftOp,
  type WireValue,
} from "weftdb/core";
import { planRetentionDeletes } from "weftdb/client";
import {
  at,
  disagreements,
  EVENTS,
  localKey,
  parseLocalKey,
  pendingOps,
  propertySchema,
  quiesce,
  writeKey,
  type PropertyWorld,
} from "./property-model.ts";

const BASE_FIELD_NAMES = ["id", "scope_id", "created"];

/** What makes two ops the same write, for telling a moved op from a copied one. */
function opIdentity(op: WeftOp): string {
  return [op.txnId, op.tableName, op.rowId, op.kind, op.kind === "set" ? op.field : ""].join("\0");
}

/**
 * Where this device's most recent skew correction sits in its emission history. Stamps emitted
 * before it belong to the baseline the correction replaced.
 */
function lastRestampBefore(device: PropertyWorld["devices"][number], _world: PropertyWorld): number {
  return [...device.restampedAt].reduce((latest, index) => Math.max(latest, index), -1);
}

export interface WorldInvariant {
  readonly id: string;
  readonly title: string;
  check(world: PropertyWorld): void;
}

/** Holds after every single command. */
export const STEP_INVARIANTS: readonly WorldInvariant[] = [
  {
    id: "§9.4",
    title: "emitted HLCs strictly increase per device, except where a skew correction re-stamps",
    check: (world) => {
      for (const device of world.devices) {
        const emitted = device.emittedHlcs;
        const index = emitted.length - 1;
        if (index < 1) continue;
        // Only the tail is new since the previous command. A skew correction deliberately
        // drops the rejected future stamp (§5.5), and that op was never accepted anywhere,
        // so it is the one place the sequence may step backwards.
        if (device.restampedAt.has(index)) continue;
        assert.equal(
          compareHlc(at(emitted, index - 1), at(emitted, index)),
          -1,
          `${device.client.deviceId} emitted a non-increasing HLC`,
        );
      }
    },
  },
  {
    id: "§6.self",
    title: "an accepted write never carries a lower stamp than an accepted write the device emitted earlier",
    check: (world) => {
      // The silent-loss shape: a device emits an edit, the server accepts it, and it still
      // loses the field-wise comparison because its stamp sits under something the device
      // itself wrote earlier — a skew correction pulling the clock back does exactly that.
      // Delivery order is irrelevant here; a reordered batch is resolved by HLC, so the
      // ordering that matters is the one the device emitted in.
      for (const device of world.devices) {
        const emission = new Map<HlcString, number>();
        for (const [index, hlc] of device.emittedHlcs.entries()) if (!emission.has(hlc)) emission.set(hlc, index);
        const accepted = [
          ...new Set(
            world.trace.accepted
              .filter((op) => parseHlc(op.hlc).deviceId === device.client.deviceId)
              .map((op) => op.hlc),
          ),
        ]
          .filter((hlc) => emission.has(hlc))
          .sort((left, right) => (emission.get(left) ?? 0) - (emission.get(right) ?? 0))
          // A skew correction resets this device's baseline: it exists to drop a wall clock the
          // server refused, and work queued before it is legitimately left holding a higher
          // stamp than the correction that followed. What must not happen — and what the
          // correction consults the clock's own record of accepted writes to avoid — is landing
          // under something the server had already taken, so each stretch between corrections is
          // checked on its own.
          .filter((hlc) => (emission.get(hlc) ?? 0) > lastRestampBefore(device, world));

        for (let index = 1; index < accepted.length; index += 1) {
          const earlier = at(accepted, index - 1);
          const later = at(accepted, index);
          assert.equal(
            compareHlc(earlier, later),
            -1,
            `${device.client.deviceId} had a later write accepted under an earlier one's stamp: ` +
              `emitted ${earlier} at #${emission.get(earlier)}, then ${later} at #${emission.get(later)}`,
          );
        }
      }
    },
  },
  {
    id: "§9.8",
    title: "no push carries a field the client did not explicitly write, and row ops carry no values",
    check: (world) => {
      for (const op of world.trace.pushed) {
        if (String(op.txnId).startsWith("injected-")) continue;
        if (op.kind !== "set") {
          assert.equal("field" in op, false, `${op.kind} op carried a field`);
          assert.equal("value" in op, false, `${op.kind} op carried a value`);
          continue;
        }
        assert.equal(
          world.trace.written.has(writeKey(op.tableName, op.rowId, op.field)),
          true,
          `pushed unwritten field ${op.tableName}.${op.field}`,
        );
      }
    },
  },
  {
    id: "§9.8a",
    title: "every create or append shares a transaction with at least one set",
    check: (world) => {
      const byTxn = Map.groupBy(world.trace.pushed, (op) => op.txnId);
      for (const op of world.trace.pushed) {
        if (op.kind !== "create" && op.kind !== "append") continue;
        assert.equal(
          (byTxn.get(op.txnId) ?? []).some((sibling) => sibling.kind === "set" && sibling.rowId === op.rowId),
          true,
          `${op.kind} ${op.rowId} was pushed without its creating fields`,
        );
      }
    },
  },
  {
    id: "§9.8b",
    title: "an append row only ever holds fields from its creating transaction",
    check: (world) => {
      const snapshot = world.server.snapshot(world.scopeId);
      for (const row of snapshot.rows.filter((candidate) => candidate.class === "append")) {
        const txns = new Set(
          snapshot.fields
            .filter((field) => field.tableName === row.tableName && field.rowId === row.rowId)
            .map((field) => field.txnId),
        );
        assert.equal(txns.size <= 1, true, `append row ${row.rowId} holds fields from ${txns.size} transactions`);
      }
    },
  },
  {
    id: "§9.15",
    title: "an acknowledged transaction leaves no outbox entries behind",
    check: (world) => {
      for (const device of world.devices) {
        assert.deepEqual(
          device.client.outbox.filter((op) => world.trace.acked.has(op.txnId)).map((op) => op.txnId),
          [],
          `${device.client.deviceId} holds acknowledged ops in its outbox`,
        );
      }
    },
  },
  {
    id: "§9.18",
    title: "event-log rows are removed by no path",
    check: (world) => {
      for (const row of world.server.snapshot(world.scopeId).rows) {
        if (row.tableName !== EVENTS) continue;
        assert.equal(row.deletedHlc, null, `event row ${row.rowId} was tombstoned`);
      }
      for (const device of world.devices) {
        for (const key of device.client.tombstones.keys()) {
          assert.notEqual(parseLocalKey(key).tableName, EVENTS, `${device.client.deviceId} tombstoned an event row`);
        }
      }
    },
  },
  {
    id: "§9.20",
    title: "client-only columns never reach the wire",
    check: (world) => {
      const wireOps = [
        ...world.trace.pushed,
        ...world.devices.flatMap((device) => [...device.client.outbox, ...device.client.quarantine]),
      ];
      for (const op of wireOps) {
        if (op.kind !== "set") continue;
        assert.equal(String(op.field).startsWith("_weft_"), false, `internal field ${op.field} reached the wire`);
      }
    },
  },
  {
    id: "§9.21",
    title: "a live row and a client tombstone never coexist, and server liveness is the register",
    check: (world) => {
      for (const device of world.devices) {
        for (const key of device.client.rows.keys()) {
          assert.equal(device.client.tombstones.has(key), false, `${key} is live and tombstoned at once`);
        }
      }
      for (const row of world.server.snapshot(world.scopeId).rows) {
        assert.equal(
          row.deletedHlc === null || row.deletedHlc.length > 0,
          true,
          `${row.rowId} has a malformed liveness register`,
        );
      }
    },
  },
  {
    id: "§9.23f",
    title: "no device holds a synced row without a server-stamped first_synced_at",
    check: (world) => {
      const known = new Set(world.server.snapshot(world.scopeId).rows.map((row) => localKey(row.tableName, row.rowId)));
      for (const device of world.devices) {
        // A client waiting to resync has been told its local state is not the server's yet
        // (discarded quarantined work, or a pull it could not apply); it is coherent again
        // once the snapshot lands.
        if (device.client.resyncRequired) continue;
        for (const [key, row] of device.client.rows) {
          const { tableName: table, rowId: id } = parseLocalKey(key);
          // Rows still holding outbox or quarantine entries have not synced: a locally
          // created id the server refused as `row_exists` is diverged, not stamped.
          if (!known.has(key) || pendingOps(device.client, table, id).length > 0) continue;
          assert.notEqual(row.internals._weft_first_synced_at, null, `${key} is synced with no first_synced_at`);
        }
      }
    },
  },
  {
    id: "§9.24",
    title: "base fields never change after insert",
    check: (world) => {
      const snapshot = world.server.snapshot(world.scopeId);
      // A pruned id may be brought back by an explicit `create` (§9.23d), and that is a new
      // insert with its own base fields, so forget rows the server no longer holds.
      const present = new Set(snapshot.rows.map((row) => localKey(row.tableName, row.rowId)));
      for (const key of world.trace.baseFields.keys()) {
        if (!present.has(key.slice(0, key.lastIndexOf("\0")))) world.trace.baseFields.delete(key);
      }
      for (const field of snapshot.fields) {
        if (!BASE_FIELD_NAMES.includes(String(field.field))) continue;
        const key = `${localKey(field.tableName, field.rowId)}\0${field.field}`;
        const seen = world.trace.baseFields.get(key);
        if (seen === undefined) {
          world.trace.baseFields.set(key, field.value);
          continue;
        }
        assert.deepEqual(field.value, seen, `base field ${field.field} of ${field.rowId} changed after insert`);
      }
    },
  },
  {
    id: "§9.25",
    title: "the dirty flag is exactly the outbox-or-quarantine predicate",
    check: (world) => {
      for (const device of world.devices) {
        for (const [key, row] of device.client.rows) {
          const { tableName: table, rowId: id } = parseLocalKey(key);
          assert.equal(
            row.internals._weft_dirty === 1,
            pendingOps(device.client, table, id).length > 0,
            `${device.client.deviceId} disagrees with its own dirty flag for ${key}`,
          );
        }
      }
    },
  },
  {
    id: "§5.8.unsent",
    title: "a field with an unsent write shows what this device wrote, not what the scope says",
    check: (world) => {
      // What a pull carries cannot include a write the relay has not been given, so applying it
      // over an unsent local edit replaces what the person typed with the value they typed over
      // — while their own edit waits its turn in the outbox, or sits in quarantine as a
      // divergence only the person can resolve (§5.5).
      for (const device of [...world.devices, world.neighbour]) {
        for (const [key, row] of device.client.rows) {
          const { tableName: table, rowId: id } = parseLocalKey(key);
          const pending = pendingOps(device.client, table, id);
          // Only while the row's existence is settled. A queued create, delete or restore means
          // the writes behind it belong to a life of the row that the scope may have already
          // replaced — another device creating the same id hands this one a row whose values
          // were never what the queued writes said.
          if (pending.some((op) => op.kind !== "set")) continue;
          // The outbox answers for every field it holds an entry for: it is ordered, and
          // `update` supersedes an earlier unsent write to the same field rather than queueing
          // both, so its last entry for a field is the value that field ends on locally.
          const lastQueued = new Map<FieldName, WeftOp>();
          for (const op of device.client.outbox) {
            if (op.kind === "set" && op.tableName === table && op.rowId === id) lastQueued.set(op.field, op);
          }
          for (const [field, op] of lastQueued) {
            if (op.kind !== "set") continue;
            assert.deepEqual(
              row.fields.get(field),
              op.value,
              `${device.client.deviceId} shows ${key}.${field} as something other than its own unsent write`,
            );
          }
          // Quarantined work is unsent for good, and the value it left in the row is what the
          // person is being asked to decide about — so a pull must not quietly settle it either.
          //
          // This is a different assertion rather than a weaker one, and the difference is not
          // optional: `update` supersedes an unsent write only in the outbox, because a
          // quarantined transaction is the person's to retry or discard whole (§5.5). So a
          // later edit to the same field leaves the quarantined op behind holding the older
          // text, and demanding the row show that text would be demanding it resurrect what the
          // person has since typed over. What the scope says is still excluded: the value has to
          // be one this device produced — its latest write, or the rebase that replaced that
          // write before the op was set aside.
          const quarantinedByField = new Map<FieldName, WireValue[]>();
          for (const op of device.client.quarantine) {
            if (op.kind !== "set" || op.tableName !== table || op.rowId !== id) continue;
            if (lastQueued.has(op.field)) continue;
            quarantinedByField.set(op.field, [...(quarantinedByField.get(op.field) ?? []), op.value]);
          }
          for (const [field, quarantined] of quarantinedByField) {
            const wrote = world.trace.lastWrites.get(`${device.client.deviceId}\0${writeKey(table, id, field)}`);
            const held = JSON.stringify(row.fields.get(field));
            assert.equal(
              [...quarantined, ...(wrote === undefined ? [] : [wrote])].some((value) => JSON.stringify(value) === held),
              true,
              `${device.client.deviceId} shows ${key}.${field} as ${held}, which is neither its quarantined write nor the write it made instead`,
            );
          }
        }
      }
    },
  },
  {
    id: "§8.2.rev",
    title: "a row's revision never runs backwards while the row stays put",
    check: (world) => {
      // Subscriptions treat the revision as the row's identity, so one that decrements can land
      // on a number the row already had — and a subscriber diffing on it sees no change at all.
      for (const device of [...world.devices, world.neighbour]) {
        const seen = new Set<string>();
        for (const [key, row] of device.client.rows) {
          const trackingKey = `${device.client.deviceId}\0${key}`;
          seen.add(trackingKey);
          const highest = world.trace.revHighWater.get(trackingKey);
          if (highest !== undefined) {
            assert.equal(
              row.internals._weft_rev >= highest,
              true,
              `${device.client.deviceId} rolled ${key} back from revision ${highest} to ${row.internals._weft_rev}`,
            );
          }
          world.trace.revHighWater.set(trackingKey, row.internals._weft_rev);
        }
        // A row that has left this device is forgotten: the next life of that id starts over,
        // and holding the old high-water mark against it would be comparing two different rows.
        for (const trackingKey of [...world.trace.revHighWater.keys()]) {
          if (trackingKey.startsWith(`${device.client.deviceId}\0`) && !seen.has(trackingKey)) {
            world.trace.revHighWater.delete(trackingKey);
          }
        }
      }
    },
  },
  {
    id: "§5.5.move",
    title: "quarantining work moves it out of the outbox rather than copying it",
    check: (world) => {
      // An op left in both is pushed again on the next flush, and quarantined work is never
      // retried without the person asking for it.
      for (const device of [...world.devices, world.neighbour]) {
        const queued = new Set(device.client.outbox.map(opIdentity));
        for (const op of device.client.quarantine) {
          assert.equal(
            queued.has(opIdentity(op)),
            false,
            `${device.client.deviceId} holds ${opIdentity(op)} in the outbox and in quarantine at once`,
          );
        }
      }
    },
  },
  {
    id: "§9.43",
    title: "a scope's schema version never decreases",
    check: (world) => {
      const version = world.server.scopes.get(world.scopeId)?.schemaVersion ?? 0;
      const highest = world.trace.highestSchemaVersion;
      assert.equal(version >= highest, true, `the scope rolled back from ${highest} to ${version}`);
      world.trace.highestSchemaVersion = Math.max(highest, version);
    },
  },
  {
    id: "§9.30",
    title: "a client database only ever holds rows from its own scope",
    check: (world) => {
      for (const device of [...world.devices, world.neighbour]) {
        for (const row of device.client.rows.values()) {
          assert.equal(row.scopeId, device.client.scopeId, `a foreign row reached ${device.client.deviceId}`);
        }
        for (const tombstone of device.client.tombstones.values()) {
          assert.equal(
            tombstone.scopeId,
            device.client.scopeId,
            `a foreign tombstone reached ${device.client.deviceId}`,
          );
        }
      }
    },
  },
  {
    id: "§9.31",
    title: "two scopes sharing a row id never collide",
    check: (world) => {
      const neighbourScopeId = world.neighbour.client.scopeId;
      for (const record of world.server.snapshot(world.scopeId).rows) {
        assert.equal(record.scopeId, world.scopeId, "a neighbouring scope's row leaked into the snapshot");
      }
      for (const record of world.server.snapshot(neighbourScopeId).fields) {
        assert.equal(record.scopeId, neighbourScopeId, "a field leaked across scopes");
      }
    },
  },
];

/** Holds once every device has come back online and caught up. */
export const SETTLED_INVARIANTS: readonly WorldInvariant[] = [
  {
    id: "§9.3",
    title: "any partition and merge schedule converges",
    check: (world) => {
      assert.deepEqual(disagreements(world), [], "devices and server disagree after settling");
    },
  },
  {
    id: "§5.1.acked",
    title: "the value a field ends on is the accepted write that should have won it",
    check: (world) => {
      // Read-your-writes, stated where it can be checked: replay every write the server
      // accepted through the rule it claims to resolve by, and the answer has to be what it is
      // actually holding. A device is told its push succeeded, so a write that was accepted and
      // then quietly beaten by nothing at all is a write that never happened as far as anyone
      // can tell — and convergence cannot see it, because every device agrees on the wrong
      // value just as readily as the right one.
      // Replayed the way the server applies a push: grouped by transaction, and within one,
      // row operations before field writes. A batch that arrived rotated is resolved by the
      // server in this order, so a replay that followed the wire order instead would decide a
      // create had happened after its own opening values.
      const byTxn = new Map<string, WeftOp[]>();
      for (const op of world.trace.accepted) {
        byTxn.set(op.txnId, [...(byTxn.get(op.txnId) ?? []), op]);
      }
      const applied = [...byTxn.values()].flatMap((ops) => [
        ...ops.filter((op) => op.kind !== "set"),
        ...ops.filter((op) => op.kind === "set"),
      ]);

      const winners = new Map<string, { readonly value: unknown; readonly hlc: HlcString }>();
      for (const op of applied) {
        if (op.kind !== "set") {
          // A row created again is a different row: whatever a purged one held is not
          // something the server can still be holding.
          for (const key of [...winners.keys()]) {
            if (key.startsWith(`${op.scopeId}\0${op.tableName}\0${op.rowId}\0`)) winners.delete(key);
          }
          continue;
        }
        const key = `${op.scopeId}\0${op.tableName}\0${op.rowId}\0${op.field}`;
        const standing = winners.get(key);
        // A write carrying a base hash was checked against the value it follows, so it wins
        // outright; everything else is decided by the stamp (§5.4).
        const wins = standing === undefined || op.baseHash !== undefined || compareHlc(op.hlc, standing.hlc) > 0;
        if (wins) winners.set(key, { value: op.value, hlc: op.hlc });
      }

      for (const scopeId of new Set(world.trace.accepted.map((op) => op.scopeId))) {
        const snapshot = world.server.snapshot(scopeId);
        const live = new Set(
          snapshot.rows.filter((row) => row.deletedHlc === null).map((row) => `${row.tableName}\0${row.rowId}`),
        );
        for (const record of snapshot.fields) {
          if (!live.has(`${record.tableName}\0${record.rowId}`)) continue;
          const expected = winners.get(`${scopeId}\0${record.tableName}\0${record.rowId}\0${record.field}`);
          if (expected === undefined) continue;
          assert.deepEqual(
            record.value,
            expected.value,
            `${record.tableName}.${record.field} holds ${JSON.stringify(record.value)}, but the write that should have won it was ${JSON.stringify(expected.value)}`,
          );
        }
      }
    },
  },
  {
    id: "§5.4.self",
    title: "a device never quarantines a prose edit nobody else touched",
    check: (world) => {
      // `rebase_exhausted` means an edit could not be replayed onto the server's version of a
      // field. That is a real outcome when two devices are writing the same prose — and a bug
      // when nobody else was, because it can only mean the device's own writes were fighting
      // each other. Convergence cannot see it: the work is set aside, everyone agrees on what
      // is left, and one device's edits have quietly stopped arriving.
      const writers = new Map<string, Set<string>>();
      for (const op of world.trace.accepted) {
        if (op.kind !== "set") continue;
        const key = writeKey(op.tableName, op.rowId, op.field);
        const seen = writers.get(key) ?? new Set<string>();
        seen.add(parseHlc(op.hlc).deviceId);
        writers.set(key, seen);
      }

      for (const device of world.devices) {
        for (const op of device.client.listQuarantine()) {
          if (op.kind !== "set" || op.reason !== "rebase_exhausted") continue;
          const others = [...(writers.get(writeKey(op.tableName, op.rowId, op.field)) ?? [])].filter(
            (writer) => writer !== String(device.client.deviceId),
          );
          assert.notEqual(
            others.length,
            0,
            `${device.client.deviceId} quarantined its own edit to ${op.tableName}.${op.field}, which no other device wrote ` +
              `(txn ${op.txnId}, value ${JSON.stringify(op.value)}, base ${String(op.baseHash).slice(0, 8)}, ` +
              `server value ${JSON.stringify(
                world.server
                  .snapshot(world.scopeId)
                  .fields.find((record) => record.rowId === op.rowId && record.field === op.field)?.value,
              )})`,
          );
        }
      }
    },
  },
  {
    id: "§5.2.drain",
    title: "a settled device is holding no unsent work",
    check: (world) => {
      // Quiescing syncs every device until nothing moves, so anything still queued is work
      // the client cannot push and has not surfaced either — it will sit there being retried
      // forever. Quarantined work is the deliberate other outcome and is excluded: that has
      // been shown to the user and is waiting on a decision (§5.5).
      for (const device of world.devices) {
        assert.deepEqual(
          device.client.outbox.map((op) => `${op.txnId}:${op.kind}`),
          [],
          `${device.client.deviceId} settled with work it could neither push nor surface`,
        );
      }
    },
  },
  {
    id: "§9.5",
    title: "the snapshot and the incremental stream describe the same state",
    check: (world) => {
      const snapshot = world.server.snapshot(world.scopeId);
      const incremental = world.server.pull(world.scopeId, 0);
      assert.deepEqual(stream(snapshot), stream(incremental), "snapshot and pull-from-zero differ");
    },
  },
  {
    id: "§9.23f",
    title: "every settled row carries first_synced_at",
    check: (world) => {
      const known = new Set(world.server.snapshot(world.scopeId).rows.map((row) => localKey(row.tableName, row.rowId)));
      for (const device of world.devices) {
        for (const [key, row] of device.client.rows) {
          const { tableName: table, rowId: id } = parseLocalKey(key);
          if (!known.has(key) || pendingOps(device.client, table, id).length > 0) continue;
          assert.notEqual(row.internals._weft_first_synced_at, null, `${key} settled with no first_synced_at`);
        }
      }
    },
  },
  {
    // Runs late and deliberately mutates the world: repairing is the last thing a settled
    // history does, and everything after it observes the repaired state.
    id: "§5.5",
    title: "discarding quarantined work and re-pulling leaves every device equal to the server",
    check: (world) => {
      // Until this point rows holding quarantined work are excluded from the convergence
      // check, because a diverged row is allowed to differ. Repairing them the way the UI
      // must offer (§5.5) brings every row back into the comparison.
      for (const device of world.devices) {
        for (const transaction of new Set(device.client.quarantine.map((op) => op.txnId))) {
          device.client.discardQuarantinedTxn(transaction);
        }
        device.client.applySnapshot(world.server.snapshot(world.scopeId));
      }
      quiesce(world);
      assert.deepEqual(disagreements(world), [], "repaired devices still disagree with the server");
      for (const device of world.devices) {
        assert.deepEqual(device.client.quarantine, [], `${device.client.deviceId} still holds quarantined work`);
      }
    },
  },
  {
    id: "§7",
    title: "every device computes the same retention plan from converged state",
    check: (world) => {
      // first_synced_at is server-authoritative precisely so devices expire rows on the same
      // day; with the state converged, the plans have to match row for row.
      const nowMs = world.now + 400 * 24 * 60 * 60 * 1000;
      const plans = world.devices.map((device) =>
        planRetentionDeletes(device.client, propertySchema, { defaultAutoDeleteDays: 30 }, nowMs)
          .map((candidate) => `${candidate.tableName}\0${candidate.rowId}@${candidate.expiresAt}`)
          .sort(),
      );
      for (const plan of plans) {
        assert.deepEqual(plan, plans[0] ?? [], "devices disagree on which rows have expired");
      }
    },
  },
];

export function assertWorldInvariants(world: PropertyWorld, context: string): void {
  for (const invariant of STEP_INVARIANTS) {
    try {
      invariant.check(world);
    } catch (error) {
      throw new Error(`${invariant.id} (${invariant.title}) broke after ${context}: ${describe(error)}`, {
        cause: error,
      });
    }
  }
}

export function assertSettledInvariants(world: PropertyWorld): void {
  for (const invariant of SETTLED_INVARIANTS) {
    try {
      invariant.check(world);
    } catch (error) {
      throw new Error(`${invariant.id} (${invariant.title}) broke after settling: ${describe(error)}`, {
        cause: error,
      });
    }
  }
}

interface StreamBatch {
  readonly fields: readonly {
    readonly tableName: TableName;
    readonly rowId: RowId;
    readonly field: FieldName;
    readonly value: unknown;
  }[];
  readonly rows: readonly {
    readonly tableName: TableName;
    readonly rowId: RowId;
    readonly deletedHlc: string | null;
  }[];
}

function stream(batch: StreamBatch): readonly string[] {
  return [
    ...batch.fields.map((field) => `f:${field.tableName}:${field.rowId}:${field.field}:${JSON.stringify(field.value)}`),
    ...batch.rows.map((row) => `r:${row.tableName}:${row.rowId}:${row.deletedHlc ?? "live"}`),
  ].sort();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
