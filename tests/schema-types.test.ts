import assert from "node:assert/strict";
import { test } from "vitest";
import ts from "typescript";
import { defineSchema, S, schemaHash } from "weftdb/schema";

// What a schema is worth as a type, checked by compiling source that says so.
//
// `weft generate` reads a schema as a runtime value and writes the row and mutation types out,
// while `FieldValue` and `DatabaseOf` read it as a type. The two only agree if the builders carry
// the field's type and its nullability in what they return, and a normal test run does not notice
// when they stop, because `vitest` erases the types before running anything. So the assertions
// here hand source to the compiler and check what it says about it.

/** Uses `Exact` so a widened type that would still assign does not pass this file. */
const PRELUDE = [
  'import { S, defineSchema, type FieldValue } from "weftdb/schema";',
  'import type { WireValue } from "weftdb/core";',
  "interface SortConfig {",
  '  readonly field: "title" | "weight";',
  '  readonly direction: "asc" | "desc";',
  "}",
  "type Exact<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;",
  "type Assert<Value extends true> = Value;",
  // Nothing below uses all of these, and a file that imports what it does not name is not the
  // subject of this test; `noUnusedLocals` is off, and these keep the prelude one block.
  "export type Used = [WireValue, SortConfig, ReturnType<typeof defineSchema>, FieldValue<never>];",
].join("\n");

/** `[what the schema declares, what a field of it is worth]`, as source. */
type FieldCase = readonly [declaration: string, value: string];

function fieldValueSource(cases: readonly FieldCase[]): string {
  return [
    PRELUDE,
    ...cases.flatMap(([declaration, value], index) => [
      `const field${index} = ${declaration};`,
      `export type Check${index} = Assert<Exact<FieldValue<typeof field${index}>, ${value}>>;`,
    ]),
  ].join("\n");
}

/** Every builder, at both nullabilities, and what each one has to be worth. */
const FIELD_CASES: readonly FieldCase[] = [
  ["S.string()", "string"],
  ["S.string({ nullable: true })", "string | null"],
  ["S.string({ merge: 'diff3' })", "string"],
  ["S.number()", "number"],
  ["S.number({ nullable: true })", "number | null"],
  ["S.number({ nullable: true, retentionAnchor: true })", "number | null"],
  ["S.boolean()", "boolean"],
  ["S.boolean({ nullable: true })", "boolean | null"],
  ["S.date()", "string"],
  ["S.date({ nullable: true })", "string | null"],
  ["S.enum(['open', 'started', 'closed'])", "'open' | 'started' | 'closed'"],
  ["S.enum(['open', 'closed'], { nullable: true })", "'open' | 'closed' | null"],
  ["S.json()", "WireValue"],
  ["S.json({ nullable: true })", "WireValue | null"],
  ["S.json<SortConfig>({ as: 'SortConfig' })", "SortConfig"],
  ["S.json<SortConfig>({ as: 'SortConfig', from: '../types.ts' })", "SortConfig"],
  ["S.json<SortConfig>({ as: 'SortConfig', nullable: true })", "SortConfig | null"],
];

test("every builder carries the type and the nullability the field was declared with", () => {
  // Every case compiles as lines in one program, so a diagnostic's line number points straight
  // at the declaration that stopped being worth what it says.
  assert.deepEqual(
    typeDiagnostics("fields.ts", fieldValueSource(FIELD_CASES)),
    [],
    "a field is not worth what its declaration says",
  );
});

test("the field-value assertions are capable of failing", () => {
  // The type is checked and so is the `| null` that nullability adds, since an `Exact` that held
  // for everything would pass this file whatever the builders returned.
  assert.notDeepEqual(typeDiagnostics("fields.ts", fieldValueSource([["S.string()", "number"]])), []);
  assert.notDeepEqual(typeDiagnostics("fields.ts", fieldValueSource([["S.string()", "string | null"]])), []);
  assert.notDeepEqual(typeDiagnostics("fields.ts", fieldValueSource([["S.number({ nullable: true })", "number"]])), []);
  assert.notDeepEqual(
    typeDiagnostics("fields.ts", fieldValueSource([["S.json<SortConfig>({ as: 'SortConfig' })", "WireValue"]])),
    [],
  );
});

test("a schema assembled at runtime still compiles, at the precision it can be read at", () => {
  // Not every schema is a literal. The CLI loads one from `.json`, and an application may build
  // options from data. With no literal `true` to capture there, the field is worth whatever the
  // widened type says, and it still has to compile, which the `json` overloads in particular
  // could easily stop doing.
  assert.deepEqual(
    typeDiagnostics(
      "runtime.ts",
      [
        PRELUDE,
        "declare const chosen: boolean;",
        "const looseString = S.string({ nullable: chosen });",
        "const looseJson = S.json({ nullable: chosen });",
        "const looseEnum = S.enum(['open', 'closed'], { nullable: chosen });",
        "export type CheckString = Assert<Exact<FieldValue<typeof looseString>, string>>;",
        "export type CheckJson = Assert<Exact<FieldValue<typeof looseJson>, WireValue>>;",
        "export type CheckEnum = Assert<Exact<FieldValue<typeof looseEnum>, 'open' | 'closed'>>;",
      ].join("\n"),
    ),
    [],
    "a schema whose nullability is only known at runtime stopped compiling",
  );
});

/** A schema with one of everything, named the same way in the source the compiler is handed. */
const SCHEMA_SOURCE = [
  "export const schema = defineSchema({",
  "  cards: S.collection({",
  "    title: S.string(),",
  "    body: S.string({ merge: 'diff3' }),",
  "    weight: S.number({ nullable: true }),",
  "    done: S.boolean(),",
  "    due: S.date({ nullable: true }),",
  "    status: S.enum(['open', 'started', 'closed']),",
  "    sort: S.json<SortConfig>({ as: 'SortConfig', from: '../types.ts' }),",
  "    payload: S.json(),",
  "  }),",
  "});",
  'type Cards = (typeof schema)["collections"]["cards"];',
].join("\n");

/** The mutation input the generator emits, as a type over the schema the compiler is handed. */
function mutationSource(body: string): string {
  return [
    PRELUDE,
    'import type { DeclaredFieldNames } from "weftdb/schema";',
    SCHEMA_SOURCE,
    "type Writable = Exclude<DeclaredFieldNames<Cards>, 'id' | 'scope_id' | 'created'>;",
    "export type Input = { readonly [Name in Writable]?: FieldValue<Cards['fields'][Name]> | undefined };",
    body,
  ].join("\n");
}

test("a nullable field accepts null through a mutation input", () => {
  // Making `type` literal without also making `nullable` literal stops `ScalarType` collapsing to
  // `WireValue` and never adds the `| null` back, so a nullable field starts refusing the very
  // value it was declared to hold.
  assert.deepEqual(
    typeDiagnostics(
      "mutation.ts",
      mutationSource(
        [
          "export const clearing: Input = { weight: null, due: null };",
          "export const setting: Input = { title: 'a', weight: 3, done: true, due: '2026-01-01T00:00:00.000Z' };",
        ].join("\n"),
      ),
    ),
    [],
    "a nullable field would not take null, or a scalar would not take its own type",
  );
});

test("a non-nullable field refuses null, and a scalar refuses the wrong type", () => {
  // Precision that only ever widens is no precision at all; `WireValue` would accept every one
  // of these without complaint.
  assert.match(
    typeDiagnostics("mutation.ts", mutationSource("export const wrong: Input = { title: null };")).join("\n"),
    /'null' is not assignable/u,
  );
  assert.match(
    typeDiagnostics("mutation.ts", mutationSource("export const wrong: Input = { title: 7 };")).join("\n"),
    /Type 'number' is not assignable to type 'string/u,
  );
  assert.match(
    typeDiagnostics("mutation.ts", mutationSource("export const wrong: Input = { done: 'yes' };")).join("\n"),
    /Type 'string' is not assignable to type 'boolean/u,
  );
});

test("an enum keeps its values, and anything outside them is a compile error", () => {
  assert.deepEqual(
    typeDiagnostics("mutation.ts", mutationSource("export const ok: Input = { status: 'started' };")).join("\n"),
    "",
  );
  assert.match(
    typeDiagnostics("mutation.ts", mutationSource("export const wrong: Input = { status: 'blocked' };")).join("\n"),
    /Type '"blocked"' is not assignable to type '"open" \| "started" \| "closed"/u,
  );
});

test("a declared json type is what the mutation input takes, and a bare one still takes the wire", () => {
  assert.deepEqual(
    typeDiagnostics(
      "mutation.ts",
      mutationSource(
        [
          "export const declaredJson: Input = { sort: { field: 'title', direction: 'desc' } };",
          "export const bareJson: Input = { payload: { tags: ['a'], count: 2 } };",
        ].join("\n"),
      ),
    ),
    [],
    "a declared json type or a bare one stopped taking its own value",
  );
  assert.match(
    typeDiagnostics(
      "mutation.ts",
      mutationSource("export const wrong: Input = { sort: { field: 'title', direction: 'sideways' } };"),
    ).join("\n"),
    /'"sideways"' is not assignable to type '"asc" \| "desc"'/u,
  );
});

test("the row type a schema is read into is the type each field was declared with", () => {
  assert.deepEqual(
    typeDiagnostics(
      "row.ts",
      [
        PRELUDE,
        'import type { DatabaseOf } from "weftdb/schema";',
        SCHEMA_SOURCE,
        "type Card = DatabaseOf<typeof schema>['cards'];",
        "export type CheckTitle = Assert<Exact<Card['title'], string>>;",
        "export type CheckWeight = Assert<Exact<Card['weight'], number | null>>;",
        "export type CheckDone = Assert<Exact<Card['done'], boolean>>;",
        "export type CheckDue = Assert<Exact<Card['due'], string | null>>;",
        "export type CheckStatus = Assert<Exact<Card['status'], 'open' | 'started' | 'closed'>>;",
        "export type CheckSort = Assert<Exact<Card['sort'], SortConfig>>;",
        "export type CheckPayload = Assert<Exact<Card['payload'], WireValue>>;",
      ].join("\n"),
    ),
    [],
    "a generated row type stopped matching what the schema declares",
  );
});

test("a more precise schema type hashes to exactly what it hashed to before", () => {
  // The hash is protocol visible, so two devices that disagree about it refuse to sync. Types are
  // erased before `toWireSchema` sees anything, so a runtime regression (an extra property, a
  // reordered key, a `nullable` that stopped being written) would take every deployed device
  // offline. These are pinned literals, so any change to the value the builders return shows up
  // as a failing assertion here.
  const cards = defineSchema({
    cards: S.collection({
      title: S.string(),
      body: S.string({ merge: "diff3" }),
      weight: S.number({ nullable: true, retentionAnchor: true }),
      done: S.boolean(),
      due: S.date({ nullable: true }),
      status: S.enum(["open", "started", "closed"]),
      sort: S.json<{ readonly field: string }>({ as: "SortConfig", from: "../types.ts" }),
      payload: S.json(),
    }),
  });
  assert.equal(schemaHash(cards), "8d05a3aa58e3c9bbb93a50516f1cc422a4f186f9a177cbda4ce40685bd62709e");

  // Relationships, an event log and a second collection, because the wire schema walks all of it.
  const tracker = defineSchema({
    projects: S.collection({ name: S.string() }, { issues: S.hasMany("issues", "id", "project_id") }),
    issues: S.collection(
      { project_id: S.string(), rank: S.string({ merge: "fracIndex" }) },
      { project: S.hasOne("projects", "project_id", "id") },
    ),
    comments: S.eventLog({ issue_id: S.string(), body: S.string() }),
  });
  assert.equal(schemaHash(tracker), "7b01cbe4b3a4d45baf74db78887a32a02521bb85165e79619b7e12fa43846e51");
});

test("the runtime value a builder returns is unchanged, key for key", () => {
  // The hash is one reading of the value; this is the value itself, since anything the builders
  // started attaching would travel into a generated file as well as into the hash.
  assert.deepEqual({ ...S.string() }, { type: "string", merge: "lww", nullable: false });
  assert.deepEqual({ ...S.number({ nullable: true }) }, { type: "number", merge: "lww", nullable: true });
  assert.deepEqual(
    { ...S.date({ merge: "immutable", retentionAnchor: true }) },
    { type: "date", merge: "immutable", nullable: false, retentionAnchor: true },
  );
  assert.deepEqual({ ...S.boolean() }, { type: "boolean", merge: "lww", nullable: false });
  assert.deepEqual({ ...S.json() }, { type: "json", merge: "lww", nullable: false });
  assert.deepEqual(
    { ...S.json<{ readonly a: number }>({ as: "Thing", from: "./types.ts", nullable: true }) },
    { type: "json", merge: "lww", nullable: true, jsonType: { as: "Thing", from: "./types.ts" } },
  );
  assert.deepEqual(
    { ...S.enum(["open", "closed"], { nullable: true }) },
    { type: "enum", merge: "lww", nullable: true, values: ["open", "closed"] },
  );
  // Key order is what `stableHash` walks, so it is part of the value and not only of the shape.
  assert.deepEqual(Object.keys(S.enum(["open", "closed"])), ["type", "merge", "nullable", "values"]);
});

const TYPE_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
};

// Parsed once. `lib.es2022.d.ts` and what it references is a megabyte of declarations, and every
// assertion here compiles its own program.
const libraryFiles = new Map<string, ts.SourceFile | undefined>();

/**
 * Compiles one source in memory and returns what the compiler said about it, the same way
 * `tests/codegen.test.ts` checks a generated file. Everything it imports, including
 * `weftdb/schema` and `weftdb/client`, resolves through the workspace's own `node_modules`, so
 * what is checked is the sources the suite runs against.
 */
function typeDiagnostics(fileName: string, source: string): readonly string[] {
  const options = TYPE_OPTIONS;
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (requested === fileName) return ts.createSourceFile(requested, source, languageVersion, true);
    if (libraryFiles.has(requested)) return libraryFiles.get(requested);
    const parsed = originalGetSourceFile(requested, languageVersion, onError, shouldCreateNewSourceFile);
    libraryFiles.set(requested, parsed);
    return parsed;
  };
  host.readFile = (requested) => (requested === fileName ? source : ts.sys.readFile(requested));
  host.fileExists = (requested) => requested === fileName || ts.sys.fileExists(requested);
  const program = ts.createProgram([fileName], options, host);
  const file = program.getSourceFile(fileName);
  return [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map((diagnostic) => {
    const source = diagnostic.file;
    if (source === undefined || diagnostic.start === undefined)
      return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    const position = source.getLineAndCharacterOfPosition(diagnostic.start);
    return `${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  });
}
