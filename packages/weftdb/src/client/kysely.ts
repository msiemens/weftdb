import { DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely";
import type { SelectQueryBuilder } from "kysely";

/**
 * A statement over one collection that is already scoped and already selects `id`, which is what
 * the engine needs of it and what a generated query builder hands to a caller to chain onto.
 * Named here so generated code has no import of its own from `kysely`: an application that never
 * declared the dependency still resolves this through `weftdb`.
 */
export type ScopedRowQuery<DB, TB extends keyof DB & string> = SelectQueryBuilder<DB, TB, { id: string }>;

/**
 * A Kysely instance that can build and `.compile()` queries but never runs one. `DummyDriver`
 * refuses every connection/transaction call, so the only thing this is good for is producing
 * `{sql, parameters}`, which is exactly what §3.2 wants. The builder lives on the main thread, and
 * only the compiled query crosses to the worker, where a `SqlExecutor` is the one thing that
 * actually runs SQL. The `Sqlite*` adapter/introspector/compiler pair is Kysely's own documented
 * recipe for "compile-only" use and matches the local SQLite dialect this project targets.
 */
export function compileOnlyKysely<DB>(): Kysely<DB> {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });
}
