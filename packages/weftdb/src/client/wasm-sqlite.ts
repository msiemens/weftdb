// The `SqlExecutor` port for a browser: SQLite compiled to WebAssembly, so a device's durable
// state is a real database rather than a JSON string in `localStorage`.
//
// Two constraints shape this file.
//
// The executor interface is synchronous, and the only browser storage SQLite can reach
// synchronously is an OPFS sync access handle, which exists only inside a dedicated worker.
// A persistent executor therefore runs in a worker and the page reaches it through
// `OpfsWorkerTransport`; on the main thread only an in-memory database can be opened, which is
// useful for tests and useless for persistence.
//
// And the client module has no SQLite runtime dependency. The caller passes in an initialised sqlite3
// module, so which build of SQLite ships — or whether one ships at all — stays the
// application's decision, and this package stays importable by a server that has no use for it.
import type { SqlExecutor, SqlParameters, SqlRow, SqlStatement, SqlValue } from "weftdb/shared";

/** The part of `sqlite3.oo1.Stmt` this uses. */
export interface WasmStatement {
  bind(values: readonly SqlValue[]): unknown;
  step(): boolean;
  /** Fills and returns the given object with this row, keyed by column name. */
  get(target: Record<string, unknown>): Record<string, unknown>;
  finalize(): unknown;
}

/** The part of `sqlite3.oo1.DB` this uses. */
export interface WasmDatabase {
  prepare(sql: string): WasmStatement;
  exec(sql: string): unknown;
  close(): void;
}

/** Opened by `installOpfsSAHPoolVfs`, and the only way to a synchronous OPFS database. */
export interface OpfsSAHPool {
  readonly OpfsSAHPoolDb: new (path: string) => WasmDatabase;
}

/** The part of the initialised `sqlite3` module this uses. */
export interface Sqlite3Module {
  readonly oo1: {
    readonly DB: new (path: string, flags?: string) => WasmDatabase;
  };
  /** Present only in a browser that has OPFS, and only inside a worker. */
  installOpfsSAHPoolVfs?(options: {
    readonly name?: string;
    readonly initialCapacity?: number;
    readonly clearOnInit?: boolean;
  }): Promise<OpfsSAHPool>;
}

export interface WasmSqliteExecutor extends SqlExecutor, Disposable {
  close(): void;
}

export interface WebSqliteOptions {
  /** The database's name within the pool. One file per scope, or one for the whole device. */
  readonly path: string;
  /**
   * Which pool of OPFS files to open in. Two databases in one pool share its capacity; two
   * pools in one origin are independent, which is what keeps one application's storage out of
   * another's.
   */
  readonly poolName?: string;
  /** How many files the pool reserves up front. Growing it later costs an async round trip. */
  readonly initialCapacity?: number;
}

export class WasmSqliteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WasmSqliteUnavailableError";
  }
}

/**
 * Wraps an open database as the executor the stores take. Transactions nest by depth because
 * `SqliteClientStore` wraps its writes in one while a caller may already hold an outer
 * transaction (§5.2).
 */
export function wasmSqliteExecutor(database: WasmDatabase): WasmSqliteExecutor {
  let depth = 0;
  const close = (): void => {
    database.close();
  };

  return {
    all<Decoded>(statement: SqlStatement<Decoded>): readonly Decoded[] {
      const prepared = database.prepare(statement.sql);
      try {
        bind(prepared, statement.parameters);
        const rows: Decoded[] = [];
        while (prepared.step()) rows.push(statement.decode(prepared.get({}) as SqlRow));
        return rows;
      } finally {
        // A statement left unfinalised holds its database open, and in the SAH pool VFS that
        // means holding the file's access handle.
        prepared.finalize();
      }
    },
    get<Decoded>(statement: SqlStatement<Decoded>): Decoded | undefined {
      const prepared = database.prepare(statement.sql);
      try {
        bind(prepared, statement.parameters);
        if (!prepared.step()) return undefined;
        return statement.decode(prepared.get({}) as SqlRow);
      } finally {
        prepared.finalize();
      }
    },
    run(statement: { readonly sql: string; readonly parameters: SqlParameters }): void {
      const prepared = database.prepare(statement.sql);
      try {
        bind(prepared, statement.parameters);
        prepared.step();
      } finally {
        prepared.finalize();
      }
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
    close,
    [Symbol.dispose]: close,
  };
}

/**
 * Opens a database that survives the tab. Must be called from a dedicated worker: the VFS it
 * needs takes exclusive sync access handles, which no other context can hold.
 */
export async function openWebSqliteExecutor(
  sqlite3: Sqlite3Module,
  options: WebSqliteOptions,
): Promise<WasmSqliteExecutor> {
  if (sqlite3.installOpfsSAHPoolVfs === undefined) {
    throw new WasmSqliteUnavailableError(
      "this SQLite build has no OPFS sync access handle pool, so it cannot store anything synchronously",
    );
  }
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    ...(options.poolName === undefined ? {} : { name: options.poolName }),
    ...(options.initialCapacity === undefined ? {} : { initialCapacity: options.initialCapacity }),
  });
  return prepared(new pool.OpfsSAHPoolDb(options.path));
}

/** A database that lives as long as the page does, for tests and for a device that opts out. */
export function openMemorySqliteExecutor(sqlite3: Sqlite3Module): WasmSqliteExecutor {
  return prepared(new sqlite3.oo1.DB(":memory:", "c"));
}

/**
 * Journalling is left to the VFS, which is the only party that knows what it can do — the sync
 * access handle pool has no WAL, and an in-memory database has no journal at all.
 */
function prepared(database: WasmDatabase): WasmSqliteExecutor {
  database.exec("PRAGMA foreign_keys = ON");
  return wasmSqliteExecutor(database);
}

function bind(statement: WasmStatement, parameters: SqlParameters): void {
  // Binding nothing to a statement with no placeholders is an error rather than a no-op.
  if (parameters.length === 0) return;
  statement.bind(parameters);
}
