// The SQLite build every demo ships: `wa-sqlite`'s asynchronous WebAssembly module over
// `IDBMirrorVFS`, which keeps each open database in memory and mirrors it into IndexedDB.
//
// The asynchronous build, because the VFS is: an IndexedDB read is a request and an event, so
// SQLite has to be able to suspend inside a page fault. `wa-sqlite-async.mjs` is the Asyncify build
// that can, and it locates its `.wasm` relative to its own module URL — which is why every demo's
// Vite config keeps this package out of dependency prebundling.
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import * as SQLite from "wa-sqlite";
import { IDBMirrorVFS } from "wa-sqlite/src/examples/IDBMirrorVFS.js";
import { adoptWaSqlite, type WaSqliteBuild } from "weftdb/client/wasm-sqlite";

/** Initialised once per worker, because the module is a WebAssembly instance and its heap. */
export async function demoSqlite(): Promise<WaSqliteBuild> {
  const module = await SQLiteESMFactory();
  return {
    sqlite3: adoptWaSqlite(SQLite.Factory(module)),
    module,
    vfs: (built, name) => IDBMirrorVFS.create(name, built),
  };
}
