---
title: Storage on the device
description: The SqlExecutor port, its SQLite implementations, the worker that holds the database, and the mirror the page reads.
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

## Running the database in a worker

`SqlExecutor` is synchronous: every method returns its result directly, not a promise. The only
browser storage SQLite can reach synchronously is an OPFS sync access handle, one exists only
inside a dedicated worker, and it is held exclusively, so no other context can open the same file
while it is held.

The whole `WeftClient` therefore runs in the worker, next to the database it writes through to.
`serveWeftWorker` puts it there: it owns the client, applies each mutation the page asks for, and
posts back the rows that moved. It knows nothing about OPFS, so the same host runs against any
`SqlExecutor`.

```ts title="src/storage-worker.ts"
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { openWebSqliteExecutor } from "weftdb/client/wasm-sqlite";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { serveWeftWorker, type WorkerHostPortLike } from "weftdb/client/worker-host";
import { schema } from "./schema.ts";

const sqlite3 = await sqlite3InitModule();
const executor = await openWebSqliteExecutor(sqlite3, { path: "weft.sqlite3" });
const store = new SqliteClientStore(executor, schema);
store.installSchema();

serveWeftWorker({ port: globalThis as unknown as WorkerHostPortLike, executor, store });
```

`WorkerHostPortLike` is the port the host serves on: `postMessage`, `addEventListener`, and
`removeEventListener`. Under the DOM library `self` is typed as a `Window`, whose `postMessage`
takes an origin, so the worker's global is cast to the port type.

The executor and the store are the host's options, so the database is open before the host is
built, and `serveWeftWorker` hydrates the client from the store when the page asks it to. Give the
host the same executor the store writes through, or a watched statement runs against one file while
the rows it selects are saved into another.

`openWebSqliteExecutor` takes an initialised `sqlite3` module rather than importing one. The caller
supplies the module, so the library keeps no SQLite runtime dependency of its own, and which build
ships, or whether one ships at all, stays the application's decision.

A build with no `installOpfsSAHPoolVfs` is refused rather than opened against memory:
`openWebSqliteExecutor` throws a `WasmSqliteUnavailableError`. A database backed by memory
answers every read and write normally, then loses all of it on reload. Refusing to open makes
that failure visible immediately, instead of after the data is already gone.
`openMemorySqliteExecutor` opens an explicit in-memory database for tests, but nothing falls
back to it on its own.

## Reading and writing from the page

`OpfsWorkerTransport` wraps the `Worker` and correlates each request with its reply.
`WeftClientMirror` holds the rows the worker last said the scope contains, applies every delta the
worker pushes, and wakes the subscriptions that read them.

```ts title="src/store.ts"
import { OpfsWorkerTransport, WeftClientMirror } from "weftdb/client";
import { deviceId, scopeId } from "weftdb/core";
import { todosMutators } from "./generated/bindings.ts";

const worker = new Worker(new URL("./storage-worker.ts", import.meta.url), { type: "module" });
export const transport = new OpfsWorkerTransport(worker);

export const mirror = new WeftClientMirror({
  transport,
  scopeId: scopeId("user-1"),
  deviceId: deviceId("laptop"),
  onError: (error) => {
    console.error(error);
  },
});

await mirror.hydrate();

export const todos = todosMutators(mirror);
```

`hydrate()` loads the scope's rows out of the worker and resolves once they are on the page. It is
the one round trip that grows with the data: hydrating 10,000 rows takes 361 ms in Firefox over
OPFS, during which the page has no rows to render.

A mutator posts and returns `void`. The worker applies the change, writes it through to SQLite, and
pushes back the rows that moved, and only then does the mirror hold the new value. Nothing is
applied on the page first, so nothing on the page can need undoing. A mutation the worker refuses
rejects a promise the mutator has already returned from, which is what `onError` is for: without it
a refused edit looks like an edit that had no effect.

Generated code reads and writes through the mirror. `use<Collection>` and `use<Collection>Query`
read it as a query source, and `<collection>Mutators` writes through it as a `MutationTarget`, the
shape both `WeftClient` and `WeftClientMirror` have:

```tsx title="src/todo-list.tsx"
import { useTodosQuery } from "./generated/bindings.ts";
import { mirror, todos } from "./store.ts";

export function TodoList() {
  const rows = useTodosQuery(mirror, (statement) => statement.orderBy("rank"));
  return (
    <ul>
      {rows.map((todo) => (
        <li key={todo.id}>
          <button onClick={() => todos.update(todo.id, { done: !todo.done })}>{todo.title}</button>
        </li>
      ))}
    </ul>
  );
}
```

`<collection>Mutators` takes an optional `notify` callback as its second argument. Leave it out over
a mirror: the worker's push wakes the subscriptions when the change arrives, and a callback fired
when the mutator returns would wake them before there is anything new to read.

Per-field hybrid logical clock (HLC) readings, three-way merge ancestors, and the outbox stay in
the worker. The sync session and retention read those, and neither runs on the page, so the mirror
carries only what a component renders from.

## Reaching the worker from another tab

One tab at a time may hold the OPFS access handle, so one tab at a time may hold the worker.
[Using weftdb with React](/guides/react/) covers the election that decides which tab that is.

A follower tab reaches the leader's worker over a `BroadcastChannel`. `BroadcastDbProxy` satisfies
the same transport interface `OpfsWorkerTransport` does, so a follower's mirror is built the same
way, with the proxy in place of the transport:

```ts title="src/follower.ts"
import { BroadcastDbProxy, WeftClientMirror } from "weftdb/client";
import { deviceId, scopeId } from "weftdb/core";

const channel = new BroadcastChannel("weft:user-1:db");
const proxy = new BroadcastDbProxy(channel);

export const mirror = new WeftClientMirror({
  transport: proxy,
  scopeId: scopeId("user-1"),
  deviceId: deviceId("laptop"),
});

await mirror.hydrate();
```

The leader relays its worker's deltas onto the same channel, or a follower's mirror answers the
first hydrate and then never moves again:

```ts title="src/leader.ts"
// on the leader, with the responder from the React guide as `server`
const offRelay = transport.onPush((push) => {
  server.relayPush(push);
});
```

A follower whose leader dies stops receiving deltas. Its mirror freezes at the rows it last held
and raises no error, and `BroadcastDbProxy.request` has no deadline, so a request in flight when
the leader went away never settles.

Dispose the mirror and the proxy from a `pagehide` handler. A `BroadcastChannel` has no liveness
signal, so a tab that goes away without handing its registrations back leaves each statement it
watched registered in the worker, and the worker re-runs those statements after every mutation any
tab makes for the rest of the session.
