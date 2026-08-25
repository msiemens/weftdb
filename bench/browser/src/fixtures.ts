// The world every case measures against. It is the demo's todo schema and the demo's row shape,
// because the question this harness answers — what a dedicated worker over OPFS costs — is only
// worth asking about the rows an application actually holds.
//
// Node's `bench/fixtures.ts` cannot be reused here: it reaches for `node:fs` and stands a relay up
// over HTTP. What is shared with it is the row, the rank scheme and the transaction ids, so a
// number here and a number there describe the same work.
import {
  deviceId,
  fieldName,
  rowId,
  scopeId,
  tableName,
  txnId,
  type FieldName,
  type RowId,
  type TxnId,
  type WireValue,
} from "weftdb/core";
import { WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { schemaHash } from "weftdb/schema";
import { schema } from "weftdb-demo-todo/schema";
import type { DeltaRow } from "./protocol.ts";

export { schema };

export const SCOPE = scopeId("bench-scope");
export const DEVICE = deviceId("device-0");
export const TODOS = tableName("todos");
export const TITLE = fieldName("title");
export const NOTES = fieldName("notes");
export const DONE = fieldName("done");
export const RANK = fieldName("rank");
export const DUE_AT = fieldName("due_at");
export const AUTO_DELETE_DAYS = fieldName("auto_delete_days");
export const HASH = schemaHash(schema);

export function todoValues(title: string, notes: string, rank: string): Record<FieldName, WireValue> {
  return {
    [TITLE]: title,
    [NOTES]: notes,
    [DONE]: false,
    [RANK]: rank,
    [DUE_AT]: null,
    [AUTO_DELETE_DAYS]: null,
  };
}

/** Ranks are compared as strings, so a padded base-36 counter orders the seeded rows. */
export function rankFor(index: number): string {
  return `a${index.toString(36).padStart(6, "0")}`;
}

export function todoId(index: number): RowId {
  return rowId(`todo-${index.toString(36).padStart(6, "0")}`);
}

/** A note long enough that the field carries real prose rather than a token. */
export function notesFor(index: number): string {
  return Array.from({ length: 8 }, (_unused, line) => `line ${line} of note ${index}`).join("\n");
}

/** The transaction id `weft generate` puts on an update, built the same way it builds it. */
export function updateTxn(id: RowId): TxnId {
  return txnId(`update-${id}-${crypto.randomUUID()}`);
}

/**
 * A device holding `count` rows with an empty outbox, which is what a tab that has synced looks
 * like. The outbox matters more than the row count for the write-through cases: a store rewrites
 * unsent work whole on every save, so seeding without syncing would measure a backlog nobody has.
 */
export function syncedClient(count: number): WeftClient {
  const client = new WeftClient(SCOPE, DEVICE, schema);
  for (let index = 0; index < count; index += 1) {
    const id = todoId(index);
    client.create(TODOS, id, todoValues(`todo ${index}`, notesFor(index), rankFor(index)), txnId(`create-${id}`));
  }
  client.sync(new WeftServer(), HASH);
  return client;
}

/** The payload a worker would post back after an edit, built without a client to build it from. */
export function deltaRows(count: number): readonly DeltaRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: todoId(index),
    scope_id: SCOPE,
    created: new Date(1_700_000_000_000 + index).toISOString(),
    title: `todo ${index}`,
    notes: notesFor(index),
    done: false,
    rank: rankFor(index),
    due_at: null,
    auto_delete_days: null,
  }));
}

/** The same payload, read out of a client that has just been edited. */
export function deltaRowOf(client: WeftClient, id: RowId): DeltaRow {
  const row = client.getRow(TODOS, id);
  if (row === undefined) throw new Error(`no such row: ${id}`);
  const text = (field: FieldName): string => {
    const value = row.fields.get(field);
    return typeof value === "string" ? value : "";
  };
  const numberOrNull = (field: FieldName): number | null => {
    const value = row.fields.get(field);
    return typeof value === "number" ? value : null;
  };
  return {
    id: row.id,
    scope_id: row.scope_id,
    created: row.created,
    title: text(TITLE),
    notes: text(NOTES),
    done: row.fields.get(DONE) === true,
    rank: text(RANK),
    due_at: numberOrNull(DUE_AT),
    auto_delete_days: numberOrNull(AUTO_DELETE_DAYS),
  };
}
