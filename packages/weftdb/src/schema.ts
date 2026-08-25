import { schemaHashValue, stableHash } from "weftdb/core";
import type { MergeStrategy } from "weftdb/core";
import type { SchemaHash, WireValue } from "weftdb/core";

export interface FieldDefinition {
  type: "string" | "number" | "boolean" | "json" | "date" | "enum";
  merge: MergeStrategy;
  nullable: boolean;
  derived?: string;
  retentionAnchor?: boolean;
  /** The values an `enum` field may hold. Everything else leaves this undefined. */
  values?: readonly string[];
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

export interface SchemaDefinition {
  collections: Record<string, CollectionDefinition>;
  schemaVersion: number;
}

export type EntityOf<Collection extends CollectionDefinition> = {
  readonly [Name in keyof Collection["fields"]]: FieldValue<Collection["fields"][Name]>;
};

export type DatabaseOf<Schema extends SchemaDefinition> = {
  readonly [Name in keyof Schema["collections"]]: EntityOf<Schema["collections"][Name]>;
};

/** An enum field is worth exactly its literal values, so those come before the type mapping. */
export type FieldValue<Field extends FieldDefinition> = Field["nullable"] extends true
  ? DeclaredValue<Field> | null
  : DeclaredValue<Field>;

type DeclaredValue<Field extends FieldDefinition> = Field extends { values: readonly (infer Value)[] }
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

type FieldOptions = Partial<Pick<FieldDefinition, "merge" | "nullable" | "derived" | "retentionAnchor">>;

function field(type: FieldDefinition["type"], options: FieldOptions = {}): FieldDefinition {
  const definition: FieldDefinition = {
    type,
    merge: options.merge ?? "lww",
    nullable: options.nullable ?? false,
  };
  if (options.derived !== undefined) definition.derived = options.derived;
  if (options.retentionAnchor !== undefined) definition.retentionAnchor = options.retentionAnchor;
  return definition;
}

export const S = {
  string: (options?: FieldOptions) => field("string", options),
  number: (options?: FieldOptions) => field("number", options),
  boolean: (options?: FieldOptions) => field("boolean", options),
  json: (options?: FieldOptions) => field("json", options),
  date: (options?: FieldOptions) => field("date", options),
  /**
   * A string from a fixed set. The values are carried on the definition, so the generated row
   * type is the union rather than `string`, the mutators refuse anything else before it can be
   * written, and the column gets a `CHECK` that says the same thing to the database.
   */
  enum: <const Values extends readonly [string, ...string[]]>(
    values: Values,
    options?: FieldOptions,
  ): FieldDefinition & { readonly type: "enum"; readonly values: Values } => {
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
  hasMany: (table: string, localField: string, foreignField: string): RelationshipDefinition => ({
    table,
    localField,
    foreignField,
    many: true,
  }),
  hasOne: (table: string, localField: string, foreignField: string): RelationshipDefinition => ({
    table,
    localField,
    foreignField,
    many: false,
  }),
};

export function defineSchema<const Collections extends Record<string, CollectionDefinition>>(
  collections: Collections,
  schemaVersion = 1,
): SchemaDefinition & { readonly collections: Collections; readonly schemaVersion: number } {
  for (const [tableName, collection] of Object.entries(collections)) {
    assertUsableName(tableName, tableName);
    for (const fieldName of Object.keys(collection.fields)) {
      if (fieldName.startsWith("_weft_")) {
        throw new Error(`${tableName}.${fieldName} uses reserved _weft_ prefix`);
      }
      assertUsableName(`${tableName}.${fieldName}`, fieldName);
    }
  }
  return { collections, schemaVersion };
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
                derived: field.derived ?? null,
                retentionAnchor: field.retentionAnchor ?? false,
                // The allowed values are part of what the schema says. Two devices that disagree
                // about them disagree about which writes are legal, and a value one accepts
                // fails the other's `CHECK` — which is the situation the hash exists to catch.
                values: field.values === undefined ? null : [...field.values],
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

type BaseFieldDefinitions = {
  readonly id: FieldDefinition;
  readonly scope_id: FieldDefinition;
  readonly created: FieldDefinition;
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
