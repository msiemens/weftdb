#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateArtifacts, generateServerDdl } from "weftdb/codegen";
import { MERGE_STRATEGIES, type MergeStrategy } from "weftdb/core";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  if (command === "server-ddl") {
    process.stdout.write(generateServerDdl());
    return;
  }
  if (command === "hash") {
    const loaded = await loadSchema(requiredArg(args, "--schema"));
    if (!loaded.ok) return fail(command, loaded.errors);
    const outPath = args.includes("--out") ? requiredArg(args, "--out") : undefined;
    const artifacts = generateArtifacts(loaded.schema);
    if (outPath) await writeOutput(outPath, `${artifacts.schemaHash}\n`);
    else process.stdout.write(`${artifacts.schemaHash}\n`);
    return;
  }
  if (command === "generate") {
    const schemaPath = requiredArg(args, "--schema");
    const outDir = args.includes("--out") ? requiredArg(args, "--out") : "weft-generated";
    const loaded = await loadSchema(schemaPath);
    if (!loaded.ok) return fail(command, loaded.errors);
    for (const [name, contents] of artifactFiles(loaded.schema)) {
      await writeOutput(resolve(outDir, name), contents);
      process.stdout.write(`weft generate: ${resolve(outDir, name)}\n`);
    }
    return;
  }
  if (command === "serve") {
    // Imported lazily, and for the same reason the SQLite executor is: `weft generate` runs in
    // build steps that will never listen on a port, and it should not pay for the server's
    // socket stack and SQLite binding to find that out.
    const { main: serve } = await import("weftdb/server/serve");
    await serve(process.env, args);
    return;
  }
  if (command === "doctor") {
    const result = await doctorUserProject(args);
    for (const line of result.messages) process.stdout.write(`${line}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (command === "rehydrate") {
    const snapshotPath = requiredArg(args, "--snapshot");
    const outPath = args.includes("--out") ? requiredArg(args, "--out") : undefined;
    const sql = rehydrateSnapshotNdjson(await readFile(snapshotPath, "utf8"));
    if (outPath) await writeOutput(outPath, sql);
    else process.stdout.write(sql);
    return;
  }
  if (command === "set-schema-hash") {
    const sql = setSchemaHashSql({
      scopeId: requiredArg(args, "--scope"),
      schemaHash: requiredArg(args, "--hash"),
      schemaVersion: Number(requiredArg(args, "--version")),
    });
    const outPath = args.includes("--out") ? requiredArg(args, "--out") : undefined;
    if (outPath) await writeOutput(outPath, sql);
    else process.stdout.write(sql);
    return;
  }
  process.stderr.write(
    "usage: weft <serve|hash|generate|server-ddl|doctor|rehydrate|set-schema-hash> [--schema schema.ts] [--out path]\n",
  );
  process.exitCode = 1;
}

function fail(command: string, errors: readonly string[]): void {
  for (const error of errors) process.stderr.write(`weft ${command}: ${error}\n`);
  process.exitCode = 1;
}

/** The generated artifact set, as the files `weft generate` writes for it. */
export function artifactFiles(schema: import("weftdb/schema").SchemaDefinition): ReadonlyMap<string, string> {
  const artifacts = generateArtifacts(schema);
  const banner = `-- weft schema ${schema.schemaVersion} ${artifacts.schemaHash}\n`;
  return new Map([
    ["client.sql", `${banner}${artifacts.clientDdl}`],
    ["server.sql", `${banner}${generateServerDdl()}`],
    ["database.d.ts", artifacts.databaseDts],
    ["internal-database.d.ts", artifacts.internalDatabaseDts],
    ["kysely.d.ts", artifacts.kyselyDatabaseDts],
    ["mutators.ts", artifacts.mutatorsTs],
    ["bindings.ts", artifacts.bindingsTs],
    ["relationships.ts", artifacts.relationshipsTs],
    ["nested-mappers.ts", artifacts.nestedMappersTs],
    ["schema-hash.txt", `${artifacts.schemaHash}\n`],
  ]);
}

export type LoadedSchema =
  | { readonly ok: true; readonly schema: import("weftdb/schema").SchemaDefinition }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * The schema DSL is TypeScript, so that module is the source of truth: a `.ts`/`.js` schema
 * is imported and its exported `SchemaDefinition` taken. A `.json` file is still accepted
 * for pipelines that would rather not execute project code.
 */
export async function loadSchema(path: string): Promise<LoadedSchema> {
  const resolved = resolve(path);
  if (!(await exists(resolved))) return { ok: false, errors: [`schema file not found: ${path}`] };
  try {
    const value = resolved.endsWith(".json")
      ? (JSON.parse(await readFile(resolved, "utf8")) as unknown)
      : await importSchemaModule(resolved);
    return validateSchemaJson(value);
  } catch (error) {
    return { ok: false, errors: [`could not load ${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

async function importSchemaModule(resolved: string): Promise<unknown> {
  const module = (await import(pathToFileURL(resolved).href)) as Readonly<Record<string, unknown>>;
  const named = module["schema"] ?? module["default"];
  return named ?? Object.values(module).find(isSchemaLike);
}

function isSchemaLike(value: unknown): boolean {
  return isRecord(value) && isRecord(value["collections"]) && typeof value["schemaVersion"] === "number";
}

export interface DoctorResult {
  readonly ok: boolean;
  readonly messages: readonly string[];
}

export interface SetSchemaHashInput {
  readonly scopeId: string;
  readonly schemaHash: string;
  readonly schemaVersion: number;
}

export function setSchemaHashSql(input: SetSchemaHashInput): string {
  if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1)
    throw new Error("schema version must be a positive integer");
  return `INSERT INTO scope_state (scope_id, server_seq, tombstone_floor_seq, schema_hash, schema_version)
VALUES (${sqlLiteral(input.scopeId)}, 0, 0, ${sqlLiteral(input.schemaHash)}, ${input.schemaVersion})
ON CONFLICT(scope_id) DO UPDATE SET
  schema_hash = excluded.schema_hash,
  schema_version = excluded.schema_version;
`;
}

export function rehydrateSnapshotNdjson(input: string): string {
  const rows = new Map<string, Map<string, unknown>>();
  for (const line of input.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || parsed["type"] !== "field" || !isRecord(parsed["record"])) continue;
    const record = parsed["record"];
    const tableName = requiredRecordString(record, "tableName");
    const rowId = requiredRecordString(record, "rowId");
    const field = requiredRecordString(record, "field");
    const key = `${tableName}\0${rowId}`;
    const row = rows.get(key) ?? new Map<string, unknown>();
    row.set("id", rowId);
    row.set(field, record["value"] ?? null);
    rows.set(key, row);
  }

  const statements: string[] = ["-- rehydrated from weft snapshot"];
  const rowsByTable = Map.groupBy([...rows.entries()], ([key]) => key.split("\0")[0] ?? "");
  for (const [tableName, entries] of rowsByTable) {
    if (tableName.length === 0) continue;
    for (const [, row] of entries) {
      const columns = [...row.keys()].sort();
      statements.push(
        `INSERT INTO ${quoteIdent(tableName)} (${columns.map(quoteIdent).join(", ")}) VALUES (${columns.map((column) => sqlLiteral(row.get(column))).join(", ")});`,
      );
    }
  }
  return `${statements.join("\n")}\n`;
}

export async function doctorUserProject(args: readonly string[]): Promise<DoctorResult> {
  const schemaPath = args.includes("--schema") ? requiredArg([...args], "--schema") : await findDefaultSchema();
  const messages: string[] = [];
  if (schemaPath === undefined) {
    return {
      ok: false,
      messages: ["weft doctor: no schema file found", "weft doctor: pass --schema schema.ts or create weft.schema.ts"],
    };
  }

  const loaded = await loadSchema(schemaPath);
  if (!loaded.ok) {
    return { ok: false, messages: loaded.errors.map((error) => `weft doctor: ${error}`) };
  }
  const validation = loaded;

  const artifacts = generateArtifacts(validation.schema);
  messages.push(`weft doctor: schema ${schemaPath}`);
  messages.push(`weft doctor: schema version ${validation.schema.schemaVersion}`);
  messages.push(`weft doctor: schema hash ${artifacts.schemaHash}`);
  messages.push(`weft doctor: collections ${Object.keys(validation.schema.collections).length}`);
  messages.push(`weft doctor: client DDL ${artifacts.clientDdl.length} bytes`);
  messages.push(`weft doctor: server DDL ${generateServerDdl().length} bytes`);
  for (const warning of validateRelationshipReferences(validation.schema)) {
    messages.push(`weft doctor: warning: ${warning}`);
  }
  messages.push("weft doctor: ok");
  return { ok: true, messages };
}

type SchemaJsonValidation =
  | { readonly ok: true; readonly schema: import("weftdb/schema").SchemaDefinition }
  | { readonly ok: false; readonly errors: readonly string[] };

function validateSchemaJson(value: unknown): SchemaJsonValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["schema must be an object"] };
  const schemaVersion = value["schemaVersion"];
  const collections = value["collections"];
  if (!Number.isInteger(schemaVersion) || Number(schemaVersion) < 1)
    errors.push("schemaVersion must be a positive integer");
  if (!isRecord(collections)) errors.push("collections must be an object");
  if (errors.length > 0 || !isRecord(collections) || !Number.isInteger(schemaVersion)) return { ok: false, errors };

  for (const [collectionName, collection] of Object.entries(collections)) {
    if (!isRecord(collection)) {
      errors.push(`${collectionName} must be a collection object`);
      continue;
    }
    if (collection["kind"] !== "collection" && collection["kind"] !== "eventLog") {
      errors.push(`${collectionName}.kind must be collection or eventLog`);
    }
    const fields = collection["fields"];
    if (!isRecord(fields)) {
      errors.push(`${collectionName}.fields must be an object`);
      continue;
    }
    for (const [fieldName, field] of Object.entries(fields)) {
      if (fieldName.startsWith("_weft_")) errors.push(`${collectionName}.${fieldName} uses reserved _weft_ prefix`);
      if (!isRecord(field)) {
        errors.push(`${collectionName}.${fieldName} must be a field object`);
        continue;
      }
      if (!["string", "number", "boolean", "json", "date", "enum"].includes(String(field["type"]))) {
        errors.push(`${collectionName}.${fieldName}.type is invalid`);
      }
      if (!MERGE_STRATEGIES.includes(String(field["merge"]) as MergeStrategy)) {
        errors.push(`${collectionName}.${fieldName}.merge is invalid`);
      }
      if (typeof field["nullable"] !== "boolean")
        errors.push(`${collectionName}.${fieldName}.nullable must be boolean`);
      // An enum is worth exactly its values: they decide the row type, the mutator's argument
      // type, and the column's `CHECK`. A field declared `enum` without them is a `string` the
      // generator would go on to describe as a union of nothing.
      if (field["type"] === "enum") {
        const values = field["values"];
        if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string")) {
          errors.push(`${collectionName}.${fieldName}.values must be a non-empty array of strings`);
        } else if (new Set(values as readonly string[]).size !== values.length) {
          errors.push(`${collectionName}.${fieldName}.values repeat`);
        }
      } else if (field["values"] !== undefined) {
        errors.push(`${collectionName}.${fieldName}.values is only valid on an enum field`);
      }
      // A declared TypeScript type is only meaningful where the generator would otherwise write
      // `unknown`, and it is written verbatim into an import and a type position, so a shape the
      // schema DSL would have refused has to be refused here too rather than emitted.
      const jsonType = field["jsonType"];
      if (jsonType !== undefined) {
        if (field["type"] !== "json") {
          errors.push(`${collectionName}.${fieldName}.jsonType is only valid on a json field`);
        } else if (!isRecord(jsonType) || typeof jsonType["as"] !== "string" || jsonType["as"].trim().length === 0) {
          errors.push(`${collectionName}.${fieldName}.jsonType.as must be a non-empty string`);
        } else if (jsonType["from"] !== undefined && typeof jsonType["from"] !== "string") {
          errors.push(`${collectionName}.${fieldName}.jsonType.from must be a string`);
        }
      }
    }
    // The framework owns these three: the server refuses a write to any of them, the client
    // fills them in, and the generated table keys on `(scope_id, id)`. A JSON schema that leaves
    // them out describes a table the rest of the system does not implement, and generation would
    // go on to emit a primary key over columns that are not there.
    for (const base of ["id", "scope_id", "created"]) {
      if (!(base in fields))
        errors.push(`${collectionName}.${base} is missing; every collection carries id, scope_id and created`);
    }
  }

  return errors.length === 0
    ? { ok: true, schema: value as unknown as import("weftdb/schema").SchemaDefinition }
    : { ok: false, errors };
}

/**
 * `defineSchema` throws on all three of these before a schema can be built, but `loadSchema` also
 * accepts a `.json` file for pipelines that would rather not execute project code, and that value
 * never passes through the DSL: it is cast to a `SchemaDefinition` after `validateSchemaJson`, so
 * this is the only thing standing between such a schema and a generated join that matches no row.
 * For a `.ts` schema it repeats a check the DSL has already made; for a `.json` one it is the whole
 * check, the two field names included.
 */
function validateRelationshipReferences(schema: import("weftdb/schema").SchemaDefinition): readonly string[] {
  const warnings: string[] = [];
  for (const [collectionName, collection] of Object.entries(schema.collections)) {
    for (const [relationshipName, relationship] of Object.entries(collection.relationships ?? {})) {
      const path = `${collectionName}.${relationshipName}`;
      const target = schema.collections[relationship.table];
      if (target === undefined) {
        warnings.push(`${path} references missing table ${relationship.table}`);
        continue;
      }
      if (!Object.hasOwn(collection.fields, relationship.localField)) {
        warnings.push(`${path} references missing field ${collectionName}.${relationship.localField}`);
      }
      if (!Object.hasOwn(target.fields, relationship.foreignField)) {
        warnings.push(`${path} references missing field ${relationship.table}.${relationship.foreignField}`);
      }
    }
  }
  return warnings;
}

async function writeOutput(path: string, output: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, output);
}

async function findDefaultSchema(): Promise<string | undefined> {
  for (const candidate of ["weft.schema.ts", "schema.ts", "weft.schema.json", "schema.json"]) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function requiredArg(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index === -1 || value === undefined) throw new Error(`missing ${name}`);
  return value;
}

function requiredRecordString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  // A snapshot's values are whatever JSON carried, so a collection or an array reaches here too.
  // `String(...)` would write '[object Object]' into the rehydrated database; the JSON shape the
  // value arrived in is at least the thing that was stored.
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replaceAll("'", "''")}'`;
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

// `file://${path}` is not a URL on Windows (`file://D:\weft\cli.ts`) and is wrong anywhere the
// path needs escaping, so the entry check goes through the proper conversion — otherwise the
// CLI is imported, runs nothing, and exits 0 as if it had worked.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
