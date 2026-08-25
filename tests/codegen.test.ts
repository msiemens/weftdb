import assert from "node:assert/strict";
import { test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import {
  generateArtifacts,
  generateBindings,
  generateNestedMappers,
  generateRelationshipHelpers,
  lintAdditiveEvolution,
} from "weftdb/codegen";
import { SqliteClientStore } from "weftdb/client/sqlite";
import type { SqlExecutor, SqlRow } from "weftdb/shared";
import { defineSchema, S } from "weftdb/schema";

/** The smallest executor that is really SQLite, and really one statement per call. */
function executorOver(database: DatabaseSync): SqlExecutor {
  return {
    all: (statement) =>
      database
        .prepare(statement.sql)
        .all(...statement.parameters)
        .map((row) => statement.decode(row as SqlRow)),
    get: (statement) => {
      const row = database.prepare(statement.sql).get(...statement.parameters);
      return row === undefined ? undefined : statement.decode(row);
    },
    run: (statement) => {
      database.prepare(statement.sql).run(...statement.parameters);
    },
    transaction: (body) => body(),
  };
}

/** What SQLite says a column was declared as, which is what reconciliation would have to change. */
function declaredType(database: DatabaseSync, table: string, column: string): string | undefined {
  const rows = database.prepare("SELECT name, type FROM pragma_table_info(?)").all(table);
  const found = rows.find((row) => String((row as Record<string, unknown>)["name"]) === column);
  return found === undefined ? undefined : String((found as Record<string, unknown>)["type"]);
}

test("evolution lint rejects non-additive schema changes", () => {
  const from = defineSchema(
    {
      tasks: S.collection({
        title: S.string(),
        status: S.string({ nullable: true }),
      }),
    },
    1,
  );
  const to = defineSchema(
    {
      tasks: S.collection({
        title: S.number(),
        status: S.string(),
      }),
    },
    2,
  );

  assert.deepEqual(
    lintAdditiveEvolution(from, to).map((issue) => issue.code),
    ["changed_field_type", "field_became_required"],
  );
});

test("changing a field's type leaves the column a device already has as it was", () => {
  // Reconciliation on open adds the columns a local database is missing and decides what is
  // missing by name alone. A field whose `type` changed still has a column, so nothing is added
  // and nothing is altered: the column keeps the storage class the old schema declared while the
  // device writes the new type into it, which SQLite's affinity rules accept without complaint.
  //
  // Pinned rather than endorsed. Teaching reconciliation to migrate a column fails this test, and
  // the safety table in the schema-changes guide changes with it.
  const before = defineSchema({ tasks: S.collection({ count: S.number() }) }, 1);
  const after = defineSchema({ tasks: S.collection({ count: S.string() }) }, 2);

  using database = new DatabaseSync(":memory:");
  new SqliteClientStore(executorOver(database), before).installSchema();
  assert.equal(declaredType(database, "tasks", "count"), "INTEGER", "the first install is already wrong");

  // The same device, opening on the build that changed the type.
  new SqliteClientStore(executorOver(database), after).installSchema();

  assert.equal(
    declaredType(database, "tasks", "count"),
    "INTEGER",
    "reconciliation migrated the column, so the schema-changes guide now understates what is safe",
  );

  // The lint is the only thing that reports it, and nothing runs the lint automatically.
  assert.deepEqual(
    lintAdditiveEvolution(before, after).map((issue) => issue.code),
    ["changed_field_type"],
  );
});

test("artifact set includes mutators, Kysely types, relationships, and nested mappers", () => {
  const schema = defineSchema({
    calorie_entries: S.collection(
      {
        nutrition__sodium: S.number({ nullable: true }),
        manual_calorie_override: S.number({ nullable: true }),
      },
      {
        food_items: S.hasMany("food_items", "id", "entry_id"),
      },
    ),
    food_items: S.collection({
      entry_id: S.string(),
      calories: S.number(),
    }),
  });

  const artifacts = generateArtifacts(schema);
  assert.match(artifacts.kyselyDatabaseDts, /ColumnType/u);
  assert.match(artifacts.mutatorsTs, /CalorieEntriesMutation/u);
  assert.match(artifacts.relationshipsTs, /calorie_entries_food_itemsRelation/u);
  assert.match(artifacts.nestedMappersTs, /mapCalorieEntriesRow/u);
  assert.equal(generateRelationshipHelpers(schema), artifacts.relationshipsTs);
  assert.equal(generateNestedMappers(schema), artifacts.nestedMappersTs);
});

test("has-one relationship helpers emit valid TypeScript result types", () => {
  const schema = defineSchema({
    tasks: S.collection(
      {
        owner_id: S.string(),
      },
      {
        owner: S.hasOne("users", "owner_id", "id"),
      },
    ),
    users: S.collection({
      name: S.string(),
    }),
  });

  assert.deepEqual(typeDiagnostics("relationships.ts", generateRelationshipHelpers(schema)), []);
});

test("relationship helper names are unambiguous after generation", () => {
  const distinct = defineSchema({
    tasks: S.collection({ owner_id: S.string() }, { owner: S.hasOne("users", "owner_id", "id") }),
    users: S.collection({ name: S.string() }, { tasks: S.hasMany("tasks", "id", "owner_id") }),
  });
  assert.deepEqual(typeDiagnostics("relationships.ts", generateRelationshipHelpers(distinct)), []);

  // `a_b.c` and `a.b_c` both read as `a_b_cRelation`, and no separator escapes it because a table
  // may contain whichever separator the join uses. Emitting both would redeclare the helper and
  // its result type, so the pair is refused by name — the same answer two collections that
  // generate one name already get.
  const colliding = defineSchema({
    a_b: S.collection({}, { c: S.hasOne("x", "id", "id") }),
    a: S.collection({}, { b_c: S.hasOne("x", "id", "id") }),
    x: S.collection({}),
  });
  assert.throws(() => generateRelationshipHelpers(colliding), /generate the same name/u);
});

test("nested mappers share helper definitions without redeclaring them", () => {
  const schema = defineSchema({
    alpha: S.collection({ one__two: S.string() }),
    beta: S.collection({ three__four: S.string() }),
  });

  assert.deepEqual(typeDiagnostics("nested-mappers.ts", generateNestedMappers(schema)), []);
});

test("an enum field is worth its values everywhere they can be enforced", () => {
  const schema = defineSchema({
    todos: S.collection({
      status: S.enum(["open", "doing", "done"]),
      priority: S.enum(["low", "high"], { nullable: true }),
    }),
  });
  const artifacts = generateArtifacts(schema);

  // In the row type, as a union rather than `string`.
  assert.match(artifacts.databaseDts, /status: "open" \| "doing" \| "done";/u);
  assert.match(artifacts.databaseDts, /priority: "low" \| "high" \| null;/u);
  assert.match(artifacts.mutatorsTs, /readonly status\?: "open" \| "doing" \| "done";/u);

  // In the database, as a constraint, so a row written by anything that is not this build
  // still cannot hold a value the schema forbids.
  assert.match(artifacts.clientDdl, /CHECK \("status" IN \('open', 'doing', 'done'/u);
  assert.match(artifacts.clientDdl, /"priority" IS NULL/u);

  // And in the decoder, which reads anything else as absent rather than returning a value that
  // is not a member of the union it promises.
  const bindings = generateBindings(schema);
  assert.match(bindings, /\["open", "doing", "done"\] as unknown\[\]\)\.includes/u);
  assert.match(bindings, /: "open"/u, "a non-nullable enum falls back to something outside its own values");
});

test("an enum cannot be declared with a value twice", () => {
  assert.throws(() => S.enum(["open", "open"]), /repeat/u);
});

test("bindings give an application a hook, a decoder and mutators per collection", () => {
  const schema = defineSchema({
    todo_items: S.collection({
      title: S.string(),
      done: S.boolean(),
      due_at: S.number({ nullable: true }),
    }),
    todo_events: S.eventLog({ kind: S.string() }),
  });

  const bindings = generateBindings(schema);
  assert.equal(bindings, generateArtifacts(schema).bindingsTs);

  // Names are the ones a person would write by hand, not the raw table names.
  for (const expected of ["todoItemsTable", "todoItemsQuery", "decodeTodoItems", "todoItemsMutators", "useTodoItems"]) {
    assert.match(bindings, new RegExp(`export (const|function) ${expected}\\b`, "u"), `missing ${expected}`);
  }
  assert.doesNotMatch(bindings, /todo_itemsQuery/u, "a generated member kept its snake_case table name");

  // The query names every field the row type promises, so a decoded row is never half-built.
  assert.match(
    bindings,
    /fields: \[fieldName\("id"\), fieldName\("scope_id"\), fieldName\("created"\), fieldName\("title"\)/u,
  );
  assert.match(bindings, /orderBy: TodoItemsField = "id"/u);
  assert.match(
    bindings,
    /export type TodoItemsField = "id" \| "scope_id" \| "created" \| "title" \| "done" \| "due_at"/u,
  );

  // Decoding follows the declared type: a boolean is not a truthy string, and a nullable
  // number is null rather than zero when the field has never been written.
  assert.match(bindings, /done: row\.fields\.get\(fieldName\("done"\)\) === true,/u);
  assert.match(bindings, /due_at: typeof row\.fields\.get\(fieldName\("due_at"\)\) === "number" \? .* : null,/u);
  assert.match(bindings, /title: typeof row\.fields\.get\(fieldName\("title"\)\) === "string" \? .* : '',/u);

  // Append-only rows are written once, so the generated surface offers no way to change one.
  const events = bindings.slice(bindings.indexOf("--- todo_events"));
  assert.match(events, /client\.append\(todoEventsTable/u);
  assert.doesNotMatch(events, /client\.update\(/u, "an event log was given an update mutator");
  assert.doesNotMatch(events, /client\.delete\(/u, "an event log was given a delete mutator");
});

// Compiled against the real standard library. Without it every use of `Array`, `length` or an
// index signature is reported as a missing global, and the diagnostics that matter — a redeclared
// helper, a type modifier where none is allowed — have to be picked out of that noise by hand,
// which is how a genuine error gets filtered away with the artifacts.
const TYPE_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  skipLibCheck: true,
};

// `lib.es2022.d.ts` and everything it references is a megabyte of declarations, and parsing it
// again for each generated file costs more than a minute per test. It does not change between
// them, so it is parsed once and the same syntax trees are handed to every program.
const libraryFiles = new Map<string, ts.SourceFile | undefined>();

function typeDiagnostics(fileName: string, source: string): readonly string[] {
  const options = TYPE_OPTIONS;
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (requested === fileName) return ts.createSourceFile(fileName, source, languageVersion, true);
    if (libraryFiles.has(requested)) return libraryFiles.get(requested);
    const parsed = originalGetSourceFile(requested, languageVersion, onError, shouldCreateNewSourceFile);
    libraryFiles.set(requested, parsed);
    return parsed;
  };
  host.readFile = (requested) => (requested === fileName ? source : ts.sys.readFile(requested));
  host.fileExists = (requested) => requested === fileName || ts.sys.fileExists(requested);
  const program = ts.createProgram([fileName], options, host);
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map((diagnostic) => {
    const file = diagnostic.file;
    if (file === undefined || diagnostic.start === undefined)
      return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    const position = file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  });
}
