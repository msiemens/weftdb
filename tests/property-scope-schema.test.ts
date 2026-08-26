// DESIGN.md §9 "Authorization and scope" and "Schema lifecycle" — the invariants that need
// a specific arrangement. §9.30 (a client database only holds its own scope) and §9.31
// (row ids never collide across scopes) are checked continuously by the world model.
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import {
  deviceId,
  encodeHlc,
  fieldName,
  rowId,
  schemaHashValue,
  scopeId,
  txnId,
  type DeviceId,
  type FieldName,
  type HlcString,
  type RowId,
  type ScopeId,
  type WireValue,
} from "weftdb/core";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { inProcessTransport, WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { authContext, createRelayHandler, staticTokenVerifier } from "weftdb/server/relay";
import {
  BASE_NOTES,
  BASE_TIME,
  createWorld,
  deviceAt,
  localKey,
  NOTES,
  propertySchema,
  PROPERTY_RUNS,
  propertySchemaHash,
  RANK,
  SCENARIO_RUNS,
  STATUS,
  TASKS,
  TITLE,
  type PropertyWorld,
} from "./property-model.ts";

const labelArb = fc.string({ minLength: 1, maxLength: 10 });
const fieldDefinitionArb = fc.record({
  type: fc.constantFrom("string" as const, "number" as const, "boolean" as const, "json" as const, "date" as const),
  nullable: fc.boolean(),
  merge: fc.constantFrom("lww" as const, "diff3" as const, "fracIndex" as const, "immutable" as const),
});

test("§9.28 an op stamped with another scope is rejected server-side", async () => {
  await fc.assert(
    fc.asyncProperty(labelArb, labelArb, async (foreignLabel, value) => {
      const world = createWorld(1);
      const client = deviceAt(world, 0).client;
      const row = rowId("scoped");
      await client.create(TASKS, row, taskValues("scoped"), txnId("create"));
      await client.syncWith(inProcessTransport(world.server), propertySchemaHash);

      const result = world.server.push(world.scopeId, [
        {
          scopeId: scopeId(`foreign-${foreignLabel}`),
          tableName: TASKS,
          rowId: row,
          kind: "set",
          field: TITLE,
          value,
          hlc: stamp(world, world.now, 1),
          txnId: txnId("crossed"),
        },
      ]);
      assert.equal(result.ok, false, "a cross-scope op was accepted");
      assert.equal(result.ok ? "" : result.rejection.reason, "scope_mismatch");
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.28 the relay refuses a body scope the token does not carry", async () => {
  const scope = scopeId("relay-scope");
  const server = new WeftServer(() => BASE_TIME);
  const handler = createRelayHandler({
    server,
    verifier: staticTokenVerifier(new Map([["token", authContext(scope, "relay-device")]])),
  });

  const response = await handler(
    new Request("https://weft.test/handshake", {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: JSON.stringify({
        scopeId: scopeId("other"),
        schemaHash: propertySchemaHash,
        schemaVersion: 1,
        lastServerSeq: 0,
      }),
    }),
  );
  assert.equal(response.status, 403);
});

test("§9.29 scope_id is immutable after insert", async () => {
  await fc.assert(
    fc.asyncProperty(labelArb, async (value) => {
      const world = createWorld(1);
      const client = deviceAt(world, 0).client;
      const row = rowId("immutable-scope");
      await client.create(TASKS, row, taskValues("immutable"), txnId("create"));
      await client.syncWith(inProcessTransport(world.server), propertySchemaHash);

      const result = world.server.push(world.scopeId, [
        {
          scopeId: world.scopeId,
          tableName: TASKS,
          rowId: row,
          kind: "set",
          field: fieldName("scope_id"),
          value,
          hlc: stamp(world, world.now, 2),
          txnId: txnId("move"),
        },
      ]);
      assert.equal(result.ok, false, "scope_id was rewritten");
      assert.equal(result.ok ? "" : result.rejection.reason, "base_field_violation");
      assert.equal(serverField(world, row, fieldName("scope_id")), world.scopeId);
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.29 opening base fields must describe the row being created", async () => {
  await fc.assert(
    fc.asyncProperty(labelArb, labelArb, async (badId, badScope) => {
      const world = createWorld(1);
      const row = rowId("base-row");
      fc.pre(badId !== String(row) || badScope !== String(world.scopeId));

      for (const [field, value] of [
        [fieldName("id"), badId],
        [fieldName("scope_id"), badScope],
      ] as const) {
        if (
          (field === fieldName("id") && value === String(row)) ||
          (field === fieldName("scope_id") && value === String(world.scopeId))
        ) {
          continue;
        }
        const result = world.server.push(world.scopeId, [
          {
            scopeId: world.scopeId,
            tableName: TASKS,
            rowId: row,
            kind: "create",
            hlc: stamp(world, world.now, 1),
            txnId: txnId(`create-${field}`),
          },
          {
            scopeId: world.scopeId,
            tableName: TASKS,
            rowId: row,
            kind: "set",
            field,
            value,
            hlc: stamp(world, world.now, 2),
            txnId: txnId(`create-${field}`),
          },
        ]);
        assert.equal(result.ok, false, `a create wrote ${field}=${JSON.stringify(value)} for ${row}`);
      }
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.24 base fields are framework-owned for every collection", () => {
  fc.assert(
    fc.property(
      fc.dictionary(fc.constantFrom("id", "scope_id", "created", "title", "notes"), fieldDefinitionArb, {
        minKeys: 1,
        maxKeys: 5,
        noNullPrototype: true,
      }),
      (fields) => {
        const collection = S.collection(fields);
        assert.deepEqual(collection.fields.id, S.string({ merge: "immutable" }), "id was overridden by user schema");
        assert.deepEqual(
          collection.fields.scope_id,
          S.string({ merge: "immutable" }),
          "scope_id was overridden by user schema",
        );
        assert.deepEqual(
          collection.fields.created,
          S.date({ merge: "immutable" }),
          "created was overridden by user schema",
        );
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.31 identical row ids in two scopes never collide", async () => {
  await fc.assert(
    fc.asyncProperty(labelArb, labelArb, async (firstTitle, secondTitle) => {
      fc.pre(firstTitle !== secondTitle);
      const server = new WeftServer(() => BASE_TIME);
      const shared = rowId("same-id");
      const scopes = [scopeId("collide-a"), scopeId("collide-b")] as const;
      const titles = [firstTitle, secondTitle] as const;

      for (const [index, scope] of scopes.entries()) {
        const client = new WeftClient(scope, deviceFor(scope), propertySchema, () => BASE_TIME);
        await client.create(
          TASKS,
          shared,
          { ...taskValues("shared"), [TITLE]: titles[index] ?? "" },
          txnId(`create-${index}`),
        );
        await client.syncWith(inProcessTransport(server), propertySchemaHash);
      }

      for (const [index, scope] of scopes.entries()) {
        const snapshot = server.snapshot(scope);
        assert.equal(snapshot.rows.filter((row) => row.rowId === shared).length, 1);
        assert.equal(
          snapshot.fields.find((field) => field.rowId === shared && field.field === TITLE)?.value,
          titles[index],
          "two scopes shared a row",
        );
      }
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.32 an op past the skew threshold is rejected, and one inside it is not", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: -10 * 60 * 1000, max: 30 * 60 * 1000 }), labelArb, async (ahead, value) => {
      const world = createWorld(1);
      const client = deviceAt(world, 0).client;
      const row = rowId("skew");
      await client.create(TASKS, row, taskValues("skew"), txnId("create"));
      await client.syncWith(inProcessTransport(world.server), propertySchemaHash);

      const result = world.server.push(world.scopeId, [
        {
          scopeId: world.scopeId,
          tableName: TASKS,
          rowId: row,
          kind: "set",
          field: TITLE,
          value,
          hlc: stamp(world, world.now + ahead, 3),
          txnId: txnId("skewed"),
        },
      ]);
      assert.equal(result.ok, ahead <= world.server.skewThresholdMs, `${ahead}ms ahead of the server`);
      if (!result.ok) assert.equal(result.rejection.reason, "clock_skew");
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.33 the outbox survives session expiry and re-login into the same scope", async () => {
  const scope = scopeId("session-scope");
  const server = new WeftServer(() => BASE_TIME);
  const handler = createRelayHandler({
    server,
    verifier: staticTokenVerifier(new Map([["fresh", authContext(scope, "session-device")]])),
  });

  const client = new WeftClient(scope, deviceId("session-device"), propertySchema, () => BASE_TIME);
  await client.create(TASKS, rowId("pending"), taskValues("pending"), txnId("pending"));
  const pending = JSON.stringify(client.outbox);

  const expired = await handler(
    new Request("https://weft.test/push", {
      method: "POST",
      headers: { authorization: "Bearer expired" },
      body: JSON.stringify({ ops: client.outbox }),
    }),
  );
  assert.equal(expired.status, 401);
  assert.equal(JSON.stringify(client.outbox), pending, "an expired session touched the outbox");

  const accepted = await handler(
    new Request("https://weft.test/push", {
      method: "POST",
      headers: { authorization: "Bearer fresh" },
      body: JSON.stringify({ ops: client.outbox }),
    }),
  );
  assert.equal(accepted.status, 200);
  assert.equal(((await accepted.json()) as { readonly ok: boolean }).ok, true);
  assert.equal(server.rows.size, 1, "the preserved outbox never reached the server after re-login");
});

test("§9.43 schema_version never decreases for a scope, whatever clients turn up", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 25 }), async (versions) => {
      const scope = scopeId("versions");
      const server = new WeftServer(() => BASE_TIME);
      let highest = 0;
      for (const [index, version] of versions.entries()) {
        server.handshake({
          scopeId: scope,
          deviceId: deviceId(`device-${index}`),
          schemaHash: schemaHashValue(`hash-${version}`),
          schemaVersion: version,
          lastServerSeq: 0,
        });
        const current = server.scopes.get(scope)?.schemaVersion ?? 0;
        assert.equal(current >= highest, true, "the schema version went backwards");
        highest = current;
      }
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("§9.44 a client below the scope's schema version cannot write", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 6 }), labelArb, async (newerVersion, title) => {
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
      await upgraded.create(TASKS, rowId("newer"), { [TITLE]: "newer" }, txnId("newer"));
      await upgraded.syncWith(inProcessTransport(world.server), schemaHash(newerSchema));
      const before = serverState(world);

      await stale.create(TASKS, rowId("stale"), taskValues(title), txnId("stale"));
      const outbox = JSON.stringify(stale.outbox);
      await stale.syncWith(inProcessTransport(world.server), propertySchemaHash);

      assert.deepEqual(serverState(world), before, "a stale client wrote");
      assert.equal(JSON.stringify(stale.outbox), outbox, "a blocked session moved the outbox");
    }),
    { numRuns: SCENARIO_RUNS },
  );
});

test("§9.45 an equal version with a different hash always fails and adopts neither side", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 6 }), labelArb, labelArb, async (version, established, divergent) => {
      fc.pre(established !== divergent);
      const scope = scopeId("hashes");
      const server = new WeftServer(() => BASE_TIME);
      const establishedHash = schemaHashValue(established);

      assert.deepEqual(
        server.handshake({
          scopeId: scope,
          deviceId: deviceId("first"),
          schemaHash: establishedHash,
          schemaVersion: version,
          lastServerSeq: 0,
        }),
        { ok: true },
      );
      assert.deepEqual(
        server.handshake({
          scopeId: scope,
          deviceId: deviceId("second"),
          schemaHash: schemaHashValue(divergent),
          schemaVersion: version,
          lastServerSeq: 0,
        }),
        { ok: false, reason: "schema_mismatch" },
      );
      assert.equal(server.scopes.get(scope)?.schemaHash, establishedHash, "the scope adopted a divergent hash");
      assert.equal(server.scopes.get(scope)?.schemaVersion, version);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

function taskValues(label: string): Record<FieldName, WireValue> {
  return {
    [TITLE]: `title-${label}`,
    [STATUS]: "open",
    [NOTES]: BASE_NOTES,
    [RANK]: "a:seed",
  };
}

function deviceFor(scope: ScopeId): DeviceId {
  return deviceId(`device-${scope}`);
}

function stamp(world: PropertyWorld, wallMs: number, counter: number): HlcString {
  return encodeHlc({ wallMs, counter, deviceId: deviceAt(world, 0).client.deviceId });
}

function serverField(world: PropertyWorld, row: RowId, field: FieldName): WireValue | undefined {
  return world.server.snapshot(world.scopeId).fields.find((record) => record.rowId === row && record.field === field)
    ?.value;
}

function serverState(world: PropertyWorld): readonly string[] {
  const snapshot = world.server.snapshot(world.scopeId);
  return [
    ...snapshot.fields.map(
      (field) => `${localKey(field.tableName, field.rowId)}:${field.field}=${JSON.stringify(field.value)}`,
    ),
    ...snapshot.rows.map((row) => `${localKey(row.tableName, row.rowId)}:${row.deletedHlc ?? "live"}`),
  ].sort();
}
