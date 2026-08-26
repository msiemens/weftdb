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
    vfs: async (built, name) => {
      await discardEmptyMirror(name);
      return IDBMirrorVFS.create(name, built);
    },
  };
}

/** The object stores `IDBMirrorVFS` keeps a database's pages and its transaction log in. */
const MIRROR_STORES = ["blocks", "tx"];

/**
 * Deletes a mirror database that exists without the stores the mirror keeps everything in.
 *
 * Reaching version 1 with a store missing is a state nothing recovers from on its own: no upgrade
 * runs on the next open, so nothing creates what is absent, and every `jOpen` after it throws
 * `NotFoundError`. Such a database also holds nothing, which is what makes deleting it the repair
 * and costs no data.
 *
 * The listing is what keeps this from being the bug it is fixing. Opening a database that does not
 * exist creates it at version 1, and creating it empty here is exactly the state above — so a
 * database nothing has listed is left for `IDBMirrorVFS.create` to make, and the upgrade an open
 * runs against one that has been deleted since the listing is aborted.
 */
async function discardEmptyMirror(name: string): Promise<void> {
  const listed = await indexedDB.databases?.();
  if (listed === undefined || !listed.some((entry) => entry.name === name)) return;
  const database = await openExisting(name);
  if (database === undefined) return;
  const complete = MIRROR_STORES.every((store) => database.objectStoreNames.contains(store));
  database.close();
  if (complete) return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    // A delete another connection is holding up is one somebody else has this database open for,
    // and open is the state this is trying to reach.
    for (const settle of ["onsuccess", "onerror", "onblocked"] as const) request[settle] = () => resolve();
  });
}

function openExisting(name: string): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
}
