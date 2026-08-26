// `wa-sqlite` ships types for its API and none for the Emscripten build or the example VFSs, so the
// modules that have none are declared as narrowly as this repository uses them.
//
// `WaSqliteApi` and `WaSqliteVfs` are `weftdb/client/wasm-sqlite`'s own structural descriptions, so
// assigning the real library to them is what checks that the port still describes it.
declare module "wa-sqlite/dist/wa-sqlite-async.mjs" {
  /** The Emscripten factory. `wasmBinary` is how a caller with no `fetch` supplies the module. */
  const factory: (options?: { readonly wasmBinary?: Uint8Array }) => Promise<object>;
  export default factory;
}

declare module "wa-sqlite" {
  import type { WaSqliteApi } from "weftdb/client/wasm-sqlite";
  export function Factory(module: object): WaSqliteApi;
}

declare module "wa-sqlite/src/examples/IDBMirrorVFS.js" {
  import type { WaSqliteVfs } from "weftdb/client/wasm-sqlite";
  export const IDBMirrorVFS: {
    create(name: string, module: object): Promise<WaSqliteVfs>;
  };
}

declare module "wa-sqlite/src/examples/MemoryAsyncVFS.js" {
  import type { WaSqliteVfs } from "weftdb/client/wasm-sqlite";
  export const MemoryAsyncVFS: {
    create(name: string, module: object): Promise<WaSqliteVfs>;
  };
}
