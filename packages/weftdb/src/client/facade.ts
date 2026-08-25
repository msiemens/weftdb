import { fieldName, rowId, tableName, type FieldName, type TxnId, type WireValue } from "weftdb/shared";
import type { CollectionDefinition, FieldValue, SchemaDefinition } from "weftdb/schema";
import type { MaterializedRow, WeftClient } from "./index.ts";

type CollectionNames<Schema extends SchemaDefinition> = Extract<keyof Schema["collections"], string>;
type FieldNames<Collection extends CollectionDefinition> = Extract<keyof Collection["fields"], string>;
type DomainFieldNames<Collection extends CollectionDefinition> = Exclude<
  FieldNames<Collection>,
  "id" | "scope_id" | "created"
>;

export type MutationInput<Collection extends CollectionDefinition> = Partial<{
  readonly [Name in DomainFieldNames<Collection>]: FieldValue<Collection["fields"][Name]>;
}>;

export interface CollectionFacade<Collection extends CollectionDefinition> {
  create(id: string, values: MutationInput<Collection>, txnId?: TxnId): void;
  update(id: string, values: MutationInput<Collection>, txnId?: TxnId): void;
  delete(id: string, txnId?: TxnId): void;
  get(id: string): MaterializedRow | undefined;
  list(): MaterializedRow[];
}

export class WeftDb<Schema extends SchemaDefinition> {
  readonly client: WeftClient;
  readonly schema: Schema;

  constructor(client: WeftClient, schema: Schema) {
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
  client: WeftClient,
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
