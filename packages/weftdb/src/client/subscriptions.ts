import { fieldName, tableName, wireText, type FieldName, type RowId, type TableName } from "weftdb/shared";
import type { SchemaDefinition } from "weftdb/schema";
import type { LocalRow, MaterializedRow } from "./index.ts";

export interface QueryKey {
  readonly tableName: TableName;
  readonly fields: readonly FieldName[];
  readonly orderBy?: FieldName;
}

declare const rowType: unique symbol;

/**
 * A query key that remembers what a row of it decodes to. Nothing carries the row type at
 * runtime — this is a phantom — but it means a key and a decoder cannot be paired unless they
 * agree, so reading a `todos` query with the decoder for `todo_events` is a compile error.
 */
export interface TypedQueryKey<Row> extends QueryKey {
  readonly [rowType]?: (row: Row) => void;
}

/**
 * The keys a type actually declares. `SchemaDefinition` types its collections as
 * `Record<string, ...>`, and `keyof` on anything carrying an index signature is `string` — so
 * without this, every "field" would be a valid field and the checking would be theatre.
 */
type DeclaredKeys<T> = keyof {
  [Key in keyof T as string extends Key ? never : number extends Key ? never : Key]: T[Key];
};

export type CollectionName<Schema extends SchemaDefinition> = DeclaredKeys<Schema["collections"]> & string;

export type FieldOf<Schema extends SchemaDefinition, Table extends CollectionName<Schema>> = DeclaredKeys<
  Schema["collections"][Table]["fields"]
> &
  string;

/**
 * Builds a query the schema agrees with: an unknown collection, a field it does not declare,
 * or an `orderBy` naming something that is not a field, are all type errors here rather than a
 * query that quietly matches nothing at runtime. Codegen emits one of these per collection;
 * this is for the queries an application builds itself.
 */
export function queryKey<const Schema extends SchemaDefinition, const Table extends CollectionName<Schema>>(
  schema: Schema,
  table: Table,
  options: {
    readonly fields?: readonly FieldOf<Schema, Table>[];
    readonly orderBy?: FieldOf<Schema, Table>;
  } = {},
): QueryKey {
  const collection = schema.collections[table];
  // A schema loaded at runtime can disagree with the one this was compiled against.
  if (collection === undefined) throw new Error(`no such collection: ${table}`);
  const fields = options.fields ?? (Object.keys(collection.fields) as FieldOf<Schema, Table>[]);
  for (const field of fields) {
    if (!(field in collection.fields)) throw new Error(`no such field: ${table}.${field}`);
  }
  return {
    tableName: tableName(table),
    fields: fields.map((field) => fieldName(field)),
    ...(options.orderBy === undefined ? {} : { orderBy: fieldName(options.orderBy) }),
  };
}

export interface QueryDelta {
  readonly added: readonly RowId[];
  readonly removed: readonly RowId[];
  readonly changed: readonly MaterializedRow[];
}

export interface QuerySnapshot {
  readonly rows: readonly MaterializedRow[];
  readonly delta: QueryDelta;
}

export type QueryListener = () => void;

export class RowIdentityCache {
  readonly #rows = new Map<string, { readonly rev: number; readonly row: MaterializedRow }>();

  materialize(row: LocalRow): MaterializedRow {
    // Keyed by table and id together. A row id is unique within its collection and nowhere else,
    // so two collections holding the same id would hand each other's rows back — and a revision
    // that happened to match would make it look like a cache hit.
    const key = `${row.tableName}\0${row.id}`;
    const cached = this.#rows.get(key);
    if (cached?.rev === row.internals._weft_rev) return cached.row;
    const materialized = Object.freeze({
      id: row.id,
      scope_id: row.scopeId,
      created: row.created,
      fields: new Map(row.fields),
    });
    this.#rows.set(key, { rev: row.internals._weft_rev, row: materialized });
    return materialized;
  }
}

/**
 * One engine per client. It caches the last result per query and the identity of each row by
 * id, so pointing two clients at the same engine makes them evict each other's entries on
 * every render — which `useSyncExternalStore` turns into an infinite update loop rather than
 * a slow one.
 */
export class SubscriptionEngine {
  readonly #rowCache = new RowIdentityCache();
  readonly #snapshots = new Map<string, QuerySnapshot>();
  readonly #listeners = new Map<string, Set<QueryListener>>();
  #queued = false;

  getSnapshot(key: QueryKey, rows: Iterable<LocalRow>): QuerySnapshot {
    const cacheKey = queryKeyToString(key);
    const nextRows = [...rows]
      .filter((row) => rowMatches(row, key))
      .sort((left, right) => compareRows(left, right, key))
      .map((row) => this.#rowCache.materialize(row));
    const cached = this.#snapshots.get(cacheKey);
    // `useSyncExternalStore` calls this during render and re-renders whenever the result is
    // a new reference, so an unchanged result must be the *same* object — handing back a
    // fresh one every call is an infinite render loop, not merely a wasted render (§8.3).
    if (cached !== undefined && sameRows(cached.rows, nextRows)) return cached;
    const snapshot = Object.freeze({ rows: nextRows, delta: computeDelta(cached?.rows ?? [], nextRows) });
    this.#snapshots.set(cacheKey, snapshot);
    return snapshot;
  }

  subscribe(key: QueryKey, listener: QueryListener): () => void {
    const cacheKey = queryKeyToString(key);
    const listeners = this.#listeners.get(cacheKey) ?? new Set<QueryListener>();
    listeners.add(listener);
    this.#listeners.set(cacheKey, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(cacheKey);
    };
  }

  notify(): void {
    if (this.#queued) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      for (const listeners of this.#listeners.values()) {
        for (const listener of listeners) listener();
      }
    });
  }
}

/** Row identity is already cached per revision, so identity comparison is the whole test. */
function sameRows(left: readonly MaterializedRow[], right: readonly MaterializedRow[]): boolean {
  return left.length === right.length && left.every((row, index) => row === right[index]);
}

function rowMatches(row: LocalRow, key: QueryKey): boolean {
  // The table first. Two collections can declare the same field names, and a query that only
  // asks which fields a row carries would return rows from every one of them.
  return row.tableName === key.tableName && key.fields.every((field) => row.fields.has(field));
}

/**
 * Ordering is by code unit, not by locale. `localeCompare` weighs punctuation and case
 * differently — it is built for showing a person an alphabetical list — and two things here
 * depend on it not doing that. A fractional index is only "between" its neighbours under plain
 * comparison, so a locale-collated list ignores a reorder and stays where it was; and two
 * devices with different locales would sort the same rows into different orders, which is the
 * one thing a shared list cannot do.
 */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRows(left: LocalRow, right: LocalRow, key: QueryKey): number {
  if (key.orderBy === undefined) return compareStrings(left.id, right.id);
  const leftValue = left.fields.get(key.orderBy);
  const rightValue = right.fields.get(key.orderBy);
  return compareStrings(wireText(leftValue ?? ""), wireText(rightValue ?? "")) || compareStrings(left.id, right.id);
}

function computeDelta(previous: readonly MaterializedRow[], next: readonly MaterializedRow[]): QueryDelta {
  // Previous rows are indexed rather than searched. A delta is computed on every change to
  // every subscribed query, so a scan per row here is a scan per row per row: at ten thousand
  // rows that is a hundred million identity comparisons to report that one of them moved.
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const nextIds = new Set(next.map((row) => row.id));
  const added: RowId[] = [];
  const changed: MaterializedRow[] = [];
  for (const row of next) {
    const before = previousById.get(row.id);
    if (before === undefined) added.push(row.id);
    else if (before !== row) changed.push(row);
  }
  return {
    added,
    removed: previous.filter((row) => !nextIds.has(row.id)).map((row) => row.id),
    changed,
  };
}

function queryKeyToString(key: QueryKey): string {
  return JSON.stringify({
    tableName: key.tableName,
    fields: [...key.fields].sort(),
    orderBy: key.orderBy ?? null,
  });
}
