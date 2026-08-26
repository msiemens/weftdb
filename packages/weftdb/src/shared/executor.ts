// The port a SQL backend implements, and the vocabulary its statements are written in.
//
// Two ports, one vocabulary. The relay runs on `node:sqlite`, which answers a statement by
// returning its rows, so `SqlExecutor` is synchronous. A device runs on SQLite compiled to
// WebAssembly over a storage layer that yields — IndexedDB is reached by a request and an event —
// so `AsyncSqlExecutor` is the same four methods over promises. `SqlStatement` and the value types
// below are what both are written in, and a statement composed for one runs on the other.

export type SqlValue = string | number | bigint | Uint8Array<ArrayBuffer> | null;
export type SqlParameters = readonly SqlValue[];
export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface SqlStatement<Decoded> {
  readonly sql: string;
  readonly parameters: SqlParameters;
  readonly decode: (row: SqlRow) => Decoded;
}

export interface SqlExecutor {
  all<Decoded>(statement: SqlStatement<Decoded>): readonly Decoded[];
  get<Decoded>(statement: SqlStatement<Decoded>): Decoded | undefined;
  run(statement: { readonly sql: string; readonly parameters: SqlParameters }): void;
  transaction<Result>(body: () => Result): Result;
}

/** The three statement forms, shared by the executor and by a transaction open on it. */
export interface AsyncSqlStatements {
  all<Decoded>(statement: SqlStatement<Decoded>): Promise<readonly Decoded[]>;
  get<Decoded>(statement: SqlStatement<Decoded>): Promise<Decoded | undefined>;
  run(statement: { readonly sql: string; readonly parameters: SqlParameters }): Promise<void>;
}

/**
 * One open transaction, and the only way to issue a statement inside it.
 *
 * `transaction` nests, because `SqliteClientStore` wraps its writes in one while a caller may
 * already hold an outer transaction (§5.2). A nested call runs its body against this same handle:
 * the connection has one transaction open and every statement in it belongs to that one.
 */
export interface AsyncSqlTransaction extends AsyncSqlStatements {
  transaction<Result>(body: (tx: AsyncSqlTransaction) => Result | PromiseLike<Result>): Promise<Result>;
}

export interface AsyncSqlExecutor extends AsyncSqlStatements {
  /**
   * One transaction at a time, across every caller of this executor.
   *
   * The implementation is what enforces it. A body that can `await` is suspended between two of
   * its statements, and SQLite answers a second `BEGIN` on an open connection with an error, so
   * two tabs writing at once would fail on whichever arrived second.
   *
   * The body's statements go through the handle it is given, and that is what tells them apart from
   * everybody else's. A statement issued through the executor takes its place in the queue and runs
   * when the connection is free; one issued through the handle runs inside the transaction that
   * owns it. Without the distinction a write issued from outside would land inside somebody else's
   * transaction and be rolled back with it, having already resolved its own promise.
   */
  transaction<Result>(body: (tx: AsyncSqlTransaction) => Result | PromiseLike<Result>): Promise<Result>;
}

/** Runs a synchronous executor's statements behind the asynchronous port. */
export function asyncSqlExecutor(executor: SqlExecutor): AsyncSqlExecutor {
  const statements: AsyncSqlStatements = {
    all: async (statement) => executor.all(statement),
    get: async (statement) => executor.get(statement),
    run: async (statement) => {
      executor.run(statement);
    },
  };
  // The boundaries are issued as ordinary statements because a body that can `await` returns before
  // its statements have run, so a synchronous `transaction` would commit in front of them.
  return serializeAsyncSql(statements, (sql) => {
    executor.run({ sql, parameters: [] });
  });
}

/**
 * The queue every asynchronous executor is built on: statements from outside wait for the
 * connection, statements from inside a transaction run where they stand.
 *
 * `boundary` issues `BEGIN`, `COMMIT` and `ROLLBACK` against the connection the statements above
 * run on.
 */
export function serializeAsyncSql(
  statements: AsyncSqlStatements,
  boundary: (sql: string) => void | Promise<void>,
): AsyncSqlExecutor {
  let chain: Promise<unknown> = Promise.resolve();

  const open: AsyncSqlTransaction = {
    ...statements,
    transaction: async (body) => body(open),
  };

  const queue = <Result>(work: () => Promise<Result>): Promise<Result> => {
    const result = chain.then(work, work);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    all: async (statement) => queue(async () => statements.all(statement)),
    get: async (statement) => queue(async () => statements.get(statement)),
    run: async (statement) => queue(async () => statements.run(statement)),
    transaction: async <Result>(body: (tx: AsyncSqlTransaction) => Result | PromiseLike<Result>): Promise<Result> =>
      queue(async () => {
        await boundary("BEGIN");
        try {
          const result = await body(open);
          await boundary("COMMIT");
          return result;
        } catch (error) {
          await boundary("ROLLBACK");
          throw error;
        }
      }),
  };
}
