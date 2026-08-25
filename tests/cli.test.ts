import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "vitest";
import { artifactFiles, loadSchema, main, rehydrateSnapshotNdjson, setSchemaHashSql } from "weftdb-cli";

const SCHEMA_MODULE = `import { defineSchema, S } from "weftdb/schema";

export const schema = defineSchema({
  tasks: S.collection({
    title: S.string(),
    notes: S.string({ merge: "diff3" }),
  }),
}, 2);
`;

test("the CLI loads a TypeScript schema module, which is where the schema lives", async (t) => {
  const directory = await projectDirectory(t);
  const schemaPath = join(directory, "weft.schema.ts");
  await writeFile(schemaPath, SCHEMA_MODULE);

  const loaded = await loadSchema(schemaPath);
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join());
  assert.deepEqual(loaded.ok ? Object.keys(loaded.schema.collections) : [], ["tasks"]);
  assert.equal(loaded.ok ? loaded.schema.schemaVersion : 0, 2);
});

test("loading reports a missing or invalid schema instead of throwing", async () => {
  const missing = await loadSchema(join(tmpdir(), "weft-does-not-exist.ts"));
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.errors.join(), /schema file not found/u);

  const directory = await mkdtemp(join(tmpdir(), "weftdb-cli-"));
  const invalidPath = join(directory, "schema.json");
  await writeFile(
    invalidPath,
    JSON.stringify({ schemaVersion: 1, collections: { tasks: { kind: "table", fields: {} } } }),
  );
  const invalid = await loadSchema(invalidPath);
  assert.equal(invalid.ok, false);
  assert.match(invalid.ok ? "" : invalid.errors.join(), /kind must be collection or eventLog/u);
});

test("JSON schemas cannot omit the framework base fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weftdb-cli-"));
  const schemaPath = join(directory, "schema.json");
  await writeFile(
    schemaPath,
    JSON.stringify({
      schemaVersion: 1,
      collections: {
        tasks: {
          kind: "collection",
          relationships: {},
          fields: {
            title: { type: "string", merge: "lww", nullable: false },
          },
        },
      },
    }),
  );

  const loaded = await loadSchema(schemaPath);
  await rm(directory, { recursive: true, force: true });

  assert.equal(loaded.ok, false, "a JSON schema that cannot generate a valid primary key was accepted");
  assert.match(loaded.ok ? "" : loaded.errors.join(), /id|scope_id|created/u);
});

test("JSON schemas accept enum fields with their allowed values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weftdb-cli-"));
  const schemaPath = join(directory, "schema.json");
  await writeFile(
    schemaPath,
    JSON.stringify({
      schemaVersion: 1,
      collections: {
        tasks: {
          kind: "collection",
          relationships: {},
          fields: {
            id: { type: "string", merge: "immutable", nullable: false },
            scope_id: { type: "string", merge: "immutable", nullable: false },
            created: { type: "date", merge: "immutable", nullable: false },
            status: { type: "enum", merge: "lww", nullable: false, values: ["open", "done"] },
          },
        },
      },
    }),
  );

  const loaded = await loadSchema(schemaPath);
  await rm(directory, { recursive: true, force: true });

  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join());
  assert.deepEqual(loaded.ok ? loaded.schema.collections["tasks"]?.fields["status"]?.values : [], ["open", "done"]);
});

test("generate writes every artifact the codegen produces", async (t) => {
  const directory = await projectDirectory(t);
  const schemaPath = join(directory, "weft.schema.ts");
  const outDir = join(directory, "generated");
  await writeFile(schemaPath, SCHEMA_MODULE);

  await main(["generate", "--schema", schemaPath, "--out", outDir]);

  const loaded = await loadSchema(schemaPath);
  assert.equal(loaded.ok, true);
  const expected = loaded.ok ? [...artifactFiles(loaded.schema).keys()].sort() : [];
  assert.deepEqual((await readdir(outDir)).sort(), expected);
  assert.match(await readFile(join(outDir, "client.sql"), "utf8"), /CREATE TABLE IF NOT EXISTS "tasks"/u);
  assert.match(await readFile(join(outDir, "mutators.ts"), "utf8"), /TasksMutation/u);
  assert.match(await readFile(join(outDir, "schema-hash.txt"), "utf8"), /^[0-9a-f]{64}\n$/u);
});

test("set-schema-hash emits operator SQL", () => {
  const sql = setSchemaHashSql({ scopeId: "user-1", schemaHash: "abc'123", schemaVersion: 4 });
  assert.match(sql, /ON CONFLICT\(scope_id\) DO UPDATE/u);
  assert.match(sql, /'abc''123'/u);
});

test("rehydrate materializes snapshot fields into table inserts", () => {
  const ndjson = [
    JSON.stringify({ type: "header", serverSeq: 1, tombstoneFloorSeq: 0, schemaHash: "hash" }),
    JSON.stringify({ type: "field", record: { tableName: "tasks", rowId: "task-1", field: "title", value: "hello" } }),
    JSON.stringify({ type: "field", record: { tableName: "tasks", rowId: "task-1", field: "status", value: "open" } }),
  ].join("\n");
  const sql = rehydrateSnapshotNdjson(ndjson);
  assert.match(sql, /INSERT INTO "tasks"/u);
  assert.match(sql, /"status"/u);
  assert.match(sql, /'hello'/u);
});

/**
 * A throwaway project directory inside the workspace: a schema module imports `weftdb/schema`,
 * so it has to sit somewhere that package resolves from, exactly as a user project would.
 */
async function projectDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), ".weftdb-cli-test-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
