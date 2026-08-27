export interface CompiledQuery {
  readonly sql: string;
  // These are SQL bind parameters, not sync-protocol field values, and a query builder is free to
  // produce whatever its dialect accepts (Kysely's own `CompiledQuery` types this `unknown[]` for
  // the same reason). Turning them into values a `SqlExecutor` accepts happens at the executor.
  readonly parameters: readonly unknown[];
}

export interface QueryBuilderLike {
  compile(): CompiledQuery;
}

/**
 * What a statement is called wherever it has to be recognised again. The worker keys its
 * registrations on this, and a page asks for one by handing the same key back, so two callers
 * that compiled the same statement share one registration and one run of it.
 */
export function queryCacheKey(query: CompiledQuery): string {
  return JSON.stringify({ sql: query.sql, parameters: query.parameters });
}
