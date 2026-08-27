import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import {
  generateArtifacts,
  generateBindings,
  generateClientDdl,
  generateMutators,
  generateNestedMappers,
  generateRelationshipHelpers,
  lintAdditiveEvolution,
} from "weftdb/codegen";
import { splitSql } from "#root/packages/weftdb/src/sql.ts";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { asyncSqlExecutor, type SqlExecutor, type SqlRow } from "weftdb/shared";
import { defineSchema, S, schemaHash, type DatabaseOf, type SchemaDefinition } from "weftdb/schema";

test("a field the schema marks indexed gets an index led by scope_id, and no other field does", async () => {
  const schema = defineSchema({
    todos: S.collection({ title: S.string(), done: S.boolean({ index: true }) }),
  });
  const ddl = generateClientDdl(schema);

  // Led by `scope_id` because every statement a device runs is scoped. One database file holds
  // every scope this device is signed into, so a query narrows by it before anything else.
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS "todos_done" ON "todos" \(scope_id, "done"\);/u);
  assert.doesNotMatch(ddl, /"todos_title"/u, "a field the schema said nothing about was indexed");
  // `IF NOT EXISTS`, because `installSchema` runs the whole DDL on every open.
  assert.deepEqual(
    splitSql(ddl).filter((statement) => statement.startsWith("CREATE INDEX")),
    ['CREATE INDEX IF NOT EXISTS "todos_done" ON "todos" (scope_id, "done")'],
    "the index did not come out of the script as a statement of its own",
  );
});

test("an index is invisible to the schema hash, so adding one syncs no differently", async () => {
  // The hash is what two devices refuse to sync across. An index is a fact about how one device
  // reads its own file, and a device that added one would otherwise look like a device on another
  // schema and force a resync for a change no row can tell apart.
  const plain = defineSchema({ todos: S.collection({ title: S.string(), done: S.boolean() }) });
  const indexed = defineSchema({ todos: S.collection({ title: S.string(), done: S.boolean({ index: true }) }) });
  assert.equal(schemaHash(indexed), schemaHash(plain));
  assert.deepEqual(lintAdditiveEvolution(plain, indexed), [], "adding an index was reported as a schema change");
});

test("the generated query builder scopes its statement and selects the id the engine reads", async () => {
  const bindings = generateBindings(defineSchema({ todos: S.collection({ title: S.string() }) }));
  // Scoping is applied before the caller's callback runs, so an application cannot write a
  // statement that ranges past its own scope. One database file holds every scope.
  assert.match(bindings, /selectFrom\("todos"\)\.select\("id"\)\.where\("scope_id", "=", scopeId\)/u);
  assert.match(bindings, /build: TodosQueryBuilder = \(statement\) => statement/u);
  assert.match(bindings, /export function useTodosQuery\(source: WeftSource/u);
});

test("the generated hooks name one source type, so a component never has to pick between two", async () => {
  const bindings = generateBindings(
    defineSchema({ todos: S.collection({ title: S.string() }), notes: S.collection({ body: S.string() }) }),
  );

  // Both read paths take the same source, so a component that starts with a row-map read is not
  // retyped when a later `where` turns it into a statement-backed one.
  assert.match(bindings, /export function useTodos\(source: WeftSource/u);
  assert.match(bindings, /export function useTodosQuery\(source: WeftSource/u);
  assert.match(bindings, /export function useNotes\(source: WeftSource/u);
  assert.match(bindings, /export function useNotesQuery\(source: WeftSource/u);
  // Re-exported, so the name in an application's imports is the name `weftdb-react` declares and
  // the two cannot drift.
  assert.match(bindings, /^import \{ useWeftRows, useWeftSqlRows, type WeftSource \} from "weftdb-react";$/mu);
  assert.match(bindings, /^export type \{ WeftSource \};$/mu);
  assert.doesNotMatch(bindings, /WeftSqlSource|QueryLifecycleSource|SqlQuerySource/u);
});

test("the json carriability checks are exported, so a strict consumer can still compile them", async () => {
  const bindings = generateBindings(
    defineSchema({ views: S.collection({ sort: S.json({ as: "SortConfig", from: "../types.ts" }) }) }),
  );

  // A type alias that is only ever declared is TS6196 under `noUnusedLocals`, which Vite's
  // React-TypeScript template turns on. Left local, these checks fail the build of the very
  // application they were generated for, and the only way out is to patch `export` in by hand
  // after every generate.
  assert.match(bindings, /export type WeftJsonCheck1 = WeftDeclaredJson<SortConfig, WeftJsonCarriable<SortConfig>>;/u);
  assert.doesNotMatch(bindings, /^type WeftJsonCheck/mu, "a check was emitted as a local type alias");
});

test("generated mutators take the transaction their caller wants them in", async () => {
  const mutators = generateMutators(
    defineSchema({
      todos: S.collection({ title: S.string() }),
      todo_events: S.eventLog({ todo_id: S.string() }),
    }),
  );

  // The relay applies a transaction as a unit, so two collections written together have to be able
  // to share one. Without this the only way to say so is the facade, and an application that
  // reaches for it to get atomicity loses the generated types on the way.
  assert.match(mutators, /create\(id: string, values: TodosMutation, txnId\?: TxnId\): Promise<void>;/u);
  assert.match(mutators, /update\(id: string, values: TodosMutation, txnId\?: TxnId\): Promise<void>;/u);
  assert.match(mutators, /delete\(id: string, txnId\?: TxnId\): Promise<void>;/u);
  // An event log has no update or delete, and its create takes one on the same terms.
  assert.match(mutators, /create\(id: string, values: TodoEventsMutation, txnId\?: TxnId\): Promise<void>;/u);
  assert.match(mutators, /^import type \{ TxnId \} from "weftdb\/core";/mu);
});

/** An executor backed by real SQLite, one statement per call. */
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

test("evolution lint rejects non-additive schema changes", async () => {
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

test("changing a field's type leaves the column a device already has as it was", async () => {
  // Reconciliation on open adds the columns a local database is missing and decides what is
  // missing by name alone. A field whose `type` changed still has a column, so nothing is added
  // and nothing is altered. The column keeps the storage class the old schema declared while the
  // device writes the new type into it, which SQLite's affinity rules accept without complaint.
  //
  // This test only pins current behavior. Teaching reconciliation to migrate a column fails it,
  // and the safety table in the schema-changes guide changes along with it.
  const before = defineSchema({ tasks: S.collection({ count: S.number() }) }, 1);
  const after = defineSchema({ tasks: S.collection({ count: S.string() }) }, 2);

  using database = new DatabaseSync(":memory:");
  await new SqliteClientStore(asyncSqlExecutor(executorOver(database)), before).installSchema();
  assert.equal(declaredType(database, "tasks", "count"), "INTEGER", "the first install is already wrong");

  // The same device, opening on the build that changed the type.
  await new SqliteClientStore(asyncSqlExecutor(executorOver(database)), after).installSchema();

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

test("artifact set includes mutators, Kysely types, relationships, and nested mappers", async () => {
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
  assert.match(artifacts.mutatorsTs, /InvoicesMutation/u);
  assert.match(artifacts.relationshipsTs, /invoices_line_itemsRelation/u);
  assert.match(artifacts.nestedMappersTs, /mapInvoicesRow/u);
  assert.equal(generateRelationshipHelpers(schema), artifacts.relationshipsTs);
  assert.equal(generateNestedMappers(schema), artifacts.nestedMappersTs);
});

test("has-one relationship helpers emit valid TypeScript result types", async () => {
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

test("a relationship result is the row type of the collection it names", async () => {
  const schema = defineSchema({
    tasks: S.collection({ owner_id: S.string() }, { owner: S.hasOne("users", "owner_id", "id") }),
    users: S.collection({ name: S.string() }, { tasks: S.hasMany("tasks", "id", "owner_id") }),
  });
  const relationships = generateRelationshipHelpers(schema);

  // The schema already says which collection is on the far side, so `unknown` would be a fact the
  // generator holds and declines to write down, leaving every application reading a relation
  // result to assert it back.
  assert.match(relationships, /export type UsersTasksResult<Target = Database\["tasks"\]> = readonly Target\[\];/u);
  assert.match(relationships, /export type TasksOwnerResult<Target = Database\["users"\]> = Target \| undefined;/u);
  assert.match(relationships, /^import type \{ Database \} from "\.\/database\.d\.ts";/u);
  assert.deepEqual(typeDiagnostics("relationships.ts", relationships, relationshipSiblings(schema)), []);
});

/** The smallest schema with a `hasMany` and a `hasOne`, joining a parent and a child both ways. */
const JOINED = defineSchema({
  projects: S.collection({ name: S.string() }, { issues: S.hasMany("issues", "id", "project_id") }),
  issues: S.collection(
    { project_id: S.string(), title: S.string() },
    { project: S.hasOne("projects", "project_id", "id") },
  ),
});

interface ProjectRow {
  readonly id: string;
  readonly name: string;
}

interface IssueRow {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
}

type IssuesOfProject = (targets: readonly IssueRow[]) => (source: { readonly id: string }) => readonly IssueRow[];
type ProjectOfIssue = (
  targets: readonly ProjectRow[],
) => (source: { readonly project_id: string }) => ProjectRow | undefined;

const PROJECTS: readonly ProjectRow[] = [
  { id: "p1", name: "Loom firmware" },
  { id: "p2", name: "Weaving room" },
];

const ISSUES: readonly IssueRow[] = [
  { id: "i1", project_id: "p1", title: "Shuttle stalls" },
  { id: "i2", project_id: "p1", title: "Tension drifts" },
  { id: "i3", project_id: "p2", title: "Re-thread the beam" },
];

/**
 * The generated relationship module runs here, because an index built once and reused is
 * behaviour, and text is all a diagnostic can see.
 *
 * `import type` is erased by transpilation, so what is left has no imports and the whole file is
 * a module body, which the wrapper turns into a function of its own `exports`. The rest of this
 * suite checks generated text against a compiler; this function executes it in this context
 * instead, so the arrays the module builds share the same `Array.prototype` as the ones asserted
 * against them.
 */
function relationshipModule(schema: SchemaDefinition): Readonly<Record<string, unknown>> {
  const transpiled = ts.transpileModule(generateRelationshipHelpers(schema), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const body = vm.runInThisContext(`(function (exports) {\n${transpiled}\n})`) as (
    exports: Record<string, unknown>,
  ) => void;
  const exported: Record<string, unknown> = {};
  body(exported);
  return exported;
}

test("a generated accessor relates a parent to its children and a child back to its parent", async () => {
  const generated = relationshipModule(JOINED);
  const issuesOf = (generated["projects_issuesRelation"] as IssuesOfProject)(ISSUES);
  const projectOf = (generated["issues_projectRelation"] as ProjectOfIssue)(PROJECTS);

  // Both directions come out of the same declaration, and neither call site names a foreign key.
  // The join fields are in the generated code, which is the point of declaring the relationship.
  assert.deepEqual(
    issuesOf({ id: "p1" }).map((issue) => issue.id),
    ["i1", "i2"],
  );
  assert.deepEqual(
    issuesOf({ id: "p2" }).map((issue) => issue.id),
    ["i3"],
  );
  assert.equal(projectOf({ project_id: "p1" })?.name, "Loom firmware");
  assert.equal(projectOf({ project_id: "p2" })?.name, "Weaving room");
});

test("a parent with no children resolves empty, and a child whose parent is absent resolves to nothing", async () => {
  const generated = relationshipModule(JOINED);
  const issuesOf = (generated["projects_issuesRelation"] as IssuesOfProject)(ISSUES);
  const projectOf = (generated["issues_projectRelation"] as ProjectOfIssue)(PROJECTS);

  assert.deepEqual(issuesOf({ id: "p3" }), []);
  // A row pointing at a target this device has not synced is ordinary in a syncing database, so
  // the caller decides what to show for it.
  assert.equal(projectOf({ project_id: "p9" }), undefined);
  // The same empty array comes back on every miss, because a fresh `[]` each time would be a new
  // identity per render, which is what a memoised child compares against.
  assert.equal(issuesOf({ id: "p3" }), issuesOf({ id: "p4" }));
});

test("a generated accessor indexes its targets once and answers every lookup from that index", async () => {
  const generated = relationshipModule(JOINED);

  // Each row counts the reads of the field the join is keyed on. Indexing reads it once per row;
  // filtering the targets per source row reads it once per row per lookup, which turns a list
  // render from O(n+m) into O(n*m) and is the whole reason the accessor is built separately from
  // the lookups it answers.
  let reads = 0;
  const issues = ISSUES.map((issue) => ({
    id: issue.id,
    title: issue.title,
    get project_id(): string {
      reads += 1;
      return issue.project_id;
    },
  }));

  const issuesOf = (generated["projects_issuesRelation"] as IssuesOfProject)(issues);
  assert.equal(reads, issues.length, "the targets were not read once each on the way in");

  for (let round = 0; round < 4; round += 1) {
    assert.equal(issuesOf({ id: "p1" }).length, 2);
    assert.equal(issuesOf({ id: "p2" }).length, 1);
    assert.equal(issuesOf({ id: "p3" }).length, 0);
  }

  assert.equal(reads, issues.length, "a lookup read the target rows again, so the index is rebuilt per call");
});

test("an accessor's result is the target row type, so a call site needs no cast", async () => {
  const artifacts = generateArtifacts(JOINED);
  const siblings = { "relationships.ts": artifacts.relationshipsTs, "database.d.ts": artifacts.databaseDts };
  const application = (field: string): string =>
    [
      'import { issues_projectRelation, projects_issuesRelation } from "./relationships.ts";',
      'import type { Database } from "./database.d.ts";',
      "export function titles(project: Database['projects'], issues: readonly Database['issues'][]): readonly string[] {",
      `  return projects_issuesRelation(issues)(project).map((issue) => issue.${field});`,
      "}",
      "export function owner(issue: Database['issues'], projects: readonly Database['projects'][]): string {",
      "  return issues_projectRelation(projects)(issue)?.name ?? 'none';",
      "}",
      // An application actually holds the generated row with what only the client knows added to
      // it, and the accessor carries that whole row through to preserve it.
      "type IssueView = Database['issues'] & { readonly dirty: boolean };",
      "export function unsent(project: Database['projects'], issues: readonly IssueView[]): boolean {",
      "  return projects_issuesRelation(issues)(project).some((issue) => issue.dirty);",
      "}",
    ].join("\n");

  assert.deepEqual(typeDiagnostics("application.ts", application("title"), siblings), []);
  // The result type is not `any`, so a field the target row does not declare is still an error at
  // the call site.
  assert.notDeepEqual(
    typeDiagnostics("application.ts", application("ttile"), siblings),
    [],
    "the accessor's result accepts a field the target row does not have",
  );
});

test("a relationship naming a collection the schema does not define stays unknown", async () => {
  // Unreachable through `defineSchema`, which refuses this schema outright in both senses, since
  // the literal below is a compile error as well as a throw. It is written by hand here because
  // generation still has to tolerate a `SchemaDefinition` that reached it another way. A `.json`
  // schema loaded by the CLI never passes through `defineSchema`, and `Database["absent"]` would
  // turn `weft doctor`'s warning into a file that does not compile.
  const schema: SchemaDefinition = {
    schemaVersion: 1,
    collections: {
      tasks: S.collection({ owner_id: S.string() }, { owner: S.hasOne("users", "owner_id", "id") }),
    },
  };
  const relationships = generateRelationshipHelpers(schema);

  // The far side has no row type to name, so the accessor is bound only by what it actually
  // reads, a row carrying the joined field, and hands back whatever the caller gave it.
  assert.match(relationships, /export type TasksOwnerResult<Target = unknown> = Target \| undefined;/u);
  assert.match(relationships, /<Target extends Readonly<Record<string, unknown>>>/u);
  // The near side is still this schema's own collection, so the source is typed against it.
  assert.match(relationships, /source: Pick<Database\["tasks"\], "owner_id">/u);
  assert.deepEqual(typeDiagnostics("relationships.ts", relationships, relationshipSiblings(schema)), []);
});

test("relationship helper names are unambiguous after generation", async () => {
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
  // its result type, so the pair is refused by name, the same refusal two collections that
  // generate one name already get.
  const colliding = defineSchema({
    a_b: S.collection({}, { c: S.hasOne("x", "id", "id") }),
    a: S.collection({}, { b_c: S.hasOne("x", "id", "id") }),
    x: S.collection({}),
  });
  assert.throws(() => generateRelationshipHelpers(colliding), /generate the same name/u);
});

test("names SQLite folds together are refused where the schema declares them", async () => {
  // SQLite compares identifiers with the case of ASCII letters folded away, so each pair below
  // reaches the database as one name. A column pair is a `duplicate column name`, so the
  // `CREATE TABLE` does not run, and it takes the install script and the device's whole database
  // with it. A table pair is silent instead, because every table in the file is created
  // `IF NOT EXISTS` and the second declaration simply does nothing, leaving that collection
  // reading and writing the first one's columns.
  assert.throws(
    () => defineSchema({ todos: S.collection({ iD: S.string() }) }),
    /todos\.id and todos\.iD are one column to SQLite/u,
  );
  assert.throws(
    () => defineSchema({ todos: S.collection({ Scope_Id: S.string() }) }),
    /todos\.scope_id and todos\.Scope_Id are one column to SQLite/u,
  );
  assert.throws(
    () => defineSchema({ todos: S.collection({ title: S.string(), Title: S.string() }) }),
    /todos\.title and todos\.Title are one column to SQLite/u,
  );
  // The generator writes a `_weft_hlc_<field>` beside every column it declares, so two fields
  // that fold together collide in the internals as well as in the columns, and the reserved
  // prefix has to be recognised folded too.
  assert.throws(
    () => defineSchema({ todos: S.collection({ _WEFT_rev: S.number() }) }),
    /todos\._WEFT_rev uses reserved _weft_ prefix/u,
  );
  assert.throws(
    () => defineSchema({ todos: S.collection({ title: S.string() }), toDos: S.collection({ body: S.string() }) }),
    /collections "todos" and "toDos" are one table to SQLite/u,
  );
  assert.throws(
    () => defineSchema({ Outbox: S.collection({ title: S.string() }) }),
    /collection "Outbox" collides with the framework's own outbox table/u,
  );
  assert.throws(
    () => defineSchema({ tombstones: S.collection({ title: S.string() }) }),
    /collection "tombstones" collides with the framework's own tombstones table/u,
  );

  // The fold stops where SQLite's does. `Ä` and `ä` are two columns to the database, and a rule
  // built on `toLowerCase` would have refused a schema it has no trouble holding.
  const accented = defineSchema({ notes: S.collection({ Ä: S.string(), ä: S.string() }) });
  using database = new DatabaseSync(":memory:");
  database.exec(generateClientDdl(accented));
  const columns = database
    .prepare("SELECT name FROM pragma_table_info('notes')")
    .all()
    .map((row) => String((row as Record<string, unknown>)["name"]));
  assert.ok(
    columns.includes("Ä") && columns.includes("ä"),
    `two columns SQLite tells apart became ${columns.join(", ")}`,
  );
});

test("an index name that is already a table is refused before the DDL runs", async () => {
  // SQLite keeps indexes and tables in one namespace, and the generator names an index after the
  // collection and the field it covers. Either half may already carry the separator, so these two
  // declarations arrive as one name and `CREATE INDEX` fails with the install script behind it.
  assert.throws(
    () => defineSchema({ a: S.collection({ b: S.string({ index: true }) }), a_b: S.collection({ c: S.string() }) }),
    /the index on a\.b is named "a_b", which is already the table "a_b"/u,
  );
  assert.throws(
    () => defineSchema({ sync: S.collection({ state: S.string({ index: true }) }) }),
    /the index on sync\.state is named "sync_state", which is already the table "sync_state"/u,
  );
  // Two indexes are quieter, since the second `CREATE INDEX IF NOT EXISTS` does nothing, so one
  // of the two fields the schema asked to index never has one.
  assert.throws(
    () =>
      defineSchema({
        a: S.collection({ b_c: S.string({ index: true }) }),
        a_b: S.collection({ c: S.string({ index: true }) }),
      }),
    /the indexes on a\.b_c and a_b\.c are both named "a_b_c"/u,
  );
});

test("a schema that never passed the DSL is still refused before it reaches a database", async () => {
  // A `.json` schema loaded by the CLI is cast to a `SchemaDefinition` without passing through
  // `defineSchema` at all, so generating the DDL is the last point at which the fold is still
  // catchable.
  const schema: SchemaDefinition = {
    schemaVersion: 1,
    collections: {
      todos: {
        kind: "collection",
        fields: { id: S.string(), scope_id: S.string(), created: S.date(), iD: S.string() },
        relationships: {},
      },
    },
  };
  assert.throws(() => generateClientDdl(schema), /todos\.id and todos\.iD are one column to SQLite/u);
});

test("a relationship is refused unless all three of its names resolve", async () => {
  // A relationship is three names into the rest of the schema, and unchecked they fail quietly.
  // The join matches no row at runtime, and the result type degrades to `unknown`, so a typo gets
  // quieter the more the generator learns.
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

  // A name inherited from `Object.prototype`, such as `toString`, is not a field. No collection
  // declares a `toString` column.
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

test("checking a relationship leaves the schema hash where it was", async () => {
  // Which collection a join names is a local concern, and no row travels differently for it. The
  // hash is protocol visible, so two devices that disagreed about it would force a resync over a
  // change neither can see.
  const schema = defineSchema({
    projects: S.collection({ name: S.string() }, { issues: S.hasMany("issues", "id", "project_id") }),
    issues: S.collection({ project_id: S.string() }, { project: S.hasOne("projects", "project_id", "id") }),
  });
  assert.equal(schemaHash(schema), "2f66d9655767558e226873f9bef5ecc803cf0ac58515535486711a83b2010db6");
});

test("a relationship that names something the schema does not have is a compile error", async () => {
  // The runtime check is the safety net, and `S.hasMany` keeps its three arguments as the literals
  // they were written as, so `defineSchema` can hold each one to the names that would actually
  // resolve.
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

  // Each one names the offending string and the names it could have been. Unrolling the whole
  // collection type would make the constraint's failure unreadable, which is worse than no
  // constraint at all.
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

test("a schema that declares no relationship is inferred exactly as it was", async () => {
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
  // Every field the schema declares, at the type the schema declares it. None of this survives if
  // `Collections` is inferred as anything wider than the literal it was written as.
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

test("nested mappers share helper definitions without redeclaring them", async () => {
  const schema = defineSchema({
    alpha: S.collection({ one__two: S.string() }),
    beta: S.collection({ three__four: S.string() }),
  });

  assert.deepEqual(typeDiagnostics("nested-mappers.ts", generateNestedMappers(schema)), []);
});

test("an enum field is worth its values everywhere they can be enforced", async () => {
  const schema = defineSchema({
    todos: S.collection({
      status: S.enum(["open", "doing", "done"]),
      priority: S.enum(["low", "high"], { nullable: true }),
    }),
  });
  const artifacts = generateArtifacts(schema);

  // In the row type, as a union of the declared values.
  assert.match(artifacts.databaseDts, /status: "open" \| "doing" \| "done";/u);
  assert.match(artifacts.databaseDts, /priority: "low" \| "high" \| null;/u);
  assert.match(artifacts.mutatorsTs, /readonly status\?: "open" \| "doing" \| "done";/u);

  // In the database, as a constraint, so a row written by anything that is not this build
  // still cannot hold a value the schema forbids.
  assert.match(artifacts.clientDdl, /CHECK \("status" IN \('open', 'doing', 'done'/u);
  assert.match(artifacts.clientDdl, /"priority" IS NULL/u);

  // In the decoder, which reads anything else back as absent, keeping every value it returns a
  // member of the union it promises.
  const bindings = generateBindings(schema);
  assert.match(bindings, /\["open", "doing", "done"\] as unknown\[\]\)\.includes/u);
  assert.match(bindings, /: "open"/u, "a non-nullable enum falls back to something outside its own values");
});

test("an enum cannot be declared with a value twice", async () => {
  assert.throws(() => S.enum(["open", "open"]), /repeat/u);
});

/** `relationships.ts` imports one file, the row types `weft generate` writes beside it. */
function relationshipSiblings(schema: SchemaDefinition): Readonly<Record<string, string>> {
  return { "database.d.ts": generateArtifacts(schema).databaseDts };
}

/** An application's own type for what a json field holds, an interface here as one usually is. */
const LABEL_MODULE = [
  "export interface Label {",
  "  readonly text: string;",
  "  readonly weights: readonly number[];",
  "}",
].join("\n");

test("a json field is worth the type the schema declares for it", async () => {
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

  // Declaring nothing is still `unknown`, because a field whose shape the schema does not fix has
  // no more honest type, and every schema written before this option existed depends on it.
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

test("a declared json type is checked against what JSON can carry", async () => {
  const schema = defineSchema({ cards: S.collection({ label: S.json({ as: "Label", from: "./types.ts" }) }) });

  // A json value is stored with `encodeWireValue`, so a type JSON cannot carry describes a field
  // that throws on its first write. The bindings instantiate the check, so the declaration fails
  // to compile, catching the problem before it reaches a device somebody is using.
  const bindings = generateArtifacts(schema).bindingsTs;
  assert.match(bindings, /type WeftJsonCheck1 = WeftDeclaredJson<Label, WeftJsonCarriable<Label>>;/u);

  // The guard alone, lifted out of the bindings. The rest of the file names a client and a React
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

test("a declared json type is read and written without a cast", async () => {
  const schema = defineSchema({ cards: S.collection({ label: S.json({ as: "Label", from: "./types.ts" }) }) });
  const artifacts = generateArtifacts(schema);

  // Without this option, the application below would need two casts: one to read the field as
  // anything but `unknown`, one to write a value the mutation type is willing to accept.
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

test("a declared json type does not reach the schema hash", async () => {
  // Two devices have to agree about which writes are legal, and a json field carries a
  // `WireValue` whatever name one device's generated code puts on it. Hashing the name would make
  // a device that only renamed a TypeScript type look like a device on another schema, and force
  // a resync for a change no row can tell apart.
  const bare = defineSchema({ cards: S.collection({ label: S.json() }) });
  const declared = defineSchema({ cards: S.collection({ label: S.json({ as: "Label", from: "./types.ts" }) }) });

  assert.equal(schemaHash(declared), schemaHash(bare));
  assert.deepEqual(lintAdditiveEvolution(bare, declared), []);
});

test("two json types cannot share a name", async () => {
  // The generated file has one namespace, so the second import would land on top of the first and
  // silently give one collection the other's type.
  const colliding = defineSchema({
    cards: S.collection({ label: S.json({ as: "Label", from: "./cards.ts" }) }),
    tickets: S.collection({ label: S.json({ as: "Label", from: "./tickets.ts" }) }),
  });
  assert.throws(() => generateArtifacts(colliding), /both named "Label"/u);

  // The same name from the same module is one import, so nothing collides.
  const shared = defineSchema({
    cards: S.collection({ label: S.json({ as: "Label", from: "./types.ts" }) }),
    tickets: S.collection({ label: S.json({ as: "Label", from: "./types.ts" }) }),
  });
  const imports = generateArtifacts(shared)
    .databaseDts.split("\n")
    .filter((line) => line.startsWith("import"));
  assert.deepEqual(imports, ['import type { Label } from "./types.ts";']);
});

test("a json type that has to be imported has to be an identifier", async () => {
  // It is written verbatim into `import type { … }`, where an expression does not parse.
  assert.throws(() => S.json({ as: "readonly string[]", from: "./types.ts" }), /single identifier/u);
  assert.throws(() => S.json({ as: "  ", from: "./types.ts" }), /cannot be empty/u);
  // Without an import there is nothing to parse it into, so an expression is fine.
  assert.doesNotThrow(() => S.json({ as: "Record<string, number>" }));
});

test("bindings give an application a hook, a decoder and mutators per collection", async () => {
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

  // Names are the camelCase a person would write by hand.
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

  // Decoding follows the declared type. A boolean checks for an exact `true`, and an absent
  // nullable number decodes as `null`, matching what the schema promises.
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
// index signature is reported as a missing global, and the diagnostics that matter (a redeclared
// helper, a type modifier where none is allowed) have to be picked out of that noise by hand,
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
 * `weft generate` writes a whole directory, and `relationships.ts` names the row types in
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
  // Reaching `weftdb` for the types the bindings name pulls its own sources into the program.
  // Diagnostics are read back only for the files supplied here; whatever `weftdb`'s own sources
  // say about themselves is the workspace's `tsc` to report.
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
