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
import { defineSchema, S, schemaHash, type DatabaseOf, type SchemaDefinition } from "weftdb/schema";

test("the generated query builder scopes its statement and selects the id the engine reads", () => {
  const bindings = generateBindings(defineSchema({ todos: S.collection({ title: S.string() }) }));
  // Scoping is applied before the caller's callback runs, so an application cannot write a
  // statement that ranges past its own scope: one database file holds every scope.
  assert.match(bindings, /selectFrom\("todos"\)\.select\("id"\)\.where\("scope_id", "=", scopeId\)/u);
  assert.match(bindings, /build: TodosQueryBuilder = \(statement\) => statement/u);
  assert.match(bindings, /export function useTodosQuery\(source: WeftSqlSource/u);
});

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
    invoices: S.collection(
      {
        totals__tax: S.number({ nullable: true }),
        total_override: S.number({ nullable: true }),
      },
      {
        line_items: S.hasMany("line_items", "id", "invoice_id"),
      },
    ),
    line_items: S.collection({
      invoice_id: S.string(),
      amount: S.number(),
    }),
  });

  const artifacts = generateArtifacts(schema);
  assert.match(artifacts.kyselyDatabaseDts, /ColumnType/u);
  assert.match(artifacts.mutatorsTs, /InvoicesMutation/u);
  assert.match(artifacts.relationshipsTs, /invoices_line_itemsRelation/u);
  assert.match(artifacts.nestedMappersTs, /mapInvoicesRow/u);
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

  assert.deepEqual(
    typeDiagnostics("relationships.ts", generateRelationshipHelpers(schema), relationshipSiblings(schema)),
    [],
  );
});

test("a relationship result is the row type of the collection it names", () => {
  const schema = defineSchema({
    tasks: S.collection({ owner_id: S.string() }, { owner: S.hasOne("users", "owner_id", "id") }),
    users: S.collection({ name: S.string() }, { tasks: S.hasMany("tasks", "id", "owner_id") }),
  });
  const relationships = generateRelationshipHelpers(schema);

  // The schema already says which collection is on the far side, so `unknown` was a fact the
  // generator held and declined to write down — and every application reading a relation result
  // had to assert it back.
  assert.match(relationships, /export type UsersTasksResult = readonly Database\["tasks"\]\[\];/u);
  assert.match(relationships, /export type TasksOwnerResult = Database\["users"\] \| null;/u);
  assert.match(relationships, /^import type \{ Database \} from "\.\/database\.d\.ts";/u);
  assert.deepEqual(typeDiagnostics("relationships.ts", relationships, relationshipSiblings(schema)), []);
});

test("a relationship naming a collection the schema does not define stays unknown", () => {
  // Unreachable through `defineSchema`, which now refuses this schema outright — in both senses,
  // since the literal below is a compile error as well as a throw. It is written by hand here
  // because generation still has to tolerate a `SchemaDefinition` that reached it another way: a
  // `.json` schema loaded by the CLI never passes through `defineSchema`, and `Database["absent"]`
  // would turn `weft doctor`'s warning into a file that does not compile.
  const schema: SchemaDefinition = {
    schemaVersion: 1,
    collections: {
      tasks: S.collection({ owner_id: S.string() }, { owner: S.hasOne("users", "owner_id", "id") }),
    },
  };
  const relationships = generateRelationshipHelpers(schema);

  assert.match(relationships, /export type TasksOwnerResult = unknown \| null;/u);
  assert.doesNotMatch(relationships, /import type \{ Database \}/u, "an import nothing uses was emitted");
  assert.deepEqual(typeDiagnostics("relationships.ts", relationships), []);
});

test("relationship helper names are unambiguous after generation", () => {
  const distinct = defineSchema({
    tasks: S.collection({ owner_id: S.string() }, { owner: S.hasOne("users", "owner_id", "id") }),
    users: S.collection({ name: S.string() }, { tasks: S.hasMany("tasks", "id", "owner_id") }),
  });
  assert.deepEqual(
    typeDiagnostics("relationships.ts", generateRelationshipHelpers(distinct), relationshipSiblings(distinct)),
    [],
  );

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

test("a relationship is refused unless all three of its names resolve", () => {
  // A relationship is three names into the rest of the schema, and none of them used to be
  // checked. The join matched no row at runtime, and the result type quietly degraded to
  // `unknown` — a typo that got quieter rather than louder the more the generator learned.
  assert.throws(
    () =>
      defineSchema({
        projects: S.collection({ name: S.string() }, { issues: S.hasMany("issus" as "issues", "id", "project_id") }),
        issues: S.collection({ project_id: S.string() }),
      }),
    /projects\.issues joins to "issus", which this schema does not define/u,
  );

  assert.throws(
    () =>
      defineSchema({
        projects: S.collection({ name: S.string() }, { issues: S.hasMany("issues", "idd" as "id", "project_id") }),
        issues: S.collection({ project_id: S.string() }),
      }),
    /projects\.issues joins on projects\."idd", which projects does not declare/u,
  );

  assert.throws(
    () =>
      defineSchema({
        projects: S.collection(
          { name: S.string() },
          { issues: S.hasMany("issues", "id", "projct_id" as "project_id") },
        ),
        issues: S.collection({ project_id: S.string() }),
      }),
    /projects\.issues joins on issues\."projct_id", which issues does not declare/u,
  );

  // A name inherited rather than declared is not a field: `Object.prototype` has a `toString` and
  // no collection has a `toString` column.
  assert.throws(
    () =>
      defineSchema({
        projects: S.collection({ name: S.string() }, { issues: S.hasMany("issues", "toString" as "id", "project_id") }),
        issues: S.collection({ project_id: S.string() }),
      }),
    /which projects does not declare/u,
  );

  // The base fields count, and a relationship may point back at the collection that declares it.
  assert.doesNotThrow(() =>
    defineSchema({
      projects: S.collection(
        { name: S.string(), parent_id: S.string() },
        { children: S.hasMany("projects", "id", "parent_id") },
      ),
    }),
  );
});

test("checking a relationship leaves the schema hash where it was", () => {
  // Which collection a join names is a local concern: no row travels differently for it, and the
  // hash is protocol visible, so two devices that disagreed about it would force a resync over a
  // change neither can see.
  const schema = defineSchema({
    projects: S.collection({ name: S.string() }, { issues: S.hasMany("issues", "id", "project_id") }),
    issues: S.collection({ project_id: S.string() }, { project: S.hasOne("projects", "project_id", "id") }),
  });
  assert.equal(schemaHash(schema), "ce3a07d5822456de3215663995eadadc9c9796c901bd01b4771be067ee7cee21");
});

test("a relationship that names something the schema does not have is a compile error", () => {
  // The runtime check is the safety net; this is the point of the exercise. `S.hasMany` keeps its
  // three arguments as the literals they were written as, so `defineSchema` can hold each one to
  // the names that would actually resolve.
  const schema = (relationship: string): string =>
    [
      'import { defineSchema, S } from "weftdb/schema";',
      "export const schema = defineSchema({",
      `  projects: S.collection({ name: S.string() }, { issues: ${relationship} }),`,
      "  issues: S.collection({ project_id: S.string() }),",
      "});",
    ].join("\n");

  assert.deepEqual(
    typeDiagnostics("schema.ts", schema('S.hasMany("issues", "id", "project_id")')),
    [],
    "a correct schema stopped compiling",
  );

  // Each one names the offending string and the names it could have been, rather than unrolling
  // the whole collection type: a constraint whose failure is unreadable is worse than none.
  assert.match(
    typeDiagnostics("schema.ts", schema('S.hasMany("issus", "id", "project_id")')).join("\n"),
    /Type '"issus"' is not assignable to type '"projects" \| "issues"'/u,
  );
  assert.match(
    typeDiagnostics("schema.ts", schema('S.hasMany("issues", "idd", "project_id")')).join("\n"),
    /'relationships\.issues\.localField'[\s\S]*Type '"idd"' is not assignable to type '(?=[^\n]*"name")/u,
  );
  assert.match(
    typeDiagnostics("schema.ts", schema('S.hasMany("issues", "id", "projct_id")')).join("\n"),
    /'relationships\.issues\.foreignField'[\s\S]*Type '"projct_id"' is not assignable to type '(?=[^\n]*"project_id")/u,
  );
});

test("a schema that declares no relationship is inferred exactly as it was", () => {
  // The constraint rides on `defineSchema`'s parameter and mentions only `relationships`, so a
  // schema without any is constrained by nothing. Inference is what every generated type is built
  // out of, and a constraint that flattened it would cost far more than it caught.
  const schema = defineSchema({
    todos: S.collection({ title: S.string(), done: S.boolean() }),
  });
  const row: DatabaseOf<typeof schema>["todos"] = {
    id: "1",
    scope_id: "s",
    created: "2026-01-01T00:00:00.000Z",
    title: "write it down",
    done: false,
  };
  // Every field the schema declares, at the type the schema declares it — none of which survives
  // if `Collections` is inferred as anything wider than the literal it was written as.
  assert.deepEqual(Object.keys(schema.collections["todos"]?.fields ?? {}), [
    "id",
    "scope_id",
    "created",
    "title",
    "done",
  ]);
  assert.equal(row.title, "write it down");
  assert.equal(row.done, false);
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

/** The one file `relationships.ts` imports: the row types `weft generate` writes beside it. */
function relationshipSiblings(schema: SchemaDefinition): Readonly<Record<string, string>> {
  return { "database.d.ts": generateArtifacts(schema).databaseDts };
}

/** An application's own type for what a json field holds — an interface, as one usually is. */
const LABEL_MODULE = [
  "export interface Label {",
  "  readonly text: string;",
  "  readonly weights: readonly number[];",
  "}",
].join("\n");

test("a json field is worth the type the schema declares for it", () => {
  const schema = defineSchema({
    cards: S.collection({
      label: S.json({ as: "Label", from: "./types.ts" }),
      sketch: S.json({ as: "readonly string[]", nullable: true }),
      freeform: S.json(),
    }),
  });
  const artifacts = generateArtifacts(schema);

  // In the row type and the mutation type, so neither reading the field nor writing it costs an
  // application a cast. A type expression that needs no import is written as it stands.
  assert.match(artifacts.databaseDts, /^import type \{ Label \} from "\.\/types\.ts";/u);
  assert.match(artifacts.databaseDts, /label: Label;/u);
  assert.match(artifacts.databaseDts, /sketch: readonly string\[\] \| null;/u);
  assert.match(artifacts.mutatorsTs, /readonly label\?: Label;/u);
  assert.match(artifacts.kyselyDatabaseDts, /label: ColumnType<Label, Label, Label \| undefined>;/u);

  // Declaring nothing is still `unknown`: a field whose shape the schema does not fix has no
  // more honest type, and every schema written before this option existed depends on it.
  assert.match(artifacts.databaseDts, /freeform: unknown;/u);
  assert.match(artifacts.mutatorsTs, /readonly freeform\?: unknown;/u);

  // The decoder asserts through `unknown`, because the wire carries a `WireValue` and neither it
  // nor a named type is assignable to the other.
  assert.match(
    artifacts.bindingsTs,
    /label: \(row\.fields\.get\(fieldName\("label"\)\) \?\? ''\) as unknown as Label,/u,
  );
  assert.match(artifacts.bindingsTs, /freeform: \(row\.fields\.get\(fieldName\("freeform"\)\) \?\? ''\) as unknown,/u);
});

test("a declared json type is checked against what JSON can carry", () => {
  const schema = defineSchema({ cards: S.collection({ label: S.json({ as: "Label", from: "./types.ts" }) }) });

  // A json value is stored with `encodeWireValue`, so a type JSON cannot carry describes a field
  // that throws on its first write. The bindings instantiate the check, so the declaration fails
  // to compile rather than failing at runtime on a device somebody is using.
  const bindings = generateArtifacts(schema).bindingsTs;
  assert.match(bindings, /type WeftJsonCheck1 = WeftDeclaredJson<Label, WeftJsonCarriable<Label>>;/u);

  // The guard alone, lifted out of the bindings: the rest of the file names a client and a React
  // hook that only the real module graph resolves, and neither is what is under test here.
  const guard = bindings.slice(
    bindings.indexOf("type WeftJsonCarriable"),
    bindings.indexOf("\n", bindings.indexOf("type WeftJsonCheck1")),
  );
  const declare = (label: string): readonly string[] =>
    typeDiagnostics(
      "check.ts",
      ['import type { WireValue } from "weftdb/core";', 'import type { Label } from "./types.ts";', guard].join("\n"),
      { "types.ts": label },
    );

  assert.deepEqual(declare(LABEL_MODULE), [], "a plain interface was refused for lacking an index signature");
  assert.notDeepEqual(
    declare(LABEL_MODULE.replace("readonly text: string;", "readonly when: Date;")),
    [],
    "a Date reduces to methods and has no wire form, and was accepted anyway",
  );
});

test("a declared json type is read and written without a cast", () => {
  const schema = defineSchema({ cards: S.collection({ label: S.json({ as: "Label", from: "./types.ts" }) }) });
  const artifacts = generateArtifacts(schema);

  // The point of the whole option, stated as the application that would otherwise need the two
  // casts: one to read the field as anything but `unknown`, one to write a value the mutation
  // type is willing to accept.
  const application = [
    'import type { Database } from "./database.d.ts";',
    'import type { CardsMutation } from "./mutators.ts";',
    'import type { Label } from "./types.ts";',
    "export function text(card: Database['cards']): string {",
    "  return card.label.text;",
    "}",
    "export function relabel(label: Label): CardsMutation {",
    "  return { label };",
    "}",
  ].join("\n");

  assert.deepEqual(
    typeDiagnostics("application.ts", application, {
      "database.d.ts": artifacts.databaseDts,
      "mutators.ts": artifacts.mutatorsTs,
      "types.ts": LABEL_MODULE,
    }),
    [],
  );
});

test("a declared json type does not reach the schema hash", () => {
  // Two devices have to agree about which writes are legal, and a json field carries a
  // `WireValue` whatever name one device's generated code puts on it. Hashing the name would make
  // a device that only renamed a TypeScript type look like a device on another schema, and force
  // a resync for a change no row can tell apart.
  const bare = defineSchema({ cards: S.collection({ label: S.json() }) });
  const declared = defineSchema({ cards: S.collection({ label: S.json({ as: "Label", from: "./types.ts" }) }) });

  assert.equal(schemaHash(declared), schemaHash(bare));
  assert.deepEqual(lintAdditiveEvolution(bare, declared), []);
});

test("two json types cannot share a name", () => {
  // The generated file has one namespace, so the second import would land on top of the first and
  // silently give one collection the other's type.
  const colliding = defineSchema({
    cards: S.collection({ label: S.json({ as: "Label", from: "./cards.ts" }) }),
    tickets: S.collection({ label: S.json({ as: "Label", from: "./tickets.ts" }) }),
  });
  assert.throws(() => generateArtifacts(colliding), /both named "Label"/u);

  // The same name from the same module is one import, not a collision.
  const shared = defineSchema({
    cards: S.collection({ label: S.json({ as: "Label", from: "./types.ts" }) }),
    tickets: S.collection({ label: S.json({ as: "Label", from: "./types.ts" }) }),
  });
  const imports = generateArtifacts(shared)
    .databaseDts.split("\n")
    .filter((line) => line.startsWith("import"));
  assert.deepEqual(imports, ['import type { Label } from "./types.ts";']);
});

test("a json type that has to be imported has to be an identifier", () => {
  // It is written verbatim into `import type { … }`, where an expression does not parse.
  assert.throws(() => S.json({ as: "readonly string[]", from: "./types.ts" }), /single identifier/u);
  assert.throws(() => S.json({ as: "  ", from: "./types.ts" }), /cannot be empty/u);
  // Without an import there is nothing to parse it into, so an expression is fine.
  assert.doesNotThrow(() => S.json({ as: "Record<string, number>" }));
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
  // The generated files name types from `weftdb` itself, which only resolves through the
  // workspace's own `node_modules`; the sibling files a generated directory holds are supplied
  // in memory and intercepted before resolution sees them.
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
};

// `lib.es2022.d.ts` and everything it references is a megabyte of declarations, and parsing it
// again for each generated file costs more than a minute per test. It does not change between
// them, so it is parsed once and the same syntax trees are handed to every program.
const libraryFiles = new Map<string, ts.SourceFile | undefined>();

/**
 * Compiles one generated file, with whichever of its siblings it imports supplied alongside it.
 * `weft generate` writes a directory, not a file: `relationships.ts` names the row types in
 * `database.d.ts`, so checking it in isolation would be checking a file that does not exist.
 */
function typeDiagnostics(
  fileName: string,
  source: string,
  siblings: Readonly<Record<string, string>> = {},
): readonly string[] {
  const options = TYPE_OPTIONS;
  const files = new Map<string, string>([[fileName, source], ...Object.entries(siblings)]);
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, languageVersion, onError, shouldCreateNewSourceFile) => {
    const own = files.get(requested);
    if (own !== undefined) return ts.createSourceFile(requested, own, languageVersion, true);
    if (libraryFiles.has(requested)) return libraryFiles.get(requested);
    const parsed = originalGetSourceFile(requested, languageVersion, onError, shouldCreateNewSourceFile);
    libraryFiles.set(requested, parsed);
    return parsed;
  };
  host.readFile = (requested) => files.get(requested) ?? ts.sys.readFile(requested);
  host.fileExists = (requested) => files.has(requested) || ts.sys.fileExists(requested);
  // The generated specifiers are relative and carry their real extension, which no built-in
  // resolution mode reads from an in-memory file set; the map is the whole directory, so a
  // sibling resolves to itself and anything else falls through to the real resolver.
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions) =>
    literals.map((literal) => {
      const sibling = literal.text.replace(/^\.\//u, "");
      if (files.has(sibling)) {
        return {
          resolvedModule: {
            resolvedFileName: sibling,
            extension: sibling.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts,
          },
        };
      }
      return ts.resolveModuleName(literal.text, containingFile, compilerOptions, host, undefined, redirected);
    });
  const program = ts.createProgram([...files.keys()], options, host);
  // Reaching `weftdb` for the types the bindings name pulls its own sources into the program, and
  // what those say about themselves is the workspace's `tsc` to report, not this test's.
  const sources = [...files.keys()].map((name) => program.getSourceFile(name));
  return sources
    .flatMap((file) => [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)])
    .map((diagnostic) => {
      const file = diagnostic.file;
      if (file === undefined || diagnostic.start === undefined)
        return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      const position = file.getLineAndCharacterOfPosition(diagnostic.start);
      return `${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
    });
}
