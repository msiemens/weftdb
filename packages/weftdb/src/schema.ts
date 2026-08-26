import { schemaHashValue, stableHash } from "weftdb/core";
import type { MergeStrategy } from "weftdb/core";
import type { SchemaHash, WireValue } from "weftdb/core";

export interface FieldDefinition {
  type: "string" | "number" | "boolean" | "json" | "date" | "enum";
  merge: MergeStrategy;
  nullable: boolean;
  retentionAnchor?: boolean;
  /** The values an `enum` field may hold. Everything else leaves this undefined. */
  values?: readonly string[];
  /**
   * Whether the generated client DDL carries an index on this field.
   *
   * Codegen cannot tell which fields an application filters or orders on, so the schema says. Like
   * `jsonType` it is read only by the generator and stays out of the wire schema and out of the
   * hash: an index is a fact about how one device reads its own file, and hashing it would make a
   * device that added one look like a device on another schema.
   */
  index?: boolean;
  /**
   * The TypeScript type a `json` field holds. Only the generator reads it, and only to write a
   * name where it would otherwise write `unknown`: it is not part of what two devices have to
   * agree on, so it stays out of the wire schema and out of the schema hash. What travels is a
   * `WireValue` either way.
   */
  jsonType?: JsonTypeReference;
}

declare const jsonValue: unique symbol;

/**
 * The TypeScript type a `json` field holds, carried on the definition's type and nowhere in its
 * value. Nothing reads this property, and nothing sets it: it exists so `FieldValue` can recover
 * the declared type, which the generated files get from `JsonTypeReference.as` instead.
 *
 * Both are needed, and neither replaces the other. `as` is a string, and a string cannot become a
 * type, so it is no use to the hand-written types that read a schema, `FieldValue` among them. A
 * type parameter is a type, and it is erased before the generator, which reads the schema as a
 * runtime value, ever sees it. So `S.json<SortConfig>({ as: "SortConfig" })` says the same thing
 * twice because the two halves are read by different things.
 */
export interface JsonValued<Value> {
  readonly [jsonValue]: (value: Value) => void;
}

/** A `json` field's declared type, as the generated files have to write it down. */
export interface JsonTypeReference {
  /** The type expression the generated files use: `Tags`, or `readonly string[]`. */
  readonly as: string;
  /**
   * Where to import {@link as} from, written the way the generated files import it — so relative
   * to the output directory `weft generate --out` was given, next to `bindings.ts`. Left off for
   * a type expression that needs no import.
   */
  readonly from?: string;
}

export interface CollectionDefinition {
  kind: "collection" | "eventLog";
  fields: Record<string, FieldDefinition>;
  relationships: Record<string, RelationshipDefinition>;
}

export interface RelationshipDefinition {
  table: string;
  localField: string;
  foreignField: string;
  many: boolean;
}

/**
 * A relationship that still remembers the three names it was written with. `S.hasMany("issues",
 * "id", "project_id")` is a `RelationshipDefinition` whose `table` is `"issues"` rather than
 * `string`, which is what lets {@link defineSchema} check the join against the rest of the schema
 * at the point it is declared instead of at the point it fails to match anything.
 */
export type RelationshipTo<
  Table extends string,
  LocalField extends string,
  ForeignField extends string,
  Many extends boolean,
> = RelationshipDefinition & {
  readonly table: Table;
  readonly localField: LocalField;
  readonly foreignField: ForeignField;
  readonly many: Many;
};

export interface SchemaDefinition {
  collections: Record<string, CollectionDefinition>;
  schemaVersion: number;
}

/**
 * The fields a collection actually declares.
 *
 * `CollectionDefinition["fields"]` is `Record<string, FieldDefinition>`, and `keyof` on anything
 * carrying an index signature is `string`. A mapped type written over it therefore collapses into
 * an index signature of its own, and every field's type becomes the constraint rather than the one
 * it was declared with: a json field with a declared type reads back as `WireValue`, an enum reads
 * back as `string`. Dropping the index signature first is what keeps the declaration.
 */
export type DeclaredFieldNames<Collection extends CollectionDefinition> = Extract<
  keyof {
    [Name in keyof Collection["fields"] as string extends Name ? never : number extends Name ? never : Name]: 0;
  },
  string
>;

export type EntityOf<Collection extends CollectionDefinition> = {
  readonly [Name in DeclaredFieldNames<Collection>]: FieldValue<Collection["fields"][Name]>;
};

export type DatabaseOf<Schema extends SchemaDefinition> = {
  readonly [Name in keyof Schema["collections"]]: EntityOf<Schema["collections"][Name]>;
};

/** An enum field is worth exactly its literal values, so those come before the type mapping. */
export type FieldValue<Field extends FieldDefinition> = Field["nullable"] extends true
  ? DeclaredValue<Field> | null
  : DeclaredValue<Field>;

/**
 * A declared json type first: a field that carries one is worth exactly that type, and everything
 * reading a schema should say so, because falling back to `WireValue` makes the caller assert its
 * way out on every read and every write.
 */
type DeclaredValue<Field extends FieldDefinition> =
  Field extends JsonValued<infer Value>
    ? Value
    : Field extends { values: readonly (infer Value)[] }
      ? Value
      : ScalarType<Field["type"]>;

/** A `date` is an ISO-8601 string: what the client writes and what the column holds. */
export type ScalarType<Type extends FieldDefinition["type"]> = Type extends "number"
  ? number
  : Type extends "boolean"
    ? boolean
    : Type extends "json"
      ? import("weftdb/core").WireValue
      : string;

/**
 * A field definition that still remembers the two things its declaration said about it.
 *
 * `FieldDefinition` is the shape every field has, and both of the facts a schema author writes
 * down are flattened in it: `type` is the whole union, and `nullable` is `boolean`. That is enough
 * for the generator, which reads a schema as a runtime value and sees the real ones — and it is
 * exactly not enough for everything that reads a schema as a type. `ScalarType` distributes over
 * the union and collapses to `WireValue`, so `S.string()` read back as anything the wire can
 * carry; `boolean` does not extend `true`, so a nullable field read back as not nullable. The two
 * halves have to be carried together, because fixing either one alone makes the other wrong:
 * a literal `type` stops the collapse to `WireValue`, and a `boolean` `nullable` then never adds
 * the `| null` that a nullable field exists to hold.
 */
export type FieldOf<Type extends FieldDefinition["type"], Nullable extends boolean> = Omit<
  FieldDefinition,
  "type" | "nullable"
> & {
  readonly type: Type;
  readonly nullable: Nullable;
};

/**
 * What a builder takes, with `nullable` left as a type parameter so the literal `true` written at
 * the call survives into what the builder returns. `Nullable` defaults to `boolean` for the
 * positions that only describe the shape; the builders default it to `false`, which is what a
 * field that says nothing about nullability is.
 */
type FieldOptions<Nullable extends boolean = boolean> = Partial<
  Pick<FieldDefinition, "merge" | "retentionAnchor" | "index">
> & {
  readonly nullable?: Nullable;
};

type JsonFieldOptions<Nullable extends boolean = boolean> = FieldOptions<Nullable> & Partial<JsonTypeReference>;

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/**
 * A declared json type has to survive being written into an import and a type position. The name
 * is emitted verbatim, so an empty one produces `readonly : string` and an unparseable one
 * produces a generated file nothing can compile — errors that surface as a syntax error in
 * machine-written code rather than as a mistake in the schema, which is where it was made.
 */
function assertDeclaredJsonType(reference: JsonTypeReference): void {
  if (reference.as.trim().length === 0) throw new Error("a json field's declared type cannot be empty");
  if (reference.from === undefined) return;
  if (reference.from.trim().length === 0)
    throw new Error(`json type ${reference.as} declares an empty module to import from`);
  // Only what goes inside `import type { … }` has to be a bare identifier. A type expression
  // written inline — `readonly string[]` — needs no import and is free to be an expression.
  if (!TS_IDENTIFIER.test(reference.as)) {
    throw new Error(
      `json type ${JSON.stringify(reference.as)} is imported from ${JSON.stringify(reference.from)}, so it has to be ` +
        "a single identifier; drop `from` to use a type expression that needs no import",
    );
  }
}

/**
 * The three keys every field has, in that order, plus each optional one only where it was given.
 * `schemaHash` is computed from `toWireSchema` rather than from this, and it is protocol visible —
 * two devices that disagree on it refuse to sync. The cast is what the compiler is told about the
 * value: `nullable` is a `boolean` at runtime and the literal `Nullable` in the type, and the
 * boolean written is `options.nullable` itself, which is what `Nullable` was inferred from.
 */
function field<Type extends FieldDefinition["type"], const Nullable extends boolean = false>(
  type: Type,
  options: FieldOptions<Nullable> = {},
): FieldOf<Type, Nullable> {
  const definition: FieldDefinition = {
    type,
    merge: options.merge ?? "lww",
    nullable: options.nullable ?? false,
  };
  if (options.retentionAnchor !== undefined) definition.retentionAnchor = options.retentionAnchor;
  if (options.index !== undefined) definition.index = options.index;
  return definition as FieldOf<Type, Nullable>;
}

/**
 * A value JSON can carry. `as` names the TypeScript type it holds — `S.json({ as: "Tags", from:
 * "../types.ts" })` — and the generated row type, mutation type and decoder say `Tags` where
 * they would otherwise say `unknown`, which is what an application would have to cast its way
 * out of on every read. Declaring nothing keeps `unknown`, which is the honest answer for a
 * field whose shape the schema does not fix.
 *
 * The type is the author's to keep JSON-serialisable. The generated bindings check what they
 * can — a declared type that reduces to methods, as a `Date` or a `Map` does, has no wire form
 * and fails to compile there — but nothing here can see through a name to what it will hold.
 *
 * Overloaded rather than generic in the nullability, because this is the one builder anybody
 * writes an explicit type argument on. Supplying one type argument stops the rest being inferred
 * and falls back to their defaults, so a second type parameter would have made
 * `S.json<SortConfig>({ nullable: true })` quietly non-nullable — the half-fix this whole shape
 * exists to avoid. Overloads choose on the argument instead, and each carries the one type
 * parameter `Value` that a call may name. The last is the widened case: options assembled at
 * runtime say `boolean`, which pins nothing either way and is accepted as it stands.
 */
function jsonField<Value = WireValue>(
  options: JsonFieldOptions & { readonly nullable: true },
): FieldOf<"json", true> & JsonValued<Value>;
function jsonField<Value = WireValue>(
  options?: JsonFieldOptions & { readonly nullable?: false },
): FieldOf<"json", false> & JsonValued<Value>;
function jsonField<Value = WireValue>(options?: JsonFieldOptions): FieldOf<"json", boolean> & JsonValued<Value>;
function jsonField<Value = WireValue>(options?: JsonFieldOptions): FieldDefinition & JsonValued<Value> {
  const definition = field("json", options);
  // Cast because the brand is a type and not a value: nothing sets the property, nothing reads
  // it, and it is keyed by a symbol nothing outside this module can name.
  if (options?.as === undefined) return definition as FieldDefinition & JsonValued<Value>;
  const reference: JsonTypeReference =
    options.from === undefined ? { as: options.as } : { as: options.as, from: options.from };
  assertDeclaredJsonType(reference);
  return { ...definition, jsonType: reference } as FieldDefinition & JsonValued<Value>;
}

export const S = {
  string: <const Nullable extends boolean = false>(options?: FieldOptions<Nullable>): FieldOf<"string", Nullable> =>
    field("string", options),
  number: <const Nullable extends boolean = false>(options?: FieldOptions<Nullable>): FieldOf<"number", Nullable> =>
    field("number", options),
  boolean: <const Nullable extends boolean = false>(options?: FieldOptions<Nullable>): FieldOf<"boolean", Nullable> =>
    field("boolean", options),
  json: jsonField,
  date: <const Nullable extends boolean = false>(options?: FieldOptions<Nullable>): FieldOf<"date", Nullable> =>
    field("date", options),
  /**
   * A string from a fixed set. The values are carried on the definition, so the generated row
   * type is the union rather than `string`, the mutators refuse anything else before it can be
   * written, and the column gets a `CHECK` that says the same thing to the database.
   */
  enum: <const Values extends readonly [string, ...string[]], const Nullable extends boolean = false>(
    values: Values,
    options?: FieldOptions<Nullable>,
  ): FieldOf<"enum", Nullable> & { readonly values: Values } => {
    if (new Set(values).size !== values.length) throw new Error(`enum values repeat: ${values.join(", ")}`);
    return { ...field("enum", options), type: "enum", values };
  },
  collection: <
    const Fields extends Record<string, FieldDefinition>,
    const Relationships extends Record<string, RelationshipDefinition> = Record<string, never>,
  >(
    fields: Fields,
    relationships: Relationships = {} as Relationships,
  ): CollectionDefinition & {
    readonly fields: Fields & BaseFieldDefinitions;
    readonly relationships: Relationships;
  } => ({
    kind: "collection",
    fields: withBaseFields(fields),
    relationships,
  }),
  eventLog: <
    const Fields extends Record<string, FieldDefinition>,
    const Relationships extends Record<string, RelationshipDefinition> = Record<string, never>,
  >(
    fields: Fields,
    relationships: Relationships = {} as Relationships,
  ): CollectionDefinition & {
    readonly fields: Fields & BaseFieldDefinitions;
    readonly relationships: Relationships;
  } => ({
    kind: "eventLog",
    fields: withBaseFields(fields),
    relationships,
  }),
  /**
   * The rows of `table` whose `foreignField` holds this row's `localField`. The three names are
   * kept as the literals they were written as, so `defineSchema` can refuse a join that names a
   * collection or a field the schema does not have — see {@link ValidRelationships}.
   */
  hasMany: <const Table extends string, const LocalField extends string, const ForeignField extends string>(
    table: Table,
    localField: LocalField,
    foreignField: ForeignField,
  ): RelationshipTo<Table, LocalField, ForeignField, true> => ({
    table,
    localField,
    foreignField,
    many: true,
  }),
  /** The single row of `table` whose `foreignField` holds this row's `localField`, or none. */
  hasOne: <const Table extends string, const LocalField extends string, const ForeignField extends string>(
    table: Table,
    localField: LocalField,
    foreignField: ForeignField,
  ): RelationshipTo<Table, LocalField, ForeignField, false> => ({
    table,
    localField,
    foreignField,
    many: false,
  }),
};

/**
 * The names a relationship is allowed to have named, said as types: its `table` is one of the
 * schema's collections, its `localField` a field of the collection declaring it, and its
 * `foreignField` a field of the collection it names. The constraint rides on `defineSchema`'s
 * parameter rather than on the type parameter's own `extends` clause — inferring `Collections`
 * from something that is itself computed from `Collections` goes circular, and every collection
 * collapses to `never` — and `NoInfer` keeps this half of the intersection out of inference
 * entirely, so what a schema is worth is decided by the schema alone.
 *
 * Only `relationships` is mentioned, so a collection that declares none is constrained by nothing
 * and a schema without relationships is inferred exactly as it was before.
 */
export type ValidRelationships<Collections extends Record<string, CollectionDefinition>> = {
  readonly [Table in keyof Collections]: {
    readonly relationships: {
      readonly [Name in DeclaredKeys<Collections[Table]["relationships"]>]: ValidRelationship<
        Collections,
        Table,
        Collections[Table]["relationships"][Name]
      >;
    };
  };
};

/**
 * The keys a type declares by name, with an index signature's `string` left out. What
 * `S.collection` returns is intersected with `CollectionDefinition`, whose `fields` is a
 * `Record<string, FieldDefinition>` — and `keyof` an intersection that includes an index signature
 * is `string`, which would have checked every field name against everything and caught nothing.
 */
type DeclaredKeys<Type> = keyof {
  [Key in keyof Type as string extends Key ? never : number extends Key ? never : Key]: Key;
} &
  keyof Type;

/**
 * Each name is constrained to the union of the names that would resolve, so the compiler reports
 * the typo itself — `Type '"issus"' is not assignable to type '"projects" | "issues"'` — rather
 * than a wall of structural text. A `foreignField` whose `table` did not resolve is left as
 * `string`: the table is already being reported, and a second error about the fields of a
 * collection that does not exist would only bury it.
 */
type ValidRelationship<
  Collections extends Record<string, CollectionDefinition>,
  Table extends keyof Collections,
  Relationship,
> = Relationship extends {
  readonly table: infer Target;
  readonly localField: infer Local;
  readonly foreignField: infer Foreign;
}
  ? {
      readonly table: CheckedName<Target, DeclaredKeys<Collections> & string>;
      readonly localField: CheckedName<Local, DeclaredKeys<Collections[Table]["fields"]> & string>;
      readonly foreignField: CheckedName<
        Foreign,
        Target extends keyof Collections ? DeclaredKeys<Collections[Target]["fields"]> & string : string
      >;
    }
  : Relationship;

/**
 * A name the compiler can still read as the literal it was written as is held to `Allowed`. One
 * it cannot — a `RelationshipDefinition` assembled where the strings are only known at runtime —
 * is left exactly as it is: there is nothing to check it against, and refusing it would refuse
 * every schema built from data, which `defineSchema` accepts and checks itself.
 */
type CheckedName<Declared, Allowed extends string> = string extends Declared ? Declared : Allowed;

export function defineSchema<const Collections extends Record<string, CollectionDefinition>>(
  collections: Collections & NoInfer<ValidRelationships<Collections>>,
  schemaVersion = 1,
): SchemaDefinition & { readonly collections: Collections; readonly schemaVersion: number } {
  for (const [tableName, collection] of Object.entries(collections)) {
    assertUsableName(tableName, tableName);
    for (const fieldName of Object.keys(collection.fields)) {
      assertUsableName(`${tableName}.${fieldName}`, fieldName);
    }
  }
  assertDistinctSqlNames(collections);
  // A second pass, so a schema that is wrong in both ways is told about its names first: a
  // relationship into a collection whose own name is unusable is the lesser of the two problems.
  for (const [tableName, collection] of Object.entries(collections)) {
    for (const [relationshipName, relationship] of Object.entries(collection.relationships)) {
      assertResolvableRelationship(collections, tableName, relationshipName, relationship);
    }
  }
  return { collections, schemaVersion };
}

/**
 * A relationship is three names into the rest of the schema, and nothing downstream catches a typo
 * in one: the join matches no row at runtime, and — since the generator reads the target collection
 * to type the result — the result is quietly typed `unknown` rather than the build failing. Here is
 * the last point at which the mistake is still a line in the schema.
 */
function assertResolvableRelationship(
  collections: Record<string, CollectionDefinition>,
  tableName: string,
  relationshipName: string,
  relationship: RelationshipDefinition,
): void {
  const path = `${tableName}.${relationshipName}`;
  const target = collections[relationship.table];
  if (target === undefined) {
    throw new Error(`${path} joins to ${JSON.stringify(relationship.table)}, which this schema does not define`);
  }
  const declaring = collections[tableName];
  if (declaring === undefined || !Object.hasOwn(declaring.fields, relationship.localField)) {
    throw new Error(
      `${path} joins on ${tableName}.${JSON.stringify(relationship.localField)}, which ${tableName} does not declare`,
    );
  }
  if (!Object.hasOwn(target.fields, relationship.foreignField)) {
    throw new Error(
      `${path} joins on ${relationship.table}.${JSON.stringify(relationship.foreignField)}, which ` +
        `${relationship.table} does not declare`,
    );
  }
}

/**
 * A name has to survive being written down. Quoting handles punctuation, but a control
 * character does not survive the trip: SQLite truncates an identifier at a NUL, so a field
 * named with one silently becomes a different, shorter column — and two such names can become
 * the same one. Refusing here is the only point at which that is still obvious.
 */
function assertUsableName(path: string, name: string): void {
  if (name.length === 0) throw new Error(`${path || "a collection"} has an empty name`);
  // The control characters are what this is looking for, so the rule has nothing to warn about.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error(`${path} contains a control character, which cannot survive as a column name`);
  }
}

/**
 * A name as SQLite compares it. Two identifiers match when they differ only in the case of an
 * ASCII letter, and SQLite folds nothing beyond that: `Ä` and `ä` are two distinct columns.
 * `String.prototype.toLowerCase` folds the whole Unicode case table, so a check built on it would
 * refuse pairs the database has no trouble holding.
 */
function sqlIdentity(name: string): string {
  return name.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

/** The tables the client DDL creates whatever the schema says, alongside every collection. */
const FRAMEWORK_TABLES: ReadonlySet<string> = new Set(["outbox", "outbox_quarantine", "tombstones", "sync_state"]);

/**
 * Every name a schema hands SQLite, held to what SQLite can tell apart.
 *
 * Two identifiers that fold together are one identifier. Two columns of one table are a
 * `duplicate column name`, so the `CREATE TABLE` fails, the install script fails with it, and the
 * device is left with no database at all. Two tables are quieter and worse: every framework table
 * and every collection is created `IF NOT EXISTS` in one file, so the second `CREATE TABLE` does
 * nothing and that collection spends the life of the database reading and writing the first
 * one's columns — a collection named `outbox` is the outbox.
 *
 * Indexes share the table namespace, so `CREATE INDEX "a_b"` against a table named `a_b` is an
 * outright error. An index name is a collection joined to one of its fields and either half may
 * already carry the separator, so a collection `a_b` and an indexed `a.b` arrive as one name
 * without either declaration looking unusual.
 *
 * `_weft_` covers the columns the generator adds per field — `_weft_hlc_<field>`,
 * `_weft_base_<field>` — as well as the four fixed ones, and folding the prefix is what keeps
 * `_WEFT_rev` out.
 */
export function assertDistinctSqlNames(collections: Readonly<Record<string, CollectionDefinition>>): void {
  const tables = new Map<string, string>();
  for (const tableName of Object.keys(collections)) {
    const identity = sqlIdentity(tableName);
    if (FRAMEWORK_TABLES.has(identity)) {
      throw new Error(
        `collection ${JSON.stringify(tableName)} collides with the framework's own ${identity} table, which the ` +
          "client DDL creates in the same database",
      );
    }
    const claimed = tables.get(identity);
    if (claimed !== undefined) {
      throw new Error(
        `collections ${JSON.stringify(claimed)} and ${JSON.stringify(tableName)} are one table to SQLite, which ` +
          "ignores the case of an ASCII letter in an identifier",
      );
    }
    tables.set(identity, tableName);
  }

  for (const [tableName, collection] of Object.entries(collections)) {
    const columns = new Map<string, string>();
    for (const fieldName of Object.keys(collection.fields)) {
      const identity = sqlIdentity(fieldName);
      if (identity.startsWith("_weft_")) {
        throw new Error(`${tableName}.${fieldName} uses reserved _weft_ prefix`);
      }
      const claimed = columns.get(identity);
      if (claimed !== undefined) {
        throw new Error(
          `${tableName}.${claimed} and ${tableName}.${fieldName} are one column to SQLite, which ignores the case ` +
            "of an ASCII letter in an identifier",
        );
      }
      columns.set(identity, fieldName);
    }
  }

  const indexes = new Map<string, string>();
  for (const [tableName, collection] of Object.entries(collections)) {
    for (const [fieldName, definition] of Object.entries(collection.fields)) {
      if (definition.index !== true) continue;
      // The name `indexDdl` gives it in the generated DDL.
      const indexName = `${tableName}_${fieldName}`;
      const identity = sqlIdentity(indexName);
      const table = tables.get(identity);
      if (table !== undefined || FRAMEWORK_TABLES.has(identity)) {
        throw new Error(
          `the index on ${tableName}.${fieldName} is named ${JSON.stringify(indexName)}, which is already the table ` +
            `${JSON.stringify(table ?? identity)}; SQLite keeps indexes and tables in one namespace`,
        );
      }
      const claimed = indexes.get(identity);
      if (claimed !== undefined) {
        throw new Error(
          `the indexes on ${claimed} and ${tableName}.${fieldName} are both named ${JSON.stringify(indexName)}, so ` +
            "only the first of the two is ever created",
        );
      }
      indexes.set(identity, `${tableName}.${fieldName}`);
    }
  }
}

export function schemaHash(schema: SchemaDefinition): SchemaHash {
  return schemaHashValue(stableHash(toWireSchema(schema)));
}

function toWireSchema(schema: SchemaDefinition): WireValue {
  return {
    schemaVersion: schema.schemaVersion,
    collections: Object.fromEntries(
      Object.entries(schema.collections).map(([name, collection]) => [
        name,
        {
          kind: collection.kind,
          fields: Object.fromEntries(
            Object.entries(collection.fields).map(([fieldName, field]) => [
              fieldName,
              {
                type: field.type,
                merge: field.merge,
                nullable: field.nullable,
                retentionAnchor: field.retentionAnchor ?? false,
                // The allowed values are part of what the schema says. Two devices that disagree
                // about them disagree about which writes are legal, and a value one accepts
                // fails the other's `CHECK` — which is the situation the hash exists to catch.
                values: field.values === undefined ? null : [...field.values],
                // `jsonType` is deliberately absent. The hash exists to catch two devices that
                // disagree about which writes are legal, and a json field carries a `WireValue`
                // whatever name one device's generated code puts on it. Hashing it would make a
                // device that only renamed a TypeScript type look like a device on another
                // schema, and force a resync for a change no row can tell apart.
              },
            ]),
          ),
          relationships: Object.fromEntries(
            Object.entries(collection.relationships).map(([relationshipName, relationship]) => [
              relationshipName,
              {
                table: relationship.table,
                localField: relationship.localField,
                foreignField: relationship.foreignField,
                many: relationship.many,
              },
            ]),
          ),
        },
      ]),
    ),
  };
}

/**
 * Written out rather than left as three bare `FieldDefinition`s: a row's `id` is a string, and a
 * reader that had to treat it as anything the wire can carry was being told less than the
 * framework knows. These are the definitions {@link withBaseFields} actually writes.
 */
type BaseFieldDefinitions = {
  readonly id: FieldOf<"string", false>;
  readonly scope_id: FieldOf<"string", false>;
  readonly created: FieldOf<"date", false>;
};

/**
 * Base fields are declared last, so a collection that names one of them gets the framework's
 * definition rather than its own. They are the row's identity: the server refuses a write to
 * any of them, the client fills them in, and the generated table keys on `(scope_id, id)`. A
 * schema that could redefine `id` as a nullable number would describe a table the rest of the
 * system does not implement.
 */
function withBaseFields<const Fields extends Record<string, FieldDefinition>>(
  fields: Fields,
): Fields & BaseFieldDefinitions {
  const merged: Record<string, FieldDefinition> = {
    id: field("string", { merge: "immutable" }),
    scope_id: field("string", { merge: "immutable" }),
    created: field("date", { merge: "immutable" }),
    ...fields,
  };
  // Written again after the spread. Assigning a key an object already has leaves it where it
  // was, so the base fields keep their place at the front and a collection that declares one of
  // them gets the framework's definition rather than its own.
  merged["id"] = field("string", { merge: "immutable" });
  merged["scope_id"] = field("string", { merge: "immutable" });
  merged["created"] = field("date", { merge: "immutable" });
  return merged as Fields & BaseFieldDefinitions;
}
