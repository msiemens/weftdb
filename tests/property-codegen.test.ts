// Generated code, over schemas nobody wrote by hand. Everything about codegen has been checked
// against two or three schemas somebody thought of, which tests the schemas rather than the
// generator: the interesting inputs are the ones with names that collide once punctuation is
// dropped, collections that are event logs, fields that are nullable, derived or immutable, and
// tables whose names need quoting.
//
// What the generated artifacts have to be is checkable without reading them: the DDL has to be
// SQL that SQLite accepts and that produces the columns the types promise, the emitted names
// have to be unambiguous, and generating twice has to produce the same bytes.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import ts from "typescript";
import {
  generateArtifacts,
  generateBindings,
  generateClientAddMissingColumnDdl,
  generateClientDdl,
  lintAdditiveEvolution,
} from "weftdb/codegen";
import { defineSchema, S, schemaHash, type CollectionDefinition, type FieldDefinition } from "weftdb/schema";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";

const RUNS = Number(process.env["WEFT_CODEGEN_RUNS"] ?? 40);

const identifierArb = fc.constantFrom(
  "todos",
  "todo_events",
  // The pair that matters: two names that differ only in punctuation collapse to the same
  // camel case, and a generator that emits members named after them has to say so.
  "todoEvents",
  "notes",
  "note_s",
  "order",
  "select",
  "user data",
  "Items",
  "items",
);

const fieldNameArb = fc.constantFrom(
  "title",
  "body",
  "done",
  "count",
  "due_at",
  "dueAt",
  "payload",
  "rank",
  "user name",
  "first-name",
);
const enumValuesArb = fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}$/u), { minLength: 1, maxLength: 5 });

const fieldArb: fc.Arbitrary<FieldDefinition> = fc
  .record({
    type: fc.constantFrom("string" as const, "number" as const, "boolean" as const, "json" as const, "date" as const),
    nullable: fc.boolean(),
    merge: fc.constantFrom("lww" as const, "diff3" as const, "fracIndex" as const, "immutable" as const),
    retentionAnchor: fc.boolean(),
  })
  .map(({ type, nullable, merge, retentionAnchor }) => ({ type, nullable, merge, retentionAnchor }));

const collectionArb: fc.Arbitrary<CollectionDefinition> = fc
  .record({
    kind: fc.constantFrom("collection" as const, "eventLog" as const),
    fields: fc.dictionary(fieldNameArb, fieldArb, { minKeys: 1, maxKeys: 5, noNullPrototype: true }),
  })
  .map(({ kind, fields }) => (kind === "eventLog" ? S.eventLog(fields) : S.collection(fields)));

const schemaArb = fc
  .dictionary(identifierArb, collectionArb, { minKeys: 1, maxKeys: 4, noNullPrototype: true })
  .map((collections) => defineSchema(collections));

/**
 * The statements in generated SQL, with the comment lines stripped. Comments are removed line
 * by line rather than by dropping whatever chunk starts with one: generated SQL opens with a
 * comment and the first real statement follows it on the next line, so discarding the chunk
 * discards the statement too.
 */
function statements(ddl: string): readonly string[] {
  return ddl
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * A database of its own per schema. Sharing one and rewriting the statements to reach an
 * attached database would be testing the rewriting; what matters is whether the generated
 * statements run as written.
 */
function runSql(sql: string, into?: ReturnType<typeof openSqliteExecutor>): ReturnType<typeof openSqliteExecutor> {
  const executor = into ?? openSqliteExecutor(":memory:");
  for (const statement of statements(sql)) executor.run({ sql: statement, parameters: [] });
  return executor;
}

/** Names the generator cannot tell apart, which it refuses rather than generates. */
function generatedNames(schema: ReturnType<typeof defineSchema>): readonly string[] {
  return Object.keys(schema.collections).map((name) =>
    name
      .split(/[^A-Za-z0-9]/u)
      .filter((part) => part.length > 0)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(""),
  );
}

function parseDiagnostics(fileName: string, source: string): readonly string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (file as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  return diagnostics.map((diagnostic) => {
    const position = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return `${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  });
}

test("the client DDL is SQL that SQLite accepts, and declares every field, for any schema", () => {
  fc.assert(
    fc.property(schemaArb, (schema) => {
      // A schema whose names collide is refused rather than generated, which the test below
      // covers; this one is about the SQL for schemas that get that far.
      const names = generatedNames(schema);
      fc.pre(new Set(names).size === names.length);
      using executor = runSql(generateClientDdl(schema));
      for (const [table, collection] of Object.entries(schema.collections)) {
        const columns = new Set(
          executor.all({
            sql: "SELECT name FROM pragma_table_info(?)",
            parameters: [table],
            decode: (row) => String(row["name"]),
          }),
        );
        for (const field of Object.keys(collection.fields)) {
          assert.ok(columns.has(field), `${table}.${field} is in the schema but not in the table`);
        }
        // The base fields every collection carries, mandated by the framework rather than
        // declared per schema (§2).
        for (const base of ["id", "scope_id", "created"]) {
          assert.ok(columns.has(base), `${table} has no ${base} column`);
        }
      }
    }),
    { numRuns: RUNS },
  );
});

test("generating the same schema twice produces the same bytes", () => {
  fc.assert(
    fc.property(schemaArb, (schema) => {
      // Artifacts are committed, so a generator that varied between runs would show up as a
      // diff nobody made and a schema hash nobody changed. A schema it refuses has to be
      // refused the same way twice, for the same reason.
      assert.equal(schemaHash(schema), schemaHash(schema));
      let first: unknown;
      try {
        first = generateArtifacts(schema);
      } catch (error) {
        assert.throws(() => generateArtifacts(schema), { message: (error as Error).message });
        return;
      }
      assert.deepEqual(generateArtifacts(schema), first);
    }),
    { numRuns: RUNS },
  );
});

test("generated TypeScript artifacts parse for any schema the generator accepts", () => {
  fc.assert(
    fc.property(schemaArb, (schema) => {
      const names = generatedNames(schema);
      fc.pre(new Set(names).size === names.length);
      const artifacts = generateArtifacts(schema);

      for (const [fileName, source] of [
        ["internal-database.d.ts", artifacts.internalDatabaseDts],
        ["database.d.ts", artifacts.databaseDts],
        ["kysely.d.ts", artifacts.kyselyDatabaseDts],
        ["mutators.ts", artifacts.mutatorsTs],
        ["bindings.ts", artifacts.bindingsTs],
        ["relationships.ts", artifacts.relationshipsTs],
        ["nested-mappers.ts", artifacts.nestedMappersTs],
      ] as const) {
        assert.deepEqual(parseDiagnostics(fileName, source), [], `${fileName} is not syntactically valid TypeScript`);
      }
    }),
    { numRuns: RUNS },
  );
});

test("the emitted names are unambiguous, or generating refuses", () => {
  fc.assert(
    fc.property(schemaArb, (schema) => {
      const names = Object.keys(schema.collections);
      // `todo_events` and `todoEvents` are different tables that produce the same member name.
      // Emitting both would silently give one of them the other's query, decoder and hook, so
      // the generator has to refuse rather than pick. The collision is computed the way the
      // generator names things — capitalise each punctuation-separated part and join — because
      // a cruder rule would demand a refusal for names it has no trouble telling apart.
      const collapsed = new Set(generatedNames(schema));
      if (collapsed.size === names.length) {
        const bindings = generateBindings(schema);
        const exported = [...bindings.matchAll(/^export (?:const|function|type) (\w+)/gmu)].map((match) => match[1]);
        assert.equal(
          new Set(exported).size,
          exported.length,
          `the bindings declare a name twice: ${exported.join(", ")}`,
        );
        return;
      }
      assert.throws(
        () => generateBindings(schema),
        /same name/u,
        `two collections collapse to one member name and the generator emitted both anyway: ${names.join(", ")}`,
      );
    }),
    { numRuns: RUNS },
  );
});

test("an additive change lints clean and missing-column DDL reconciles the existing table", () => {
  fc.assert(
    fc.property(schemaArb, fieldNameArb, fieldArb, (schema, extraField, definition) => {
      const names = generatedNames(schema);
      fc.pre(new Set(names).size === names.length);
      const [first] = Object.keys(schema.collections);
      if (first === undefined) return;
      const collection = schema.collections[first];
      if (collection === undefined || extraField in collection.fields) return;

      const extended = defineSchema(
        {
          ...schema.collections,
          [first]: { ...collection, fields: { ...collection.fields, [extraField]: definition } },
        },
        schema.schemaVersion + 1,
      );

      assert.deepEqual(lintAdditiveEvolution(schema, extended), [], "adding a field was reported as a breaking change");

      using executor = runSql(generateClientDdl(schema));
      const columnsBefore = new Set(
        executor.all({
          sql: "SELECT name FROM pragma_table_info(?)",
          parameters: [first],
          decode: (row) => String(row["name"]),
        }),
      );
      runSql(
        generateClientAddMissingColumnDdl(
          first,
          extended.collections[first] as CollectionDefinition,
          columnsBefore,
        ).join("\n"),
        executor,
      );
      const columns = new Set(
        executor.all({
          sql: "SELECT name FROM pragma_table_info(?)",
          parameters: [first],
          decode: (row) => String(row["name"]),
        }),
      );
      assert.ok(columns.has(extraField), `schema reconciliation did not add ${first}.${extraField}`);
    }),
    { numRuns: RUNS },
  );
});

test("changing enum values changes the schema hash", () => {
  fc.assert(
    fc.property(enumValuesArb, enumValuesArb, (firstValues, secondValues) => {
      fc.pre(JSON.stringify(firstValues) !== JSON.stringify(secondValues));
      const first = defineSchema({ todos: S.collection({ status: S.enum(firstValues as [string, ...string[]]) }) });
      const second = defineSchema({ todos: S.collection({ status: S.enum(secondValues as [string, ...string[]]) }) });

      assert.notEqual(schemaHash(first), schemaHash(second), "enum values changed without changing the schema hash");
    }),
    { numRuns: RUNS },
  );
});

test("changing enum values is not an additive-compatible schema change", () => {
  fc.assert(
    fc.property(enumValuesArb, enumValuesArb, (firstValues, secondValues) => {
      fc.pre(JSON.stringify(firstValues) !== JSON.stringify(secondValues));
      const first = defineSchema({ todos: S.collection({ status: S.enum(firstValues as [string, ...string[]]) }) });
      const second = defineSchema({ todos: S.collection({ status: S.enum(secondValues as [string, ...string[]]) }) });

      assert.notDeepEqual(
        lintAdditiveEvolution(first, second),
        [],
        "changing enum values was reported as an additive-compatible schema change",
      );
    }),
    { numRuns: RUNS },
  );
});

test("removing anything is reported as the breaking change it is", () => {
  fc.assert(
    fc.property(schemaArb, (schema) => {
      const [first, ...rest] = Object.keys(schema.collections);
      if (first === undefined) return;
      const collection = schema.collections[first];
      const fields = Object.keys(collection?.fields ?? {});
      fc.pre(fields.length > 1);
      const [dropped, ...kept] = fields;
      if (dropped === undefined || collection === undefined) return;

      const shrunk = defineSchema({
        ...Object.fromEntries(rest.map((name) => [name, schema.collections[name] as CollectionDefinition])),
        [first]: {
          ...collection,
          fields: Object.fromEntries(kept.map((name) => [name, collection.fields[name] as FieldDefinition])),
        },
      });
      const issues = lintAdditiveEvolution(schema, shrunk);
      assert.ok(
        issues.some((issue) => issue.code === "removed_field"),
        `dropping ${first}.${dropped} was not reported as removing a field`,
      );
    }),
    { numRuns: RUNS },
  );
});
