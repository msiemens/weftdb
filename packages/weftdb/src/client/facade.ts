import { fieldName, rowId, tableName, type FieldName, type TxnId, type WireValue } from "weftdb/core";
import type { CollectionDefinition, DeclaredFieldNames, FieldValue, SchemaDefinition } from "weftdb/schema";
import type { MaterializedRow } from "./index.ts";
import type { WeftDbTarget } from "./mutation-target.ts";

type CollectionNames<Schema extends SchemaDefinition> = Extract<keyof Schema["collections"], string>;
/** The declared names, not `string`: see `DeclaredFieldNames` for what the index signature does. */
type FieldNames<Collection extends CollectionDefinition> = DeclaredFieldNames<Collection>;
type DomainFieldNames<Collection extends CollectionDefinition> = Exclude<
  FieldNames<Collection>,
  "id" | "scope_id" | "created"
>;

/**
 * `| undefined` rather than `Partial`, because `exactOptionalPropertyTypes` makes the two differ:
 * `Partial` says a key may be absent, and a caller spreading a value it does not always have
 * passes the key holding `undefined`. Refusing that would make the ordinary `{ ...maybe }` shape a
 * type error for the sake of a distinction the writer path does not make either way.
 */
export type MutationInput<Collection extends CollectionDefinition> = {
  readonly [Name in DomainFieldNames<Collection>]?: FieldValue<Collection["fields"][Name]> | undefined;
};

export interface CollectionFacade<Collection extends CollectionDefinition> {
  create(id: string, values: MutationInput<Collection>, txnId?: TxnId): Promise<void>;
  update(id: string, values: MutationInput<Collection>, txnId?: TxnId): Promise<void>;
  delete(id: string, txnId?: TxnId): Promise<void>;
  get(id: string): MaterializedRow | undefined;
  list(): MaterializedRow[];
}

/**
 * A schema-shaped face over a device's writes and reads.
 *
 * The target is structural, so this works over a `WeftClient` on the thread that renders and over a
 * `WeftClientMirror` standing in for one that lives in a worker. Nothing below cares which: a
 * mirror's `create` resolves when the worker has committed the row, and `get` answers from the echo
 * that arrives with it, so the two differ in how long the promise takes and in nothing else.
 */
export class WeftDb<Schema extends SchemaDefinition> {
  readonly client: WeftDbTarget;
  readonly schema: Schema;

  constructor(client: WeftDbTarget, schema: Schema) {
    this.client = client;
    this.schema = schema;
  }

  collection<const Name extends CollectionNames<Schema>>(name: Name): CollectionFacade<Schema["collections"][Name]> {
    const table = tableName(name);
    // An event log's rows are append-class, and the class is decided by the op that opens the
    // row. A `create` here would reach the server as an ordinary mutable row, so the facade's
    // own refusal to edit it would be the only thing protecting it — on this device only.
    const isEventLog = this.schema.collections[name]?.kind === "eventLog";
    return {
      create: (id, values, txnId) =>
        isEventLog
          ? this.client.append(table, rowId(id), toWireRecord(values), txnId)
          : this.client.create(table, rowId(id), toWireRecord(values), txnId),
      update: (id, values, txnId) => this.client.update(table, rowId(id), toWireRecord(values), txnId),
      delete: (id, txnId) => this.client.delete(table, rowId(id), txnId),
      get: (id) => this.client.getRow(table, rowId(id)),
      list: () => this.client.listRows(table),
    };
  }
}

export function createWeftDb<const Schema extends SchemaDefinition>(
  client: WeftDbTarget,
  schema: Schema,
): WeftDb<Schema> {
  return new WeftDb(client, schema);
}

function toWireRecord<Collection extends CollectionDefinition>(
  values: MutationInput<Collection>,
): Record<FieldName, WireValue> {
  const output: Partial<Record<FieldName, WireValue>> = {};
  for (const [key, value] of Object.entries(values) as Array<[DomainFieldNames<Collection>, WireValue | undefined]>) {
    if (value !== undefined) output[fieldName(key)] = value;
  }
  return output as Record<FieldName, WireValue>;
}
