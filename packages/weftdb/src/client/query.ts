import type { FieldName, TableName } from "weftdb/core";

export interface CompiledQuery {
  readonly sql: string;
  // Not `WireValue`: these are SQL bind parameters, not sync-protocol field values, and a query
  // builder is free to produce whatever its dialect accepts (Kysely's own `CompiledQuery` types
  // this `unknown[]` for the same reason). Turning them into values a `SqlExecutor` accepts is
  // the executor's problem, not this compile-time contract's.
  readonly parameters: readonly unknown[];
}

export interface QueryBuilderLike {
  compile(): CompiledQuery;
}

export interface QueryDependency {
  readonly tableName: TableName;
  readonly fieldName?: FieldName;
}

export interface RegisteredQuery {
  readonly key: string;
  readonly compiled: CompiledQuery;
  readonly dependencies: readonly QueryDependency[];
}

export class AuthorizerDependencyRecorder {
  readonly #dependencies = new Map<string, QueryDependency>();

  recordRead(tableName: TableName, fieldName?: FieldName): void {
    const item = dependency(tableName, fieldName);
    this.#dependencies.set(`${item.tableName}\0${item.fieldName ?? ""}`, item);
  }

  snapshot(): readonly QueryDependency[] {
    return [...this.#dependencies.values()];
  }

  clear(): void {
    this.#dependencies.clear();
  }
}

export function compileQuery(query: QueryBuilderLike, dependencies: readonly QueryDependency[]): RegisteredQuery {
  const compiled = query.compile();
  return {
    key: queryCacheKey(compiled),
    compiled,
    dependencies,
  };
}

export function queryCacheKey(query: CompiledQuery): string {
  return JSON.stringify({ sql: query.sql, parameters: query.parameters });
}

export function dependency(tableName: TableName, fieldName?: FieldName): QueryDependency {
  return fieldName === undefined ? { tableName } : { tableName, fieldName };
}

export function invalidatesQuery(changedTables: ReadonlySet<TableName>, query: RegisteredQuery): boolean {
  return query.dependencies.some((item) => changedTables.has(item.tableName));
}
