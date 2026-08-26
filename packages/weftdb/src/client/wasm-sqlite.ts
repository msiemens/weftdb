// The `AsyncSqlExecutor` port for a browser: SQLite compiled to WebAssembly over a VFS the
// application chooses, so a device's durable state is a real database rather than a JSON string in
// `localStorage`.
//
// The client module has no SQLite runtime dependency. The caller passes in an initialised wa-sqlite
// API, the Emscripten module it was built over, and the VFS to store in, so which build ships — or
// whether one ships at all — stays the application's decision, and this package stays importable by
// a server that has no use for it.
//
// The VFS is the application's for a second reason. `IDBMirrorVFS` holds every open database in
// memory and mirrors it to IndexedDB, which is what makes it fast and what bounds how large a
// database it can serve; `IDBBatchAtomicVFS` is the same author's slower VFS with no such bound.
// Both are asynchronous, both work in every context, and swapping one for the other is this option
// and nothing else.
import {
  serializeAsyncSql,
  type AsyncSqlExecutor,
  type SqlParameters,
  type SqlRow,
  type SqlStatement,
  type SqlValue,
} from "weftdb/shared";

/** `step` reached a row. SQLite's own constant, named here because wa-sqlite is not imported. */
const SQLITE_ROW = 100;

/** The character SQLite reads a bound text value up to and no further. See `checked`. */
const NUL = String.fromCodePoint(0);

/**
 * Refuses a string this build cannot store whole.
 *
 * `wa-sqlite` binds text by pointer with no length, so SQLite reads it up to the first NUL and a
 * value that carries one is stored truncated — a note whose tail is gone on the next hydrate, with
 * nothing anywhere reporting it. Refused here, the write rejects and the caller is told.
 */
function checked(parameters: SqlParameters): SqlValue[] {
  for (const value of parameters) {
    if (typeof value === "string" && value.includes(NUL)) {
      throw new Error(
        "a text value carrying a NUL cannot be stored: SQLite would read it up to the NUL and no further",
      );
    }
  }
  // Copied because `bind_collection` takes a mutable array, and a statement's parameters are
  // readonly everywhere else in this package.
  return [...parameters];
}

/** The Emscripten module a wa-sqlite build is, as far as anything here is concerned. */
export type WaSqliteModule = object;

/** A registered VFS. Constructed by the application and handed over already open. */
export interface WaSqliteVfs {
  close(): unknown;
}

/**
 * The slice of `SQLite.Factory(module)` this uses.
 *
 * Declared structurally rather than imported, for the reason the module is: assigning the real
 * factory's result to this is what checks that the port still describes the library.
 */
export interface WaSqliteApi {
  vfs_register(vfs: WaSqliteVfs, makeDefault?: boolean): number;
  open_v2(filename: string, flags?: number, zVfs?: string): Promise<number>;
  close(db: number): Promise<number>;
  statements(db: number, sql: string): AsyncIterable<number>;
  bind_collection(statement: number, bindings: SqlValue[]): number;
  step(statement: number): Promise<number>;
  row(statement: number): readonly SqlValue[];
  column_names(statement: number): readonly string[];
}

/** This application's SQLite build, and how a database opened through it is stored. */
/**
 * Adopts the API `wa-sqlite`'s own `Factory` returns.
 *
 * Its `row()` is typed to hand back a blob column as `number[]`, which is wider than `SqlValue`.
 * weftdb never writes a blob — `encodeFieldValue` stores a value as text, a number, or JSON — so
 * nothing here ever reads one back, and the narrowing is asserted at this one point because this is
 * where the reason for it lives.
 */
export function adoptWaSqlite(api: unknown): WaSqliteApi {
  return api as WaSqliteApi;
}

export interface WaSqliteBuild {
  readonly sqlite3: WaSqliteApi;
  /** The module `sqlite3` was built over. A VFS is constructed against it rather than against the API. */
  readonly module: WaSqliteModule;
  /**
   * Builds a VFS under the given name, e.g. `(module, name) => IDBMirrorVFS.create(name, module)`.
   *
   * `IDBMirrorVFS` takes the name as its IndexedDB database's, so the name is what keeps one
   * application in an origin out of another's storage. It is also the name SQLite registers the VFS
   * under and the name the file below is opened against.
   */
  readonly vfs: (module: WaSqliteModule, name: string) => Promise<WaSqliteVfs>;
}

export interface WebSqliteOptions {
  /** The database's name within the VFS. */
  readonly path: string;
  /** What the VFS this file lives in is called. */
  readonly name: string;
  /**
   * How much of the database SQLite keeps decoded, in kibibytes. 16 MiB by default.
   *
   * SQLite's own default is 2 MB, and a 10,000-row `todos` table is around 3.5 MB, so a device of
   * ordinary size answers a `where` and an `order by` out of storage on every page it touches. It
   * is also what a journal has to fit inside for a VFS to commit a write in one batch.
   */
  readonly cacheSizeKib?: number;
}

/** What `cache_size` is set to unless an application says otherwise. */
const DEFAULT_CACHE_KIB = 16_384;

export interface WebSqliteExecutor extends AsyncSqlExecutor {
  close(): Promise<void>;
}

/**
 * Opens one database, and the VFS it lives in.
 *
 * The connection names its VFS, so two of them opened in one worker each read the storage their own
 * name points at however many have been registered since.
 */
export async function openWebSqliteExecutor(
  build: WaSqliteBuild,
  options: WebSqliteOptions,
): Promise<WebSqliteExecutor> {
  const vfs = await build.vfs(build.module, options.name);
  build.sqlite3.vfs_register(vfs, false);
  const database = await build.sqlite3.open_v2(options.path, undefined, options.name);
  const executor = waSqliteExecutor(build.sqlite3, database);
  await executor.run({ sql: "PRAGMA foreign_keys = ON", parameters: [] });
  // Negative is kibibytes; positive would be pages, which depends on `page_size` and would mean a
  // different amount of memory on a database made under another build.
  await executor.run({
    sql: `PRAGMA cache_size = -${String(options.cacheSizeKib ?? DEFAULT_CACHE_KIB)}`,
    parameters: [],
  });
  return {
    ...executor,
    close: async () => {
      await build.sqlite3.close(database);
      vfs.close();
    },
  };
}

/**
 * Wraps an open connection as the executor the client store takes.
 *
 * One worker serves every tab of an origin over this one connection, so a mutation in one tab and a
 * sync applying a batch for another routinely overlap; `serializeAsyncSql` is what makes them take
 * turns.
 */
function waSqliteExecutor(sqlite3: WaSqliteApi, database: number): AsyncSqlExecutor {
  const each = async (
    statement: { readonly sql: string; readonly parameters: SqlParameters },
    visit: (handle: number, columns: readonly string[]) => void,
  ): Promise<void> => {
    for await (const handle of sqlite3.statements(database, statement.sql)) {
      // Binding nothing to a statement with no placeholders is an error rather than a no-op.
      if (statement.parameters.length > 0) sqlite3.bind_collection(handle, checked(statement.parameters));
      const columns = sqlite3.column_names(handle);
      while ((await sqlite3.step(handle)) === SQLITE_ROW) visit(handle, columns);
    }
  };

  const keyed = (handle: number, columns: readonly string[]): SqlRow => {
    const values = sqlite3.row(handle);
    const row: Record<string, SqlValue> = {};
    for (const [index, name] of columns.entries()) row[name] = values[index] ?? null;
    return row;
  };

  return serializeAsyncSql(
    {
      async all<Decoded>(statement: SqlStatement<Decoded>): Promise<readonly Decoded[]> {
        const rows: Decoded[] = [];
        await each(statement, (handle, columns) => rows.push(statement.decode(keyed(handle, columns))));
        return rows;
      },
      async get<Decoded>(statement: SqlStatement<Decoded>): Promise<Decoded | undefined> {
        let decoded: Decoded | undefined;
        let seen = false;
        await each(statement, (handle, columns) => {
          if (seen) return;
          seen = true;
          decoded = statement.decode(keyed(handle, columns));
        });
        return decoded;
      },
      async run(statement: { readonly sql: string; readonly parameters: SqlParameters }): Promise<void> {
        await each(statement, () => undefined);
      },
    },
    (sql) => each({ sql, parameters: [] }, () => undefined),
  );
}
