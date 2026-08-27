import { fieldName, rowId, tableName, wireText, type FieldName, type RowId, type TableName } from "weftdb/core";
import type { SchemaDefinition } from "weftdb/schema";
import type { AsyncSqlExecutor, SqlStatement, SqlValue } from "weftdb/shared";
import { queryCacheKey, type CompiledQuery, type QueryBuilderLike } from "./query.ts";
import type { LocalRow, MaterializedRow } from "./index.ts";

export interface QueryKey {
  readonly tableName: TableName;
  readonly fields: readonly FieldName[];
  readonly orderBy?: FieldName;
}

declare const rowType: unique symbol;

/**
 * A query key that remembers what a row of it decodes to. Nothing carries the row type at
 * runtime (this is a phantom), but it means a key and a decoder cannot be paired unless they
 * agree, so reading a `todos` query with the decoder for `todo_events` is a compile error.
 */
export interface TypedQueryKey<Row> extends QueryKey {
  readonly [rowType]?: (row: Row) => void;
}

/**
 * The keys a type actually declares. `SchemaDefinition` types its collections as
 * `Record<string, ...>`, and `keyof` on anything carrying an index signature is `string`, so
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

/**
 * A compiled statement bound to what it reads. The statement decides which rows match and in what
 * order, which is where `where`, a multi-field `order by`, `limit` and `offset` come from; the
 * rows themselves come back out of `client.rows`, so a result keeps the identity that row caching
 * and the delta both rest on.
 */
export interface ReactiveSqlQuery {
  readonly tableName: TableName;
  readonly compiled: CompiledQuery;
  readonly cacheKey: string;
}

export interface ReactiveSqlQueryOptions {
  /** The collection the statement selects `id` from, and whose rows the result materializes from. */
  readonly tableName: TableName;
  readonly query: QueryBuilderLike | CompiledQuery;
}

export function reactiveSqlQuery(options: ReactiveSqlQueryOptions): ReactiveSqlQuery {
  const compiled = "compile" in options.query ? options.query.compile() : options.query;
  assertScoped(compiled);
  return {
    tableName: options.tableName,
    compiled,
    cacheKey: queryCacheKey(compiled),
  };
}

/**
 * One database file holds every scope a person is signed into, and every read the store makes
 * itself is filtered on `scope_id`. A statement that leaves it out is refused here rather than
 * answered. Materializing out of `client.rows` already drops ids this scope does not hold;
 * however a row id is unique only within its collection, so two scopes can hold the same id and
 * the other scope's match would come back as this scope's row. This is a guard, not a SQL parser.
 */
function assertScoped(query: CompiledQuery): void {
  if (!/\bscope_id\b/u.test(query.sql)) {
    throw new Error("a reactive SQL query must constrain scope_id");
  }
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
    // so two collections holding the same id would hand each other's rows back, and a revision
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

/** What a statement with no answer yet renders as. One array, so it costs nothing per render. */
const NO_IDS: readonly RowId[] = [];

/**
 * One engine per client. It caches the last result per query and the identity of each row by
 * id, so pointing two clients at the same engine makes them evict each other's entries on
 * every render, which `useSyncExternalStore` turns into an infinite update loop rather than
 * a slow one.
 */
export class SubscriptionEngine {
  readonly #rowCache = new RowIdentityCache();
  readonly #snapshots = new Map<string, QuerySnapshot>();
  readonly #listeners = new Map<string, Set<QueryListener>>();
  /** Which generation each SQL query was last run against, so one change costs one run of it. */
  readonly #sqlRuns = new Map<string, number>();
  #generation = 0;
  #queued = false;

  getSnapshot(key: QueryKey, rows: Iterable<LocalRow>): QuerySnapshot {
    const cacheKey = queryKeyToString(key);
    const nextRows = [...rows]
      .filter((row) => rowMatches(row, key))
      .sort((left, right) => compareRows(left, right, key))
      .map((row) => this.#rowCache.materialize(row));
    const cached = this.#snapshots.get(cacheKey);
    // `useSyncExternalStore` calls this during render and re-renders whenever the result is
    // a new reference, so an unchanged result must be the *same* object. Handing back a
    // fresh one every call is an infinite render loop rather than merely a wasted render (§8.3).
    if (cached !== undefined && sameRows(cached.rows, nextRows)) return cached;
    const snapshot = Object.freeze({ rows: nextRows, delta: computeDelta(cached?.rows ?? [], nextRows) });
    this.#snapshots.set(cacheKey, snapshot);
    return snapshot;
  }

  /**
   * The snapshot of a compiled SQL query. `select` answers which rows matched and in what order;
   * `rows` answers what a row is, so a row that did not change is the same object it was and
   * `React.memo` still holds.
   *
   * `select` rather than an executor, because the database is not on the thread that renders. The
   * page reads the ids the worker last pushed, which is synchronous (what `useSyncExternalStore`
   * requires of a snapshot) and invisible to a component.
   *
   * A statement `select` has no answer for yet snapshots as no rows, because a component has
   * nowhere to put "pending" and a first paint has to be something. The state is reported by
   * `select` itself, for a caller that does have somewhere to put it.
   */
  getSqlSnapshot(query: ReactiveSqlQuery, select: RowSelect, rows: ReadonlyMap<string, LocalRow>): QuerySnapshot {
    const cacheKey = `sql\0${query.cacheKey}`;
    const cached = this.#snapshots.get(cacheKey);
    // React calls `getSnapshot` more than once for one render pass, and selecting again per call
    // would put a SQLite query in the render path. Nothing can have changed without a `notify`,
    // so one selection per generation is both enough and what keeps two calls in one pass
    // tearing-free.
    if (cached !== undefined && this.#sqlRuns.get(cacheKey) === this.#generation) return cached;
    this.#sqlRuns.set(cacheKey, this.#generation);

    const nextRows: MaterializedRow[] = [];
    // No answer yet selects nothing here, which is where the absence stops rather than where it is
    // erased: `select` still reports it, and this is the one caller that has to render regardless.
    for (const id of select(query) ?? NO_IDS) {
      const row = rows.get(`${query.tableName}\0${id}`);
      // A row the statement matched that this client does not hold is dropped rather than
      // reported. The database outlives any one hydrate, and a scope holds only its own rows.
      if (row !== undefined) nextRows.push(this.#rowCache.materialize(row));
    }

    if (cached !== undefined && sameRows(cached.rows, nextRows)) return cached;
    const snapshot = Object.freeze({ rows: nextRows, delta: computeDelta(cached?.rows ?? [], nextRows) });
    this.#snapshots.set(cacheKey, snapshot);
    return snapshot;
  }

  subscribe(key: QueryKey, listener: QueryListener): () => void {
    return this.#subscribeTo(queryKeyToString(key), listener);
  }

  subscribeSql(query: ReactiveSqlQuery, listener: QueryListener): () => void {
    return this.#subscribeTo(`sql\0${query.cacheKey}`, listener);
  }

  #subscribeTo(cacheKey: string, listener: QueryListener): () => void {
    const listeners = this.#listeners.get(cacheKey) ?? new Set<QueryListener>();
    listeners.add(listener);
    this.#listeners.set(cacheKey, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(cacheKey);
    };
  }

  notify(): void {
    // Bumped whatever the fan-out does, because it is what tells a cached SQL result that the
    // rows underneath it moved. Coalescing the listener call is about how often React is woken;
    // this is about what the next `getSqlSnapshot` is allowed to reuse.
    this.#generation += 1;
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

/**
 * Which rows a query matched, in order, or `undefined` where this source has no answer for it.
 * Synchronous, because a snapshot is read during render.
 *
 * `undefined` is not "no rows". A source that answers out of what another thread last pushed has no
 * answer for a statement nobody registered, and none for one registered whose first answer has yet
 * to arrive; both are the same state, and it is not the state of a statement that ran and matched
 * nothing. Answering both with `[]` makes a list that will never fill indistinguishable from a list
 * that is legitimately empty, which is a bug with nothing anywhere saying so.
 */
export type RowSelect = (query: ReactiveSqlQuery) => readonly RowId[] | undefined;

/**
 * The selection for whoever holds the database. It runs the statement directly, answering every
 * statement it is given because it runs it on the spot (there is nothing to register), so its
 * result is the narrower one and a caller reading through it never meets the absent answer.
 *
 * A promise, so it is not a `RowSelect` and cannot be handed to `getSqlSnapshot`. The worker runs
 * statements and pushes what they matched, and the page answers a render out of the last push.
 */
export function executorRowSelect(executor: AsyncSqlExecutor): (query: ReactiveSqlQuery) => Promise<readonly RowId[]> {
  return (query) => executor.all(selectMatchingIds(query));
}

function selectMatchingIds(query: ReactiveSqlQuery): SqlStatement<RowId> {
  return {
    sql: query.compiled.sql,
    parameters: query.compiled.parameters.map(toSqlValue),
    decode: (row) => {
      const value = row["id"];
      if (typeof value !== "string") throw new Error("a reactive SQL query must select the id column");
      return rowId(value);
    },
  };
}

/**
 * A bind parameter as the executor takes it. A query builder types its parameters `unknown`
 * because a dialect may accept anything, and SQLite binds no boolean. Without this,
 * `where("done", "=", false)` reaches the driver as a boolean and fails at the binding instead of
 * answering. Anything else is refused here, where the value is still attached to the query that
 * produced it.
 */
function toSqlValue(value: unknown): SqlValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (value instanceof Uint8Array) return value as Uint8Array<ArrayBuffer>;
  throw new Error(`a SQL parameter of this kind cannot be bound: ${value === undefined ? "undefined" : typeof value}`);
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
 * Ordering is by code unit. `localeCompare` weighs punctuation and case differently, because it is
 * built for showing a person an alphabetical list, and this ordering cannot afford that. A
 * fractional index is only "between" its neighbours under plain comparison, so a locale-collated
 * list ignores a reorder and stays where it was. Devices with different locales would also sort the
 * same rows into different orders, which is the one thing a shared list cannot do.
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
  // every subscribed query, so a scan per row here is a scan per row per row. At ten thousand
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
