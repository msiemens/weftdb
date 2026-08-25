import { DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely";

/**
 * A Kysely instance that can build and `.compile()` queries but never runs one. `DummyDriver`
 * refuses every connection/transaction call, so the only thing this is good for is producing
 * `{sql, parameters}` — which is exactly what §3.2 wants: the builder lives on the main thread,
 * and only the compiled query crosses to the worker, where a `SqlExecutor` is the one thing that
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
