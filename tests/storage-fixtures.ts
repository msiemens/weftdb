// The SQLite build the storage worker is served over in these tests is a real one, the `wa-sqlite`
// asynchronous WebAssembly module a browser loads, running over a VFS that keeps its files in
// memory.
//
// `IDBMirrorVFS` is what ships, and it needs IndexedDB, which Node has not got. `MemoryAsyncVFS` is
// the same author's VFS with the same asynchronous interface and the same suspend-inside-a-page-
// fault behaviour, so everything the worker, the store and the client do over it is what they do
// over the one that ships; what differs is only where the bytes end up.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import * as SQLite from "wa-sqlite";
import { MemoryAsyncVFS } from "wa-sqlite/src/examples/MemoryAsyncVFS.js";
import { adoptWaSqlite, type WaSqliteBuild, type WaSqliteVfs } from "weftdb/client/wasm-sqlite";

const require = createRequire(import.meta.url);
// Emscripten locates its `.wasm` by `fetch` against its own module URL, which under Node is a
// `file:` URL that `fetch` refuses. Read here and handed over, the module skips that path.
const wasmBinary = readFileSync(require.resolve("wa-sqlite/dist/wa-sqlite-async.wasm"));

/**
 * One browser's storage is one WebAssembly module, and a VFS per name that outlives every database
 * opened in it.
 *
 * A file survives being closed and opened again, which is the property a device depends on and an
 * ordinary in-memory database lacks, so a tab coming back to a scope another tab finished with
 * reads what that tab left. Two names are two VFSs, which is what makes two namespaces two files.
 *
 * A VFS holds its files, so `close` is left to do nothing. Closing one would take the database with
 * it, and the next open would find an empty file.
 */
export function memorySqlite(): () => Promise<WaSqliteBuild> {
  const kept = new Map<string, WaSqliteVfs>();
  let built: Promise<{ readonly module: object; readonly sqlite3: WaSqliteBuild["sqlite3"] }> | undefined;
  const load = async (): Promise<{ readonly module: object; readonly sqlite3: WaSqliteBuild["sqlite3"] }> => {
    const module: object = await SQLiteESMFactory({ wasmBinary });
    return { module, sqlite3: adoptWaSqlite(SQLite.Factory(module)) };
  };
  return async () => {
    // One module for every database this storage serves, because a VFS is constructed against a
    // module and holding one across two of them would read another instance's heap.
    built ??= load();
    const { module, sqlite3 } = await built;
    return {
      sqlite3,
      module,
      vfs: async (over: object, name: string) => {
        const existing = kept.get(name);
        if (existing !== undefined) return existing;
        const made = await MemoryAsyncVFS.create(name, over);
        made.close = () => undefined;
        kept.set(name, made);
        return made;
      },
    };
  };
}
