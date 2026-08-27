import { assertDistinctSqlNames, schemaHash } from "weftdb/schema";
import type { CollectionDefinition, FieldDefinition, JsonTypeReference, SchemaDefinition } from "weftdb/schema";
import { fieldStorage } from "weftdb/shared";

export interface GeneratedArtifactSet {
  schemaHash: string;
  clientDdl: string;
  databaseDts: string;
  mutatorsTs: string;
  bindingsTs: string;
  relationshipsTs: string;
  nestedMappersTs: string;
}

export interface SchemaEvolutionIssue {
  readonly code:
    | "removed_collection"
    | "removed_field"
    | "changed_field_type"
    | "changed_field_merge"
    | "field_became_required"
    | "changed_enum_values";
  readonly path: string;
  readonly message: string;
}

export function generateArtifacts(schema: SchemaDefinition): GeneratedArtifactSet {
  const hash = schemaHash(schema);
  const clientDdl = generateClientDdl(schema);
  return {
    schemaHash: hash,
    clientDdl,
    databaseDts: generateDatabaseTypes(schema),
    mutatorsTs: generateMutators(schema),
    bindingsTs: generateBindings(schema),
    relationshipsTs: generateRelationshipHelpers(schema),
    nestedMappersTs: generateNestedMappers(schema),
  };
}

export function generateClientAddMissingColumnDdl(
  tableName: string,
  collection: CollectionDefinition,
  existingColumns: ReadonlySet<string>,
): readonly string[] {
  const statements: string[] = [];
  const addColumn = (name: string, definition: string): void => {
    if (!existingColumns.has(name)) statements.push(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${definition};`);
  };
  for (const [name, field] of Object.entries(collection.fields)) {
    addColumn(name, domainColumnDdl(name, field, "alter"));
    addColumn(`_weft_hlc_${name}`, `${quoteIdent(`_weft_hlc_${name}`)} TEXT`);
    if (field.merge === "diff3") addColumn(`_weft_base_${name}`, `${quoteIdent(`_weft_base_${name}`)} TEXT`);
  }
  addColumn("_weft_first_synced_at", `${quoteIdent("_weft_first_synced_at")} INTEGER`);
  addColumn("_weft_rev", `${quoteIdent("_weft_rev")} INTEGER NOT NULL DEFAULT 0`);
  addColumn("_weft_dirty", `${quoteIdent("_weft_dirty")} INTEGER NOT NULL DEFAULT 0`);
  addColumn("_weft_null_fields", `${quoteIdent("_weft_null_fields")} TEXT`);
  return statements;
}

export function lintAdditiveEvolution(from: SchemaDefinition, to: SchemaDefinition): readonly SchemaEvolutionIssue[] {
  const issues: SchemaEvolutionIssue[] = [];
  for (const [tableName, previousCollection] of Object.entries(from.collections)) {
    const nextCollection = to.collections[tableName];
    if (nextCollection === undefined) {
      issues.push({
        code: "removed_collection",
        path: tableName,
        message: `${tableName} was removed`,
      });
      continue;
    }
    for (const [fieldName, previousField] of Object.entries(previousCollection.fields)) {
      const nextField = nextCollection.fields[fieldName];
      if (nextField === undefined) {
        issues.push({
          code: "removed_field",
          path: `${tableName}.${fieldName}`,
          message: `${tableName}.${fieldName} was removed`,
        });
        continue;
      }
      if (nextField.type !== previousField.type) {
        issues.push({
          code: "changed_field_type",
          path: `${tableName}.${fieldName}`,
          message: `${tableName}.${fieldName} changed type from ${previousField.type} to ${nextField.type}`,
        });
      }
      if (nextField.merge !== previousField.merge) {
        issues.push({
          code: "changed_field_merge",
          path: `${tableName}.${fieldName}`,
          message: `${tableName}.${fieldName} changed merge from ${previousField.merge} to ${nextField.merge}`,
        });
      }
      if (previousField.nullable && !nextField.nullable) {
        issues.push({
          code: "field_became_required",
          path: `${tableName}.${fieldName}`,
          message: `${tableName}.${fieldName} changed from nullable to required`,
        });
      }
      // A value one build writes is a value the other's `CHECK` refuses, so the two devices
      // hold databases that cannot take each other's rows.
      const previousValues = previousField.values ?? [];
      const nextValues = nextField.values ?? [];
      if (
        previousValues.length !== nextValues.length ||
        previousValues.some((value, index) => value !== nextValues[index])
      ) {
        issues.push({
          code: "changed_enum_values",
          path: `${tableName}.${fieldName}`,
          message: `${tableName}.${fieldName} changed allowed values from [${previousValues.join(", ")}] to [${nextValues.join(", ")}]`,
        });
      }
    }
  }
  return issues;
}

export function generateClientDdl(schema: SchemaDefinition): string {
  // `defineSchema` has already refused a schema whose names collide once SQLite folds them, but a
  // `.json` schema loaded by the CLI is cast to a `SchemaDefinition` without passing through the
  // DSL at all, and this is the last point before that one reaches a database.
  assertDistinctSqlNames(schema.collections);
  assertDistinctGeneratedNames(schema);
  const statements: string[] = [
    `CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  field TEXT,
  value TEXT,
  hlc TEXT NOT NULL,
  base_hash TEXT,
  txn_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create','set','delete','restore','append'))
);`,
    `CREATE TABLE IF NOT EXISTS outbox_quarantine (
  seq INTEGER,
  scope_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  field TEXT,
  value TEXT,
  hlc TEXT NOT NULL,
  base_hash TEXT,
  txn_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  rejected_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  server_value TEXT,
  row_identity INTEGER
);`,
    `CREATE TABLE IF NOT EXISTS tombstones (
  scope_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  diff3_base TEXT,
  PRIMARY KEY (scope_id, table_name, row_id)
);`,
    `CREATE TABLE IF NOT EXISTS sync_state (
  scope_id TEXT PRIMARY KEY,
  last_server_seq INTEGER NOT NULL DEFAULT 0,
  hlc_last TEXT,
  resync_required INTEGER NOT NULL DEFAULT 0,
  server_epoch TEXT
);`,
  ];

  for (const [tableName, collection] of Object.entries(schema.collections)) {
    statements.push(generateTableDdl(tableName, collection));
  }
  return `${statements.join("\n\n")}\n`;
}

export function generateServerDdl(): string {
  return `CREATE TABLE IF NOT EXISTS fields (
  scope_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  hlc TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  txn_id TEXT NOT NULL,
  PRIMARY KEY (scope_id, table_name, row_id, field)
);
CREATE INDEX IF NOT EXISTS fields_scope_seq ON fields (scope_id, server_seq);

CREATE TABLE IF NOT EXISTS rows (
  scope_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('row','append')),
  deleted_hlc TEXT,
  register_hlc TEXT,
  server_seq INTEGER NOT NULL,
  PRIMARY KEY (scope_id, table_name, row_id)
);
CREATE INDEX IF NOT EXISTS rows_scope_seq ON rows (scope_id, server_seq);

CREATE TABLE IF NOT EXISTS scope_state (
  scope_id TEXT PRIMARY KEY,
  server_seq INTEGER NOT NULL,
  tombstone_floor_seq INTEGER NOT NULL,
  schema_hash TEXT,
  schema_version INTEGER,
  epoch TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  scope_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (scope_id, device_id)
);
`;
}

function generateTableDdl(tableName: string, collection: CollectionDefinition): string {
  const fields = Object.entries(collection.fields);
  // The `CHECK` says in the database what the generated union says in the types, so a row
  // written by anything that is not this build still cannot hold a value the schema forbids.
  const columns = fields.map(([name, field]) => `  ${domainColumnDdl(name, field, "create")}`);
  const internals = fields.flatMap(([name, field]) => {
    const columns = [`  ${quoteIdent(`_weft_hlc_${name}`)} TEXT`];
    if (field.merge === "diff3") columns.push(`  ${quoteIdent(`_weft_base_${name}`)} TEXT`);
    return columns;
  });
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (
${[
  ...columns,
  ...internals,
  "  _weft_first_synced_at INTEGER",
  "  _weft_rev INTEGER NOT NULL DEFAULT 0",
  "  _weft_dirty INTEGER NOT NULL DEFAULT 0",
  // A declared field is stored as its column's own type, so a null field and a field that was
  // never written both read back as SQL NULL. `_weft_null_fields` records which of the two a
  // NULL is, and only the client store reads it, since nothing compiled against the generated
  // types names it.
  "  _weft_null_fields TEXT",
  // Keyed the way every framework table is keyed. A row id is unique within its scope and
  // nowhere else, so one database holding two scopes has two rows legitimately sharing an id,
  // and a key on `id` alone would turn the second one into a constraint failure.
  "  PRIMARY KEY (scope_id, id)",
].join(",\n")}
);${indexDdl(tableName, fields)}`;
}

/**
 * An index per field the schema asked for, led by `scope_id`.
 *
 * Every statement a device runs is scoped, so a query narrows by `scope_id` before it does
 * anything else, and an index that led with a different column could not serve that query.
 * `installSchema` runs the whole DDL on every open, so a field that gains an index has one from
 * the next open.
 */
function indexDdl(tableName: string, fields: readonly (readonly [string, FieldDefinition])[]): string {
  return fields
    .filter(([, field]) => field.index === true)
    .map(
      ([name]) =>
        `\n\nCREATE INDEX IF NOT EXISTS ${quoteIdent(`${tableName}_${name}`)} ` +
        `ON ${quoteIdent(tableName)} (scope_id, ${quoteIdent(name)});`,
    )
    .join("");
}

function generateDatabaseTypes(schema: SchemaDefinition): string {
  const tables = Object.entries(schema.collections)
    .map(([tableName, collection]) => `  ${propertyName(tableName)}: {\n${typeFields(collection)}\n  };`)
    .join("\n");
  const imports = jsonTypeImports(schema);
  const header = imports.length === 0 ? "" : `${imports.join("\n")}\n\n`;
  return `${header}export interface Database {\n${tables}\n}\n`;
}

/**
 * Two collections whose names differ only in punctuation, such as `todo_events` and
 * `todoEvents`, produce the same identifiers once the generator has capitalised them, and
 * emitting both would hand one of them the other's query, decoder, hook and mutators. Silently
 * renaming one would hide that collision from whoever wrote the schema, so this throws instead.
 */
function assertDistinctGeneratedNames(schema: SchemaDefinition): void {
  const claimed = new Map<string, string>();
  for (const table of Object.keys(schema.collections)) {
    const generated = typeName(table, "");
    const existing = claimed.get(generated);
    if (existing !== undefined) {
      throw new Error(
        `collections ${JSON.stringify(existing)} and ${JSON.stringify(table)} generate the same name ` +
          `(${generated}); rename one of them so the generated code can tell them apart`,
      );
    }
    claimed.set(generated, table);
  }
}

export function generateMutators(schema: SchemaDefinition): string {
  assertDistinctGeneratedNames(schema);
  const imports = ['import type { TxnId } from "weftdb/core";', ...jsonTypeImports(schema)];
  const methods = Object.entries(schema.collections)
    .map(([tableName, collection]) => {
      const inputName = typeName(tableName, "Mutation");
      return [
        `export interface ${inputName} {`,
        ...Object.entries(collection.fields)
          .filter(([fieldName, field]) => !BASE_FIELD_NAMES.has(fieldName) && field.merge !== "immutable")
          .map(([fieldName, field]) => `  readonly ${propertyName(fieldName)}?: ${tsType(field)};`),
        "}",
        "",
        // The transaction id is the caller's to supply, because the relay applies a transaction as
        // a unit. Two writes that must land together, such as a row's new status and the event
        // that records it in another collection, share one only if the caller passes the same
        // id; otherwise each call gets its own and the relay accepts them as two separate
        // transactions.
        `export interface ${typeName(tableName, "Mutators")} {`,
        `  create(id: string, values: ${inputName}, txnId?: TxnId): Promise<void>;`,
        collection.kind === "eventLog"
          ? ""
          : `  update(id: string, values: ${inputName}, txnId?: TxnId): Promise<void>;`,
        collection.kind === "eventLog" ? "" : "  delete(id: string, txnId?: TxnId): Promise<void>;",
        "}",
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    })
    .join("\n\n");
  return `${imports.length === 0 ? "" : `${imports.join("\n")}\n\n`}${methods}\n`;
}

/**
 * The runtime the schema implies. A decoder per collection, the mutator interfaces implemented
 * against a `MutationTarget`, and a React hook per collection. Without these, an application
 * would hand-decode `ReadonlyMap<FieldName, WireValue>` into its own row type and would have to
 * know that the decoded array must be cached against its snapshot or React re-renders forever.
 */
export function generateBindings(schema: SchemaDefinition): string {
  assertDistinctGeneratedNames(schema);
  const collections = Object.entries(schema.collections);
  const header = [
    "// Generated by weft. Do not edit; run `weft generate` after changing the schema.",
    'import { rankBetween, rankString, rowId, tableName, txnId, fieldName, type DeviceId, type FieldName, type TxnId, type WireValue } from "weftdb/core";',
    'import { compileOnlyKysely, reactiveSqlQuery } from "weftdb/client";',
    'import type { MaterializedRow, MutationTarget, ReactiveSqlQuery, ScopedRowQuery, TypedQueryKey } from "weftdb/client";',
    'import { useWeftRows, useWeftSqlRows, type WeftSource } from "weftdb-react";',
    'import type { Database } from "./database.d.ts";',
    ...collections.map(
      ([name]) => `import type { ${typeName(name, "Mutation")}, ${typeName(name, "Mutators")} } from "./mutators.ts";`,
    ),
    ...jsonTypeImports(schema),
    "",
    ...jsonTypeGuard(schema),
    "// Re-exported so an application has one import for everything the schema implies.",
    `export type { ${collections
      .flatMap(([name]) => [typeName(name, "Mutation"), typeName(name, "Mutators")])
      .join(", ")} } from "./mutators.ts";`,
    "",
    // One name for what every hook below reads through. The narrower shape still exists in
    // `weftdb-react` for the two hooks that need only it, and an application that names two
    // source types has to work out which of them each of its components takes.
    "/** The subscription engine, the client's row map, the scope, and the statement selection. */",
    "export type { WeftSource };",
    "",
    "// Builds and compiles; the engine is what runs a statement.",
    "const weftStatements = compileOnlyKysely<Database>();",
    "",
    "function wire(values: object): Record<FieldName, WireValue> {",
    "  return Object.fromEntries(",
    "    Object.entries(values)",
    "      .filter(([, value]) => value !== undefined)",
    "      .map(([field, value]) => [fieldName(field), value as WireValue]),",
    "  ) as Record<FieldName, WireValue>;",
    "}",
  ];

  const bodies = collections.map(([name, collection]) => {
    const fields = Object.entries(collection.fields);
    const table = memberName(name, "Table");
    const query = memberName(name, "Query");
    const decoder = `decode${typeName(name, "")}`;
    const rowTypeName = typeName(name, "Row");
    const fieldTypeName = typeName(name, "Field");
    const sqlQuery = memberName(name, "SqlQuery");
    const builderTypeName = typeName(name, "QueryBuilder");
    const scopedType = `ScopedRowQuery<Database, ${JSON.stringify(name)}>`;
    return [
      `// --- ${name} ${"-".repeat(Math.max(0, 70 - name.length))}`,
      "",
      `export const ${table} = tableName(${JSON.stringify(name)});`,
      `export type ${rowTypeName} = Database[${JSON.stringify(name)}];`,
      `export type ${fieldTypeName} = ${fields.map(([field]) => JSON.stringify(field)).join(" | ")};`,
      "",
      "/** Every field the row type promises, so a decoded row is never missing one. */",
      `export function ${query}(orderBy: ${fieldTypeName} = "id"): TypedQueryKey<${rowTypeName}> {`,
      "  return {",
      `    tableName: ${table},`,
      `    fields: [${fields.map(([field]) => `fieldName(${JSON.stringify(field)})`).join(", ")}],`,
      "    orderBy: fieldName(orderBy),",
      "  };",
      "}",
      "",
      `export function ${decoder}(row: MaterializedRow): ${rowTypeName} {`,
      "  return {",
      ...fields.map(([field, definition]) => `    ${propertyName(field)}: ${decodeExpression(field, definition)},`),
      "  };",
      "}",
      "",
      `export function ${memberName(name, "Mutators")}(client: MutationTarget, notify: () => void = () => undefined): ${typeName(name, "Mutators")} {`,
      "  return {",
      `    async create(id: string, values: ${typeName(name, "Mutation")}, transaction?: TxnId): Promise<void> {`,
      `      await client.${collection.kind === "eventLog" ? "append" : "create"}(${table}, rowId(id), wire(values), transaction ?? txnId(\`create-\${id}\`));`,
      "      notify();",
      "    },",
      ...(collection.kind === "eventLog"
        ? []
        : [
            `    async update(id: string, values: ${typeName(name, "Mutation")}, transaction?: TxnId): Promise<void> {`,
            `      await client.update(${table}, rowId(id), wire(values), transaction ?? txnId(\`update-\${id}-\${crypto.randomUUID()}\`));`,
            "      notify();",
            "    },",
            "    async delete(id: string, transaction?: TxnId): Promise<void> {",
            `      await client.delete(${table}, rowId(id), transaction ?? txnId(\`delete-\${id}-\${crypto.randomUUID()}\`));`,
            "      notify();",
            "    },",
          ]),
      "  };",
      "}",
      "",
      `export function use${typeName(name, "")}(source: WeftSource, orderBy: ${fieldTypeName} = "id"): readonly ${rowTypeName}[] {`,
      `  return useWeftRows(source, ${query}(orderBy), ${decoder});`,
      "}",
      "",
      `export type ${builderTypeName} = (statement: ${scopedType}) => ${scopedType};`,
      "",
      `/**`,
      ` * A statement over \`${name}\`, scoped and selecting \`id\` before the callback sees it. Chain`,
      ` * \`where\`, \`orderBy\`, \`limit\`, and \`offset\` onto it. One database file holds every scope,`,
      ` * and a row id is unique only within its collection, so an unscoped statement can match`,
      ` * another scope's row; scoping it here means the caller never has to get that right itself.`,
      ` */`,
      `export function ${sqlQuery}(scopeId: string, build: ${builderTypeName} = (statement) => statement): ReactiveSqlQuery {`,
      `  const scoped = weftStatements.selectFrom(${JSON.stringify(name)}).select("id").where("scope_id", "=", scopeId);`,
      `  return reactiveSqlQuery({ tableName: ${table}, query: build(scoped) });`,
      "}",
      "",
      `export function use${typeName(name, "")}Query(source: WeftSource, build?: ${builderTypeName}): readonly ${rowTypeName}[] {`,
      `  return useWeftSqlRows(source, ${sqlQuery}(source.scopeId, build), ${decoder});`,
      "}",
      ...reorderHelpers(name, collection),
    ].join("\n");
  });

  return `${[...header, "", ...bodies].join("\n")}\n`;
}

/**
 * Ordering, for a collection that declares a fractional index. The schema already says which
 * field that is, so where to put a row is arithmetic on its neighbours' ranks, and getting it
 * wrong is subtle enough (a rank must be *strictly between* two others, and two devices must
 * not collide in the same gap) that every application working it out again is a bug waiting to
 * be written a second time.
 */
function reorderHelpers(name: string, collection: CollectionDefinition): readonly string[] {
  const ranked = Object.entries(collection.fields).find(([, field]) => field.merge === "fracIndex");
  if (ranked === undefined || collection.kind === "eventLog") return [];
  const [rankField] = ranked;
  const rowType = typeName(name, "Row");
  const mutators = typeName(name, "Mutators");
  const rankOf = `(row: ${rowType} | undefined) => (row === undefined ? null : rankString(String(row[${JSON.stringify(rankField)}])))`;

  return [
    "",
    `/** A rank that puts a new row after everything in \`rows\`, which must be ordered by rank. */`,
    `export function next${typeName(name, "Rank")}(rows: readonly ${rowType}[], device: DeviceId): string {`,
    `  const rankOf = ${rankOf};`,
    "  return rankBetween(rankOf(rows.at(-1)), null, device);",
    "}",
    "",
    "/**",
    " * Moves the row at `index` one place. Reordering writes one field, the row's new rank, taken",
    " * from between the two rows it lands between, so nothing below it is renumbered and two",
    " * devices reordering at once do not undo each other.",
    " */",
    `export async function move${typeName(name, "")}(`,
    `  mutators: ${mutators},`,
    `  rows: readonly ${rowType}[],`,
    "  index: number,",
    '  direction: "up" | "down",',
    "  device: DeviceId,",
    "): Promise<void> {",
    `  const rankOf = ${rankOf};`,
    "  const moving = rows[index];",
    '  const neighbour = rows[direction === "up" ? index - 1 : index + 1];',
    "  if (moving === undefined || neighbour === undefined) return;",
    "  // Landing between the neighbour and whatever is on its far side.",
    '  const beyond = rows[direction === "up" ? index - 2 : index + 2];',
    '  const [before, after] = direction === "up" ? [beyond, neighbour] : [neighbour, beyond];',
    `  await mutators.update(String(moving["id"]), { ${propertyName(rankField)}: rankBetween(rankOf(before), rankOf(after), device) });`,
    "}",
  ];
}

/** Reads one field out of a materialized row as the type the schema declares for it. */
function decodeExpression(field: string, definition: FieldDefinition): string {
  const read = `row.fields.get(fieldName(${JSON.stringify(field)}))`;
  const fallback = definition.nullable ? "null" : defaultLiteral(definition);
  if (definition.values !== undefined) {
    // A value outside the set reaches here from a device running a schema this build does not
    // have. It is read as absent, so no caller can be handed a value outside the union it decoded.
    const allowed = definition.values.map((value) => JSON.stringify(value)).join(", ");
    return `([${allowed}] as unknown[]).includes(${read}) ? ${read} as ${tsType(definition)} : ${fallback}`;
  }
  switch (definition.type) {
    case "number":
      return `typeof ${read} === "number" ? ${read} as number : ${fallback}`;
    case "boolean":
      return `${read} === true${definition.nullable ? ` ? true : ${read} === false ? false : null` : ""}`;
    case "json":
      // The wire carries a `WireValue` and the schema says the field holds a `Tags`; neither is
      // assignable to the other, because an interface has no index signature. The declared type
      // is asserted through `unknown` here, once, so no other read of the field has to assert it
      // again.
      return definition.jsonType === undefined
        ? `(${read} ?? ${fallback}) as ${tsType(definition)}`
        : `(${read} ?? ${fallback}) as unknown as ${tsType(definition)}`;
    default:
      return `typeof ${read} === "string" ? ${read} as string : ${fallback}`;
  }
}

/**
 * Two relationships can want the same generated name. `a_b.c` and `a.b_c` both read as
 * `a_b_cRelation`, and no separator escapes it, because a table may itself contain whatever
 * separator the join uses. Emitting both would redeclare the helper and its result type, so this
 * reports the collision by name before anything is written, the same way a colliding pair of
 * collections is.
 */
function assertDistinctRelationshipNames(schema: SchemaDefinition): void {
  const claimed = new Map<string, string>();
  for (const [tableName, collection] of Object.entries(schema.collections)) {
    for (const relationshipName of Object.keys(collection.relationships)) {
      const path = `${tableName}.${relationshipName}`;
      for (const generated of [
        `${tableName}_${relationshipName}Relation`,
        typeName(`${tableName}_${relationshipName}`, "Result"),
      ]) {
        const existing = claimed.get(generated);
        if (existing !== undefined && existing !== path) {
          throw new Error(
            `relationships ${JSON.stringify(existing)} and ${JSON.stringify(path)} generate the same name ` +
              `(${generated}); rename one of them so the generated code can tell them apart`,
          );
        }
        claimed.set(generated, path);
      }
    }
  }
}

/**
 * The joiner each declared relationship implies, a function that indexes the target rows once and
 * returns a lookup over that index.
 *
 * The rows are the caller's, already held by the client, so nothing here queries or reaches for a
 * source. Indexing them once here turns what would otherwise be an O(n*m) filter per parent row
 * into one pass over the targets, the same saving every application that wrote its own joiner had
 * to find on its own.
 */
export function generateRelationshipHelpers(schema: SchemaDefinition): string {
  assertDistinctRelationshipNames(schema);
  let joinsMany = false;
  const helpers = Object.entries(schema.collections)
    .flatMap(([tableName, collection]) =>
      Object.entries(collection.relationships).map(([relationshipName, relationship]) => {
        // The schema already says which collection is on the far side, so the result type is that
        // collection's row. A relationship may still name a table this schema does not define;
        // `weft doctor` warns about that case at generation time. Typing it as
        // `Database["absent"]` would fail to compile, so that case is typed `unknown` instead.
        const target = schema.collections[relationship.table];
        const row = target === undefined ? "unknown" : `Database[${JSON.stringify(relationship.table)}]`;
        const helper = `${tableName}_${relationshipName}Relation`;
        const result = typeName(`${tableName}_${relationshipName}`, "Result");
        // A generic parameter, bound to `targetBound` instead of fixed to the generated row type,
        // lets a caller hold a row of its own that carries the joined field and get that same row
        // back. An application often decorates what a hook returned, for example with a dirty
        // flag or a nested author; a parameter fixed to the generated row would either refuse the
        // decorated row or hand back the bare one.
        const targetBound = joinedFieldType(schema, relationship.table, relationship.foreignField);
        const sourceBound = joinedFieldType(schema, tableName, relationship.localField);
        const foreign = JSON.stringify(relationship.foreignField);
        const local = JSON.stringify(relationship.localField);
        const signature = [
          `export function ${helper}<Target extends ${targetBound}>(`,
          "  targets: readonly Target[],",
          `): (source: ${sourceBound}) => ${result}<Target> {`,
        ];
        if (!relationship.many) {
          return [
            `/** The \`${relationship.table}\` row \`${tableName}.${relationshipName}\` joins to, or none this device holds. */`,
            `export type ${result}<Target = ${row}> = Target | undefined;`,
            "",
            `/**`,
            ` * \`${tableName}.${relationshipName}\`, over rows the caller already holds.`,
            ` *`,
            ` * The targets are indexed on \`${relationship.foreignField}\` here, once; the function this returns`,
            ` * answers a source row from that index in a single lookup, instead of a fresh filter over every`,
            ` * target per call. A row may point at a target this device has not synced, which is what`,
            ` * \`undefined\` is.`,
            ` */`,
            ...signature,
            "  const index = new Map<string, Target>();",
            "  for (const target of targets) {",
            `    const key = String(target[${foreign}]);`,
            // First wins, so a duplicate on the far side of a `hasOne` reads the same way twice.
            "    if (!index.has(key)) index.set(key, target);",
            "  }",
            `  return (source) => index.get(String(source[${local}]));`,
            "}",
          ].join("\n");
        }
        joinsMany = true;
        return [
          `/** The \`${relationship.table}\` rows \`${tableName}.${relationshipName}\` joins to, in the order given. */`,
          `export type ${result}<Target = ${row}> = readonly Target[];`,
          "",
          `/**`,
          ` * \`${tableName}.${relationshipName}\`, over rows the caller already holds.`,
          ` *`,
          ` * The targets are indexed on \`${relationship.foreignField}\` here, once; the function this returns`,
          ` * answers a source row from that index in a single lookup, instead of a fresh filter over every`,
          ` * target per call. A source row with nothing on the far side gets the same empty list every time.`,
          ` */`,
          ...signature,
          "  const index = new Map<string, Target[]>();",
          "  for (const target of targets) {",
          `    const key = String(target[${foreign}]);`,
          "    const bucket = index.get(key);",
          "    if (bucket === undefined) index.set(key, [target]);",
          "    else bucket.push(target);",
          "  }",
          `  return (source) => index.get(String(source[${local}])) ?? weftNoRows;`,
          "}",
        ].join("\n");
      }),
    )
    .join("\n\n");
  if (helpers.length === 0) return "export {};\n";
  const header: string[] = [];
  // The same `Database` the bindings import, from the same place, since `weft generate` writes
  // both files into one directory. Whether the import is emitted at all is read off what the
  // helpers actually reference, because each relationship can reach for it from the result type
  // and from either side of the join.
  if (helpers.includes("Database[")) header.push('import type { Database } from "./database.d.ts";', "");
  if (joinsMany) {
    header.push(
      "// One array for every miss in the file. A fresh `[]` per lookup is a new identity per render,",
      "// which is what a memoised child compares against.",
      "const weftNoRows: readonly never[] = [];",
      "",
    );
  }
  return `${header.join("\n")}${header.length === 0 ? "" : "\n"}${helpers}\n`;
}

/**
 * What one side of a join has to carry for the accessor to read its key, the generated row type
 * narrowed to the single field the relationship names.
 *
 * A field the collection does not declare has no such type, reachable only through a
 * `SchemaDefinition` that never passed `defineSchema`, the same way an unresolvable target table
 * is. `Pick` of a name that is not a key would be a compile error where `weft doctor` gives only
 * a warning, so this falls back to `Readonly<Record<string, unknown>>` instead.
 */
function joinedFieldType(schema: SchemaDefinition, table: string, field: string): string {
  const collection = schema.collections[table];
  if (collection === undefined || !Object.hasOwn(collection.fields, field)) {
    return "Readonly<Record<string, unknown>>";
  }
  return `Pick<Database[${JSON.stringify(table)}], ${JSON.stringify(field)}>`;
}

export function generateNestedMappers(schema: SchemaDefinition): string {
  const mappers = Object.entries(schema.collections)
    .filter(([, collection]) => Object.keys(collection.fields).some((fieldName) => fieldName.includes("__")))
    .map(([tableName, collection]) => generateNestedMapper(tableName, collection));
  if (mappers.length === 0) return "export {};\n";
  // One `assignNested` definition for the file no matter how many collections nest fields,
  // because a copy per mapper would be a duplicate function implementation and a compile error.
  return `${[...mappers, ASSIGN_NESTED].join("\n\n")}\n`;
}

function typeFields(collection: CollectionDefinition): string {
  return Object.entries(collection.fields)
    .map(([name, field]) => `    ${propertyName(name)}: ${tsType(field)};`)
    .join("\n");
}

function enumCheck(name: string, field: FieldDefinition): string {
  if (field.values === undefined) return "";
  // An enum member is stored as the bare string it is, so the constraint lists exactly the
  // values the schema declares, the same set the generated union offers.
  const allowed = field.values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
  return ` CHECK (${quoteIdent(name)} IN (${allowed})${field.nullable ? ` OR ${quoteIdent(name)} IS NULL` : ""})`;
}

function domainColumnDdl(name: string, field: FieldDefinition, mode: "create" | "alter"): string {
  return `${quoteIdent(name)} ${sqliteType(field)}${field.nullable ? "" : " NOT NULL"}${mode === "alter" && !field.nullable ? ` DEFAULT ${sqlDefaultLiteral(field)}` : ""}${enumCheck(name, field)}`;
}

function sqliteType(field: FieldDefinition): string {
  // One source decides both the column type here and what the client store writes into a field,
  // so a value's storage type and its column type cannot independently drift apart. `date`
  // columns hold ISO-8601 text, which the client actually writes and which sorts chronologically
  // under SQLite's own text collation.
  const storage = fieldStorage(field);
  return storage === "number" || storage === "boolean" ? "INTEGER" : "TEXT";
}

function tsType(field: FieldDefinition): string {
  // An enum is worth its values. A row typed `"open" | "done"` is checked wherever it is used,
  // while `string` would only be checked at the database.
  const base =
    field.values !== undefined
      ? field.values.map((value) => JSON.stringify(value)).join(" | ")
      : field.type === "number"
        ? "number"
        : field.type === "boolean"
          ? "boolean"
          : field.type === "json"
            ? // A json field the schema says nothing more about really is unknown; one that
              // declares a type is worth that type, in the row, in the mutation, and in the
              // decoder, so neither reading it nor writing it costs the application a cast.
              (field.jsonType?.as ?? "unknown")
            : "string";
  return field.nullable ? `${base} | null` : base;
}

/**
 * Every declared json type in the schema, once each, in the order the schema names them.
 *
 * Two fields may share a type, for example a `Tags` used on three collections importing it once,
 * but two different types cannot share a name, because the generated file has one namespace and
 * would import the second over the first. This is checked by name here, so a name collision is
 * caught before it becomes a redeclared import failing inside machine-written code.
 */
function declaredJsonTypes(schema: SchemaDefinition): readonly JsonTypeReference[] {
  const claimed = new Map<string, { readonly reference: JsonTypeReference; readonly path: string }>();
  for (const [tableName, collection] of Object.entries(schema.collections)) {
    for (const [fieldName, field] of Object.entries(collection.fields)) {
      if (field.type !== "json" || field.jsonType === undefined) continue;
      const path = `${tableName}.${fieldName}`;
      const existing = claimed.get(field.jsonType.as);
      if (existing === undefined) {
        claimed.set(field.jsonType.as, { reference: field.jsonType, path });
        continue;
      }
      if (existing.reference.from !== field.jsonType.from) {
        throw new Error(
          `json types on ${existing.path} and ${path} are both named ${JSON.stringify(field.jsonType.as)} but come ` +
            "from different modules; rename one of them so the generated code can tell them apart",
        );
      }
    }
  }
  return [...claimed.values()].map((entry) => entry.reference);
}

/** `import type { … }` for the declared json types, one line per module they come from. */
function jsonTypeImports(schema: SchemaDefinition): readonly string[] {
  const byModule = new Map<string, string[]>();
  for (const reference of declaredJsonTypes(schema)) {
    if (reference.from === undefined) continue;
    const names = byModule.get(reference.from);
    if (names === undefined) byModule.set(reference.from, [reference.as]);
    else names.push(reference.as);
  }
  return [...byModule].map(([from, names]) => `import type { ${names.join(", ")} } from ${JSON.stringify(from)};`);
}

/**
 * What the schema cannot check about a declared json type, the generated bindings can. The value
 * is stored with `encodeWireValue`, so a type JSON cannot carry describes a field that throws on
 * its first write. Instantiating the check below with such a type fails to compile in the
 * generated file, which is the earliest point a generated file can catch it.
 */
function jsonTypeGuard(schema: SchemaDefinition): readonly string[] {
  const declared = declaredJsonTypes(schema);
  if (declared.length === 0) return [];
  return [
    "/**",
    " * A json field is stored as JSON, so a type declared for one has to be a type JSON can carry.",
    " * Assignability to `WireValue` alone is the wrong test, because an `interface` has no",
    " * implicit index signature however plain its properties are, so it would refuse most of what",
    " * an application declares. This walks the type instead, checking that it is an array of",
    " * carriable elements or an object whose every property is carriable, and stops at a method,",
    " * which is what a `Date` or a `Map` reduces to and what has no wire form at all.",
    " */",
    "type WeftJsonCarriable<Value> = Value extends WireValue",
    "  ? Value",
    "  : Value extends (...args: never[]) => unknown",
    "    ? never",
    "    : Value extends readonly (infer Element)[]",
    "      ? readonly WeftJsonCarriable<Element>[]",
    "      : Value extends object",
    "        ? { readonly [Key in keyof Value]: WeftJsonCarriable<Value[Key]> }",
    "        : never;",
    "type WeftDeclaredJson<Value extends Carriable, Carriable> = Value;",
    // Exported, though nothing imports them. A type alias that is only ever declared is TS6196
    // under `noUnusedLocals`, which Vite's React-TypeScript template turns on, so a generated file
    // that kept these local would fail the build of the application it was generated for.
    ...declared.map(
      (reference, index) =>
        `export type WeftJsonCheck${index + 1} = WeftDeclaredJson<${reference.as}, WeftJsonCarriable<${reference.as}>>;`,
    ),
    "",
  ];
}

function defaultLiteral(field: FieldDefinition): string {
  // A non-nullable enum has no empty value to fall back to, so it falls back to its first.
  if (field.values?.[0] !== undefined) return JSON.stringify(field.values[0]);
  if (field.type === "number" || field.type === "boolean") return "0";
  return "''";
}

/**
 * What an added column holds for rows written before it existed. Because a column added to an
 * existing table is read by the same decoder as one declared with the table, this has to be the
 * stored form, so a number defaults to a number and a string to a bare string.
 */
function sqlDefaultLiteral(field: FieldDefinition): string {
  if (field.values?.[0] !== undefined) return `'${field.values[0].replaceAll("'", "''")}'`;
  switch (fieldStorage(field)) {
    case "number":
    case "boolean":
      return "0";
    case "json":
      // A json column holds JSON text, so its empty value has to parse as JSON.
      return `'${JSON.stringify("").replaceAll("'", "''")}'`;
    case "text":
      return "''";
  }
}

/** `todo_events` + `Query` becomes `todoEventsQuery`, a value identifier lowercased from `typeName`. */
function memberName(input: string, suffix: string): string {
  const pascal = typeName(input, suffix);
  return `${pascal[0]?.toLowerCase() ?? ""}${pascal.slice(1)}`;
}

function typeName(input: string, suffix: string): string {
  return `${input
    .split(/[^A-Za-z0-9]/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("")}${suffix}`;
}

function generateNestedMapper(tableName: string, collection: CollectionDefinition): string {
  const nestedFields = Object.keys(collection.fields).filter((fieldName) => fieldName.includes("__"));
  const assignments = nestedFields.map((field) => {
    const path = field.split("__");
    const quotedPath = path.map((part) => JSON.stringify(part)).join(", ");
    return `  assignNested(output, [${quotedPath}], row[${JSON.stringify(field)}]);`;
  });
  return [
    `export function map${typeName(tableName, "Row")}(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {`,
    "  const output: Record<string, unknown> = { ...row };",
    ...nestedFields.map((field) => `  delete output[${JSON.stringify(field)}];`),
    ...assignments,
    "  return output;",
    "}",
  ].join("\n");
}

const ASSIGN_NESTED = [
  "function assignNested(target: Record<string, unknown>, path: readonly string[], value: unknown): void {",
  "  let cursor: Record<string, unknown> = target;",
  "  for (let index = 0; index < path.length; index += 1) {",
  "    const segment = path[index];",
  "    if (segment === undefined) return;",
  "    if (index === path.length - 1) {",
  "      cursor[segment] = value;",
  "      return;",
  "    }",
  "    const next = cursor[segment];",
  "    if (typeof next !== 'object' || next === null || Array.isArray(next)) {",
  "      const created: Record<string, unknown> = {};",
  "      cursor[segment] = created;",
  "      cursor = created;",
  "    } else {",
  "      cursor = next as Record<string, unknown>;",
  "    }",
  "  }",
  "}",
].join("\n");

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/**
 * A key in a generated interface or object literal. A field name is whatever the schema says it
 * is, and `first-name` is a perfectly good column, but only some field names are valid
 * identifiers, so an unquoted one would not parse.
 */
function propertyName(value: string): string {
  return TS_IDENTIFIER.test(value) ? value : JSON.stringify(value);
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const BASE_FIELD_NAMES = new Set(["id", "scope_id", "created"]);
