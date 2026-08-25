---
title: Storage on the device
description: The SqlExecutor port, its SQLite implementations, and the local storage alternative for storing a device's data.
sidebar:
  order: 6
---

A device persists what it holds through one of two paths: `SqlExecutor`, which two SQLite
builds implement, or `WebStorageClientStore`, which serialises the whole client as one JSON
document and never runs SQL. `SqlExecutor` is what `SqliteClientStore` runs against, and it
declares:

```ts
export interface SqlExecutor {
  all<Decoded>(statement: SqlStatement<Decoded>): readonly Decoded[];
  get<Decoded>(statement: SqlStatement<Decoded>): Decoded | undefined;
  run(statement: { readonly sql: string; readonly parameters: SqlParameters }): void;
  transaction<Result>(body: () => Result): Result;
}
```

`SqliteClientStore` takes an executor and a schema and turns them into a device's durable
state. `installSchema()` runs the generated DDL, and adds any column a schema edit introduced
since the database was last opened. `hydrate(scopeId, deviceId)` reads every row, tombstone,
outbox entry and quarantined op back into a fresh `WeftClient`. Both it and
`WebStorageClientStore` set themselves as the client's persistence before `hydrate` returns,
so every write the client makes afterward is saved by whichever store produced it.

## Choosing a storage backend

| Backend                 | Built from                                                                 | What it is for                                                            |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `openSqliteExecutor`    | `node:sqlite`                                                              | The relay's own storage, and a synchronous stand-in for a device in tests |
| `openWebSqliteExecutor` | SQLite compiled to WebAssembly, over the Origin Private File System (OPFS) | A device's durable database in a browser                                  |
| `WebStorageClientStore` | `localStorage`                                                             | The device storage the todo list demo runs on                             |

Choose `openWebSqliteExecutor` for a relational database with real transactions, at the cost
of the worker setup below. Choose `WebStorageClientStore` when that cost is not worth paying:
it needs nothing but an object with `getItem`, `setItem` and `removeItem`, which `localStorage`
already is, and it runs on the main thread. `openSqliteExecutor` is for the relay and the test
suite; neither runs in a browser.

`WebStorageClientStore` takes the storage object, the schema, and a namespace that defaults to
`"weft"`: `new WebStorageClientStore(localStorage, schema, "myapp")`. Every key it writes is
prefixed with that namespace and the device's `scopeId` and `deviceId`, so one browser can hold
data for more than one application, or more than one `scopeId`, without collision.

SQLite is used on the device rather than IndexedDB because:

- The generated tables are relational.
- `transaction()` gives a batch of related writes a real commit and rollback to rest on.
- The same compiled SQL that runs on a device runs unchanged against `node:sqlite` on the server.

The cost of that choice is the worker constraint above, which shapes how a browser application is
put together.

## Setting up wasm-sqlite

`openWebSqliteExecutor` takes an initialised `sqlite3` module rather than importing one:

```ts title="src/storage-worker.ts"
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { openWebSqliteExecutor } from "weftdb/client/wasm-sqlite";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { scopeId, deviceId } from "weftdb/core";
import { schema } from "./schema.ts";

const sqlite3 = await sqlite3InitModule();
const executor = await openWebSqliteExecutor(sqlite3, { path: "weft.sqlite3" });
const store = new SqliteClientStore(executor, schema);
const client = store.hydrate(scopeId("user-1"), deviceId("laptop"));
```

The caller supplies the module, so the library keeps no SQLite runtime dependency of its own,
and which build ships, or whether one ships at all, stays the application's decision.

:::note
This file runs inside a dedicated worker. The page opens the worker and reaches it over a
transport such as `OpfsWorkerTransport`, because the OPFS pool this needs is unavailable
outside one.
:::

What follows from this holds regardless of which SQLite build is chosen:

- `SqlExecutor` is synchronous. Every method returns its result directly, not a promise.
- The only browser storage SQLite can reach synchronously is an OPFS sync access handle, and a
  sync access handle exists only inside a dedicated worker and is held exclusively, so no other
  context can open the same file while it is held.

A build with no `installOpfsSAHPoolVfs` is refused rather than opened against memory:
`openWebSqliteExecutor` throws a `WasmSqliteUnavailableError`. A database backed by memory
answers every read and write normally, then loses all of it on reload. Refusing to open makes
that failure visible immediately, instead of after the data is already gone.
`openMemorySqliteExecutor` opens an explicit in-memory database for tests, but nothing falls
back to it on its own.

A worker holding a device's database open is also a worker only one browser tab can hold at a
time. [React](/guides/react/) covers what a second tab does about it.
