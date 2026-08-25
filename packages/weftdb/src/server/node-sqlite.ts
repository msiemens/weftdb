import { DatabaseSync } from "node:sqlite";
import type { SqlExecutor, SqlParameters, SqlRow, SqlStatement } from "weftdb/shared";

export interface SqliteExecutor extends SqlExecutor, Disposable {
  readonly path: string;
  close(): void;
}

/**
 * The `SqlExecutor` port backed by `node:sqlite`, which is what a deployed server runs on.
 * Transactions nest by depth because the adapter wraps writes in one while a caller may
 * already hold an outer read transaction (§5.2).
 */
export function openSqliteExecutor(path: string): SqliteExecutor {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL");
  // The server acknowledges a push only after committing it, and the client drains its
  // outbox on that acknowledgement — so the commit has to survive a power cut, not just a
  // process crash. WAL's default (NORMAL) does not guarantee that; FULL does.
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA foreign_keys = ON");
  let depth = 0;

  return {
    path,
    all<Decoded>(statement: SqlStatement<Decoded>): readonly Decoded[] {
      return database
        .prepare(statement.sql)
        .all(...bind(statement.parameters))
        .map((row) => statement.decode(row as SqlRow));
    },
    get<Decoded>(statement: SqlStatement<Decoded>): Decoded | undefined {
      const row = database.prepare(statement.sql).get(...bind(statement.parameters));
      return row === undefined ? undefined : statement.decode(row);
    },
    run(statement: { readonly sql: string; readonly parameters: SqlParameters }): void {
      database.prepare(statement.sql).run(...bind(statement.parameters));
    },
    transaction<Result>(body: () => Result): Result {
      if (depth > 0) {
        depth += 1;
        try {
          return body();
        } finally {
          depth -= 1;
        }
      }
      database.exec("BEGIN");
      depth = 1;
      try {
        const result = body();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      } finally {
        depth = 0;
      }
    },
    close(): void {
      database.close();
    },
    [Symbol.dispose](): void {
      database.close();
    },
  };
}

function bind(parameters: SqlParameters): readonly (string | number | bigint | Uint8Array | null)[] {
  return parameters.map((value) => (value === undefined ? null : value));
}
