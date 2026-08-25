// DESIGN.md §9 "Rebase and rejection" — invariants 9 through 14. §9.15 (an acknowledged
// transaction never leaves outbox entries behind) is checked continuously by the world
// model instead.
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import {
  encodeHlc,
  fieldName,
  parseHlc,
  rowId,
  scopeId,
  stableHash,
  txnId,
  wireText,
  type FieldName,
  type HlcString,
  type Rejection,
  type RowId,
  type ScopeId,
  type TxnId,
  type WeftOp,
  type WireValue,
} from "weftdb/core";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import {
  BASE_NOTES,
  createWorld,
  DAY_MS,
  deviceAt,
  EVENTS,
  NOTES,
  propertySchema,
  PROPERTY_RUNS,
  propertySchemaHash,
  RANK,
  replaceLine,
  serverRowFingerprints,
  SCENARIO_RUNS,
  STATUS,
  TASKS,
  TITLE,
  TOMBSTONE_FLOOR_MS,
  type PropertyWorld,
} from "./property-model.ts";

const lineArb = fc.integer({ min: 0, max: BASE_NOTES.split("\n").length - 1 });
const editArb = fc.string({ minLength: 1, maxLength: 10 }).map((text) => `edit ${text}`);

test("§9.9 a merge_required rebase loses no edit from either side", () => {
  fc.assert(
    fc.property(lineArb, lineArb, editArb, editArb, (firstLine, offset, firstEdit, secondEdit) => {
      fc.pre(firstEdit !== secondEdit);
      const lines = BASE_NOTES.split("\n").length;
      const secondLine = (firstLine + 1 + offset) % lines;
      fc.pre(secondLine !== firstLine);

      const world = createWorld(2);
      const first = deviceAt(world, 0).client;
      const second = deviceAt(world, 1).client;
      const row = rowId("notes");
      seedTask(world, first, row);
      second.sync(world.server, propertySchemaHash);

      world.now += 1;
      first.update(TASKS, row, { [NOTES]: replaceLine(BASE_NOTES, firstLine, firstEdit) }, txnId("first"));
      first.sync(world.server, propertySchemaHash);
      world.now += 1;
      second.update(TASKS, row, { [NOTES]: replaceLine(BASE_NOTES, secondLine, secondEdit) }, txnId("second"));
      second.sync(world.server, propertySchemaHash);

      const merged = wireText(serverField(world, row, NOTES) ?? "");
      assert.equal(second.quarantine.length, 0, "a mergeable edit was quarantined");
      assert.equal(merged.includes(firstEdit), true, "lost the first device's edit");
      assert.equal(merged.includes(secondEdit), true, "lost the second device's edit");
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.10 rebase retries at most three times, then quarantines", () => {
  fc.assert(
    fc.property(editArb, (edit) => {
      const world = createWorld(1);
      const client = deviceAt(world, 0).client;
      const row = rowId("racing");
      seedTask(world, client, row);

      // A competitor landing a fresh write ahead of every push keeps the base hash stale,
      // so the rebase loop can only ever end by giving up.
      const rejections = interposeCompetingWrites(world, row);
      world.now += 1;
      client.update(TASKS, row, { [NOTES]: replaceLine(BASE_NOTES, 0, edit) }, txnId("racing-edit"));
      client.sync(world.server, propertySchemaHash);

      assert.equal(rejections.count, 4, "expected one push plus exactly three retries");
      assert.equal(client.outbox.length, 0, "the exhausted rebase left the outbox undrained");
      assert.equal(
        client.quarantine.every((op) => op.txnId === txnId("racing-edit") && op.reason === "rebase_exhausted"),
        true,
        "the exhausted rebase was not quarantined",
      );
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.11 a quarantined transaction is never applied and never dropped", () => {
  fc.assert(
    fc.property(fc.constantFrom(...QUARANTINE_SCENARIOS), (scenario) => {
      const name = scenario.name;
      const world = createWorld(2);
      const client = scenario.arrange(world);
      const before = serverRowFingerprints(world);

      client.sync(world.server, propertySchemaHash);

      const quarantined = client.quarantine.filter((op) => op.txnId === scenario.txnId);
      assert.equal(quarantined.length > 0, true, `${name}: nothing was quarantined`);
      assert.equal(
        quarantined.every((op) => op.reason === scenario.reason),
        true,
        `${name}: expected ${scenario.reason}, got ${quarantined.map((op) => op.reason).join(",")}`,
      );
      assert.equal(
        client.outbox.some((op) => op.txnId === scenario.txnId),
        false,
        `${name}: left in the outbox`,
      );
      assert.equal(client.exportQuarantinedTxn(scenario.txnId).length, quarantined.length, `${name}: export lost ops`);
      assert.deepEqual(serverRowFingerprints(world), before, `${name}: a rejected transaction changed server state`);
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.12 a skew rejection leaves no server trace and converges as if accepted", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 6 * 60 * 1000, max: 8 * 60 * 60 * 1000 }),
      fc.string({ minLength: 1, maxLength: 10 }),
      (skewMs, title) => {
        const world = createWorld(1);
        const skewed = new WeftClient(
          world.scopeId,
          deviceAt(world, 0).client.deviceId,
          propertySchema,
          () => world.now + skewMs,
        );
        const row = rowId("skewed");
        skewed.create(TASKS, row, taskValues(title), txnId("skewed"));

        const before = serverRowFingerprints(world);
        const rejected = world.server.push(world.scopeId, [...skewed.outbox]);
        assert.equal(rejected.ok, false, "a skewed op was accepted");
        assert.equal(rejected.ok ? "" : rejected.rejection.reason, "clock_skew");
        assert.deepEqual(serverRowFingerprints(world), before, "the rejection left a server trace");

        skewed.sync(world.server, propertySchemaHash);
        assert.equal(skewed.quarantine.length, 0, "re-stamped ops were quarantined");
        assert.equal(skewed.outbox.length, 0, "re-stamped ops were not accepted");

        const control = createWorld(1);
        const inSync = deviceAt(control, 0).client;
        inSync.create(TASKS, row, taskValues(title), txnId("skewed"));
        inSync.sync(control.server, propertySchemaHash);
        assert.deepEqual(valueState(world), valueState(control), "a re-stamped history diverged from a clean one");
      },
    ),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.13 a schema_mismatch session leaves the outbox byte-identical", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 6 }), fc.string({ minLength: 1, maxLength: 10 }), (newerVersion, title) => {
      const newerSchema = defineSchema(
        {
          tasks: S.collection({
            title: S.string(),
            priority: S.number({ nullable: true }),
          }),
        },
        newerVersion,
      );

      const world = createWorld(1);
      const stale = deviceAt(world, 0).client;
      const upgraded = new WeftClient(world.scopeId, stale.deviceId, newerSchema, () => world.now);
      upgraded.create(TASKS, rowId("upgraded"), { [TITLE]: "upgraded" }, txnId("upgraded"));
      upgraded.sync(world.server, schemaHash(newerSchema));

      stale.create(TASKS, rowId("stale"), taskValues(title), txnId("stale"));
      const outbox = JSON.stringify(stale.outbox);
      const attempts = new Map(stale.outboxAttempts);
      stale.sync(world.server, propertySchemaHash);

      assert.equal(JSON.stringify(stale.outbox), outbox, "the outbox changed");
      assert.deepEqual(new Map(stale.outboxAttempts), attempts, "retry accounting changed");
      assert.equal(stale.quarantine.length, 0, "a blocked session quarantined ops");
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.14 rejection is all-or-nothing per transaction", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 2 }),
      fc.constantFrom<InvalidOpKind[]>("foreign-scope", "base-field", "absent-row", "clock-skew"),
      fc.string({ minLength: 1, maxLength: 10 }),
      (position, kind, value) => {
        const world = createWorld(1);
        const client = deviceAt(world, 0).client;
        const row = rowId("atomic");
        seedTask(world, client, row);

        const before = serverRowFingerprints(world);
        const batch = mixedTransaction(world, row, position, kind, value);
        const result = world.server.push(world.scopeId, [...batch]);

        assert.equal(result.ok, false, "an invalid transaction was accepted");
        assert.deepEqual(serverRowFingerprints(world), before, "part of a rejected transaction was applied");
      },
    ),
    { numRuns: SCENARIO_RUNS },
  );
});

type RowFixture = "live" | "tombstoned" | "purged" | "append" | "absent";
type BaseHashChoice = "none" | "current" | "stale";

interface GeneratedOp {
  readonly fixture: RowFixture;
  readonly kind: WeftOp["kind"];
  readonly foreignScope: boolean;
  readonly skewed: boolean;
  readonly baseField: boolean;
  readonly baseHash: BaseHashChoice;
}

const generatedOpArb: fc.Arbitrary<GeneratedOp> = fc.record({
  fixture: fc.constantFrom<RowFixture[]>("live", "tombstoned", "purged", "append", "absent"),
  kind: fc.constantFrom<WeftOp["kind"][]>("create", "append", "set", "delete", "restore"),
  foreignScope: fc.boolean(),
  skewed: fc.boolean(),
  baseField: fc.boolean(),
  baseHash: fc.constantFrom<BaseHashChoice[]>("none", "current", "stale"),
});

const malformedHlcArb = fc
  .oneof(
    fc.string({ maxLength: 24 }),
    fc
      .tuple(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.string({ minLength: 1, maxLength: 8 }),
      )
      .map((parts) => parts.join("-")),
  )
  .filter((candidate) => {
    try {
      const parsed = parseHlc(candidate as HlcString);
      return !Number.isFinite(parsed.wallMs) || !Number.isInteger(parsed.counter) || encodeHlc(parsed) !== candidate;
    } catch {
      return true;
    }
  });

test("§5.3 the server accepts a generated op exactly when the rules allow it", () => {
  fc.assert(
    fc.property(generatedOpArb, fc.string({ minLength: 1, maxLength: 10 }), (shape, value) => {
      const world = createWorld(1);
      const fixtures = seedFixtures(world);
      const row = fixtures[shape.fixture];
      const before = serverRowFingerprints(world);

      const op = generatedOp(world, shape, row, value);
      const result = world.server.push(world.scopeId, [op]);
      const expected = expectedRejection(shape);

      assert.equal(result.ok, expected === undefined, `${describe(shape)}: expected ${expected ?? "acceptance"}`);
      if (!result.ok) {
        assert.equal(result.rejection.reason, expected, describe(shape));
        assert.deepEqual(
          serverRowFingerprints(world),
          before,
          `${describe(shape)}: a rejected op changed server state`,
        );
        return;
      }
      if (op.kind === "set" && shape.fixture !== "append") {
        assert.equal(serverField(world, row, op.field), value, `${describe(shape)}: an accepted set did not land`);
      }
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§5.3 a malformed HLC is never accepted or stored", () => {
  fc.assert(
    fc.property(malformedHlcArb, fc.boolean(), (hlc, asCreate) => {
      const world = createWorld(1);
      const before = serverRowFingerprints(world);
      const op: WeftOp = asCreate
        ? {
            scopeId: world.scopeId,
            tableName: TASKS,
            rowId: rowId("malformed-hlc"),
            kind: "create",
            hlc: hlc as HlcString,
            txnId: txnId("malformed-hlc"),
          }
        : {
            scopeId: world.scopeId,
            tableName: TASKS,
            rowId: rowId("malformed-hlc"),
            kind: "set",
            field: TITLE,
            value: "bad stamp",
            hlc: hlc as HlcString,
            txnId: txnId("malformed-hlc"),
          };

      try {
        const result = world.server.push(world.scopeId, [op]);
        assert.equal(result.ok, false, `${JSON.stringify(hlc)} was accepted as a protocol HLC`);
      } catch (error) {
        assert.match((error as Error).message, /HLC|hlc|invalid/u);
      }
      assert.deepEqual(serverRowFingerprints(world), before, "a malformed HLC changed server state");
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

/**
 * §5.3 restated: scope, then skew, then row existence, then the field-level rules. The
 * design lists the base-field and append-class checks before existence, which agrees with
 * this order on every reachable input — an absent row has neither a base field to protect
 * nor a class to violate.
 */
function expectedRejection(shape: GeneratedOp): Rejection["reason"] | undefined {
  const exists = shape.fixture === "live" || shape.fixture === "tombstoned" || shape.fixture === "append";
  if (shape.foreignScope) return "scope_mismatch";
  if (shape.skewed) return "clock_skew";
  if ((shape.kind === "create" || shape.kind === "append") && exists) return "row_exists";
  if (shape.kind !== "create" && shape.kind !== "append" && !exists) return "row_absent";
  if (shape.kind === "set" && shape.baseField) return "base_field_violation";
  if (shape.fixture === "append") return "append_class_violation";
  if (shape.kind === "set" && shape.baseHash === "stale") return "merge_required";
  return undefined;
}

function generatedOp(world: PropertyWorld, shape: GeneratedOp, row: RowId, value: string): WeftOp {
  const scope = shape.foreignScope ? scopeId("elsewhere") : world.scopeId;
  const transaction = txnId("generated");
  // Accepted writes must win the field-wise comparison, so they are stamped at the top of
  // the in-skew window; a skewed op sits just past the threshold.
  const wallMs = shape.skewed ? world.now + world.server.skewThresholdMs + 1 : world.now;
  const hlc = stamp(world, wallMs, 9_999);
  if (shape.kind !== "set")
    return { scopeId: scope, tableName: TASKS, rowId: row, kind: shape.kind, hlc, txnId: transaction };

  const field = shape.baseField ? fieldName("created") : shape.baseHash === "none" ? TITLE : NOTES;
  const set: WeftOp = {
    scopeId: scope,
    tableName: TASKS,
    rowId: row,
    kind: "set",
    field,
    value,
    hlc,
    txnId: transaction,
  };
  if (shape.baseHash === "none" || shape.baseField) return set;
  const current =
    shape.baseHash === "current" ? (serverField(world, row, NOTES) ?? null) : "a value the server never held";
  return { ...set, baseHash: stableHash(current) };
}

function seedFixtures(world: PropertyWorld): Record<RowFixture, RowId> {
  const client = deviceAt(world, 0).client;
  const fixtures: Record<RowFixture, RowId> = {
    live: rowId("fixture-live"),
    tombstoned: rowId("fixture-tombstoned"),
    purged: rowId("fixture-purged"),
    append: rowId("fixture-append"),
    absent: rowId("fixture-absent"),
  };

  for (const row of [fixtures.live, fixtures.tombstoned, fixtures.purged]) {
    client.create(TASKS, row, taskValues(String(row)), txnId(`seed-${row}`));
  }
  client.append(TASKS, fixtures.append, taskValues("append"), txnId("seed-append"));
  client.sync(world.server, propertySchemaHash);

  // Only the purged row's delete is old enough for the floor to take it; the tombstoned
  // row is deleted after the clock has moved on, so it survives the same prune.
  client.delete(TASKS, fixtures.purged, txnId("delete-purged"));
  client.sync(world.server, propertySchemaHash);
  world.now += TOMBSTONE_FLOOR_MS + DAY_MS;
  world.server.pruneTombstones(world.scopeId);
  client.delete(TASKS, fixtures.tombstoned, txnId("delete-tombstoned"));
  client.sync(world.server, propertySchemaHash);
  return fixtures;
}

function describe(shape: GeneratedOp): string {
  return `${shape.kind} on a ${shape.fixture} row (${shape.foreignScope ? "foreign scope" : "own scope"}, ${shape.skewed ? "skewed" : "in time"}, ${shape.baseField ? "base field" : "domain field"}, base hash ${shape.baseHash})`;
}

interface QuarantineScenario {
  readonly name: string;
  readonly reason: Rejection["reason"];
  readonly txnId: TxnId;
  arrange(world: PropertyWorld): WeftClient;
}

const QUARANTINE_SCENARIOS: readonly QuarantineScenario[] = [
  {
    name: "base field violation",
    reason: "base_field_violation",
    txnId: txnId("violation"),
    arrange: (world) => {
      const client = deviceAt(world, 0).client;
      const row = rowId("violation-row");
      seedTask(world, client, row);
      client.update(TASKS, row, { [fieldName("created")]: "rewritten" }, txnId("violation"));
      return client;
    },
  },
  {
    name: "append class violation",
    reason: "append_class_violation",
    txnId: txnId("append-violation"),
    arrange: (world) => {
      const client = deviceAt(world, 0).client;
      const event = rowId("append-violation-row");
      client.append(
        EVENTS,
        event,
        {
          [fieldName("task_id")]: "task",
          [fieldName("status")]: "open",
        },
        txnId("append-create"),
      );
      client.sync(world.server, propertySchemaHash);
      // A current client refuses to queue an edit to an append row at all, so the op is put on
      // the outbox directly: this is what reaches a server from a build that predates the rule,
      // and what happens to it afterwards is the point of the test.
      client.outbox.push({
        scopeId: world.scopeId,
        tableName: EVENTS,
        rowId: event,
        kind: "set",
        field: fieldName("status"),
        value: "closed",
        hlc: client.clock.next(),
        txnId: txnId("append-violation"),
      });
      return client;
    },
  },
  {
    name: "row exists",
    reason: "row_exists",
    txnId: txnId("duplicate-create"),
    arrange: (world) => {
      const first = deviceAt(world, 0).client;
      const second = deviceAt(world, 1).client;
      const row = rowId("duplicate-row");
      seedTask(world, first, row);
      second.create(TASKS, row, taskValues("second"), txnId("duplicate-create"));
      return second;
    },
  },
  {
    name: "row absent",
    reason: "row_absent",
    txnId: txnId("absent-write"),
    arrange: (world) => {
      const owner = deviceAt(world, 0).client;
      const writer = deviceAt(world, 1).client;
      const row = rowId("absent-row");
      seedTask(world, owner, row);
      writer.sync(world.server, propertySchemaHash);
      owner.delete(TASKS, row, txnId("absent-delete"));
      owner.sync(world.server, propertySchemaHash);
      world.now += TOMBSTONE_FLOOR_MS + DAY_MS;
      world.server.pruneTombstones(world.scopeId);
      writer.update(TASKS, row, { [TITLE]: "written into a void" }, txnId("absent-write"));
      return writer;
    },
  },
  {
    name: "scope mismatch",
    reason: "scope_mismatch",
    txnId: txnId("foreign-scope"),
    arrange: (world) => {
      const client = deviceAt(world, 0).client;
      const row = rowId("foreign-row");
      seedTask(world, client, row);
      client.update(TASKS, row, { [TITLE]: "foreign" }, txnId("foreign-scope"));
      for (const op of client.outbox) op.scopeId = scopeId("other-scope");
      return client;
    },
  },
];

function seedTask(world: PropertyWorld, client: WeftClient, row: RowId): void {
  client.create(TASKS, row, taskValues(String(row)), txnId(`seed-${row}`));
  client.sync(world.server, propertySchemaHash);
}

function taskValues(label: string): Record<FieldName, WireValue> {
  return {
    [TITLE]: `title-${label}`,
    [STATUS]: "open",
    [NOTES]: BASE_NOTES,
    [RANK]: "a:seed",
  };
}

function serverField(world: PropertyWorld, row: RowId, field: FieldName): WireValue | undefined {
  return world.server.snapshot(world.scopeId).fields.find((record) => record.rowId === row && record.field === field)
    ?.value;
}

/**
 * Values and liveness only: re-stamped HLCs differ from a clean run by construction, and so
 * does `created`, which the application stamps from the device's own clock before any push
 * happens — a skewed device writes a skewed timestamp whether or not it was ever rejected.
 */
function valueState(world: PropertyWorld): readonly string[] {
  const snapshot = world.server.snapshot(world.scopeId);
  return [
    ...snapshot.fields
      .filter((field) => field.field !== fieldName("created"))
      .map((field) => `${field.tableName}:${field.rowId}:${field.field}=${JSON.stringify(field.value)}`),
    ...snapshot.rows.map((row) => `${row.tableName}:${row.rowId}:${row.deletedHlc === null ? "live" : "deleted"}`),
  ].sort();
}

interface RejectionCounter {
  count: number;
}

/** Lands a newer write on `notes` before every push, so no base hash can ever match. */
function interposeCompetingWrites(world: PropertyWorld, row: RowId): RejectionCounter {
  const counter: RejectionCounter = { count: 0 };
  const target = world.server as unknown as { push: WeftServer["push"] };
  const original = target.push.bind(world.server);
  let round = 0;
  target.push = (scope: ScopeId, ops: WeftOp[]) => {
    if (ops.some((op) => op.kind === "set" && op.field === NOTES)) {
      round += 1;
      counter.count += 1;
      original(scope, [
        {
          scopeId: scope,
          tableName: TASKS,
          rowId: row,
          kind: "set",
          field: NOTES,
          value: `competitor-${round}`,
          hlc: stamp(world, world.now + round, round),
          txnId: txnId(`competitor-${round}`),
        },
      ]);
    }
    return original(scope, ops);
  };
  return counter;
}

export type InvalidOpKind = "foreign-scope" | "base-field" | "absent-row" | "clock-skew";

/** A transaction whose ops are individually valid apart from exactly one. */
function mixedTransaction(
  world: PropertyWorld,
  row: RowId,
  position: number,
  kind: InvalidOpKind,
  value: string,
): readonly WeftOp[] {
  const transaction = txnId("mixed");
  const valid: WeftOp[] = [
    {
      scopeId: world.scopeId,
      tableName: TASKS,
      rowId: row,
      kind: "set",
      field: TITLE,
      value,
      hlc: stamp(world, world.now, 1),
      txnId: transaction,
    },
    {
      scopeId: world.scopeId,
      tableName: TASKS,
      rowId: row,
      kind: "set",
      field: STATUS,
      value,
      hlc: stamp(world, world.now, 2),
      txnId: transaction,
    },
  ];
  const invalid = invalidOp(world, row, kind, transaction);
  const index = position % (valid.length + 1);
  return [...valid.slice(0, index), invalid, ...valid.slice(index)];
}

function invalidOp(world: PropertyWorld, row: RowId, kind: InvalidOpKind, transaction: TxnId): WeftOp {
  switch (kind) {
    case "foreign-scope":
      return {
        scopeId: scopeId("other-scope"),
        tableName: TASKS,
        rowId: row,
        kind: "set",
        field: TITLE,
        value: "foreign",
        hlc: stamp(world, world.now, 3),
        txnId: transaction,
      };
    case "base-field":
      return {
        scopeId: world.scopeId,
        tableName: TASKS,
        rowId: row,
        kind: "set",
        field: fieldName("created"),
        value: "rewritten",
        hlc: stamp(world, world.now, 4),
        txnId: transaction,
      };
    case "absent-row":
      return {
        scopeId: world.scopeId,
        tableName: TASKS,
        rowId: rowId("ghost"),
        kind: "set",
        field: TITLE,
        value: "ghost",
        hlc: stamp(world, world.now, 5),
        txnId: transaction,
      };
    case "clock-skew":
      return {
        scopeId: world.scopeId,
        tableName: TASKS,
        rowId: row,
        kind: "set",
        field: TITLE,
        value: "future",
        hlc: stamp(world, world.now + 60 * 60 * 1000, 6),
        txnId: transaction,
      };
  }
}

function stamp(world: PropertyWorld, wallMs: number, counter: number): HlcString {
  return encodeHlc({ wallMs, counter, deviceId: deviceAt(world, 0).client.deviceId });
}
