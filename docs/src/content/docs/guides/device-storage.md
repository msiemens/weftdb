---
title: Storage on the device
description: The executor ports, the SharedWorker that holds the database, opening it from a page, and the mirror a component reads.
sidebar:
  order: 6
---

A device keeps its rows in SQLite compiled to WebAssembly, in one `SharedWorker` per origin that
serves every tab. The page holds a mirror of the rows that worker last pushed, and every read a
component makes is answered from it.

## The executor ports

`weftdb/shared` declares two ports over the same statements. The relay runs on `node:sqlite`, which
answers a statement by returning its rows. `SqlExecutor` is synchronous:

```ts
export interface SqlExecutor {
  all<Decoded>(statement: SqlStatement<Decoded>): readonly Decoded[];
  get<Decoded>(statement: SqlStatement<Decoded>): Decoded | undefined;
  run(statement: { readonly sql: string; readonly parameters: SqlParameters }): void;
  transaction<Result>(body: () => Result): Result;
}
```

A device runs SQLite over a storage layer that yields: IndexedDB is reached by a request and an
event. `AsyncSqlExecutor` is the same four methods over promises:

```ts
export interface AsyncSqlExecutor {
  all<Decoded>(statement: SqlStatement<Decoded>): Promise<readonly Decoded[]>;
  get<Decoded>(statement: SqlStatement<Decoded>): Promise<Decoded | undefined>;
  run(statement: { readonly sql: string; readonly parameters: SqlParameters }): Promise<void>;
  transaction<Result>(body: (tx: AsyncSqlTransaction) => Result | PromiseLike<Result>): Promise<Result>;
}
```

A `SqlStatement` composed for one runs on the other. `asyncSqlExecutor(executor)` lifts a
synchronous executor onto the asynchronous port, which is what lets a `node:sqlite` database stand
in for a device under Node.

One transaction is open at a time across every caller of an asynchronous executor. `transaction`
hands its body an `AsyncSqlTransaction`, and that handle is what tells the body's statements apart
from everybody else's. A statement issued through the handle runs inside the transaction. A
statement issued through the executor itself queues until the connection is free. Without the
distinction a write issued from outside would land inside somebody else's transaction and be rolled
back with it, having already resolved its own promise.

## The client store

`SqliteClientStore` takes an executor and a schema and turns them into a device's durable state.
`installSchema()` runs the generated DDL, and adds any column a schema edit introduced since the
database was last opened. `hydrate(scopeId, deviceId)` reads every row, tombstone, outbox entry and
quarantined op back into a fresh `WeftClient`, installing the schema first where nothing has. Every
write that client makes once it resolves is saved. Both return promises.

SQLite is used on the device rather than IndexedDB directly, because:

- The generated tables are relational.
- `transaction()` gives a batch of related writes a real commit and rollback to rest on.
- The same compiled SQL that runs on a device runs unchanged against `node:sqlite` on the relay.

## Writing the storage worker

The SQLite build is the application's to supply, so weftdb keeps no SQLite runtime dependency and
which build ships stays a decision the application makes. A `WaSqliteBuild` holds the initialised
wa-sqlite API, the module it was built over, and a function building the VFS.

Which VFS the build names is the application's choice, and the constraint on it is that it must be
asynchronous. `IDBMirrorVFS` in the sample below ships in the wa-sqlite repository rather than in
the version published to npm, so an application that wants it depends on the repository at a commit
of its own choosing.

```ts title="src/sqlite.ts"
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import * as SQLite from "wa-sqlite";
import { IDBMirrorVFS } from "wa-sqlite/src/examples/IDBMirrorVFS.js";
import type { WaSqliteBuild } from "weftdb/client/wasm-sqlite";

export async function sqlite(): Promise<WaSqliteBuild> {
  const module = await SQLiteESMFactory();
  return {
    sqlite3: SQLite.Factory(module),
    module,
    vfs: (built, name) => IDBMirrorVFS.create(name, built),
  };
}
```

`IDBMirrorVFS` holds each open database in memory and mirrors it into IndexedDB. That is what makes
it fast, and what bounds how large a database it can serve.

The asynchronous build of wa-sqlite is what that VFS needs. An IndexedDB read is a request and an
event, so SQLite has to be able to suspend inside a page fault, and `wa-sqlite-async.mjs` is the
Asyncify build that can. It locates its `.wasm` file relative to its own module URL, so a bundler
that rewrites that URL has to be told to leave the package alone. Under Vite that is
`optimizeDeps.exclude`.

The worker module itself is `serveWeftStorageWorker` and two lines that hand it each arriving port:

```ts title="src/storage-worker.ts"
import { serveWeftStorageWorker, type WeftWorkerScope } from "weftdb/client/worker-entry";
import { schema } from "./schema.ts";
import { sqlite } from "./sqlite.ts";

const worker = serveWeftStorageWorker({
  schema,
  sqlite,
  relay: { baseUrl: "/api/db", socketUrl: "/api/db/sync" },
});

(globalThis as unknown as WeftWorkerScope).onconnect = (event) => {
  const port = event.ports[0];
  if (port !== undefined) worker.connect(port);
};
```

`WeftWorkerScope` is `SharedWorkerGlobalScope`, named in the package because `weftdb` is typechecked
without the DOM library. A worker with something of its own to say to each arriving port can listen
on that port before passing it to `connect`.

`sqlite` is called once for each namespace this worker opens a database in, and the module it
returns is a WebAssembly instance and its heap. `path` names the file within the VFS and defaults to
`weft.sqlite3`. The VFS is named from the `namespace` the connecting page opened under, so two
applications in one origin hold two IndexedDB databases rather than contending for one.

The returned `WeftStorageWorker` has `connect(port)`, which serves one arriving port once that port
has said which database it wants, and `stop()`, which stops every client and closes every file.
`serving` and `watching` report the databases it holds and the statements it is recomputing, for a
test to read.

## Pointing the worker at a relay

`relay` says where the relay is. `{ baseUrl, socketUrl }` is the shorthand for the common case, and
the worker builds the transport from it. Leaving `socketUrl` out means HTTP and a poll, which still
syncs. Leaving `relay` out altogether is a device that never syncs, and the three session verbs are
then refused rather than ignored.

A relay that is not at a URL is given as a transport instead:

```ts title="src/storage-worker.ts"
// `sqlite` is the build above. `portTransport` and `portSocket` are this application's own,
// built over a `MessagePort` the page transferred in.
const worker = serveWeftStorageWorker({
  schema,
  sqlite,
  relay: {
    transport: (token) => portTransport(token),
    openSocket: (handlers, token) => portSocket(handlers, token),
  },
});
```

An application that outgrows the URL shorthand keeps everything else this entry point does.
`transport` is a function of the credential because a transport carries its token. The two forms
cannot be mixed: each is `never` on the other side, so a `baseUrl` beside a `transport` does not
compile. The demos use the supplied form. Their relay is a `WeftServer` in a second `SharedWorker`
of the same browser, reachable over a `MessagePort` that no URL describes and `fetch` cannot reach.

## Opening a database

`openWeftDatabase` is the whole of what a page does. It mints and stores a device id, connects to
the storage worker, refuses a worker serving a different schema, and hydrates the mirror. What it
hands back is what the generated code reads and writes through:

```ts title="src/store.ts"
import { openWeftDatabase } from "weftdb/client";
import { schema } from "./schema.ts";
import { todosMutators } from "./generated/bindings.ts";

export const weft = await openWeftDatabase({
  schema,
  scopeId: "user-1",
  worker: new URL("./storage-worker.ts", import.meta.url),
  relay: { token: () => localStorage.getItem("token") },
  onError: (error) => {
    console.error(error);
  },
});

export const todos = todosMutators(weft.source);
```

`worker` is the storage worker module's URL. It is the application's to name because a
`SharedWorker` is identified by its script URL, so every tab of the origin has to name the same one
to be served by the same instance.

`weft.source` is a `WeftClientMirror`. It is a `WeftSource`, so `use<Collection>` and
`use<Collection>Query` take it unchanged, and it is a `MutationTarget`, so `<collection>Mutators`
writes through it. `weft.status()` and `weft.subscribeStatus()` report the worker's sync session.
`weft.setToken()` hands over a credential or signs out, and resolves once the worker has it.
`weft.dispose()` unwinds everything in the order it was built.

`namespace` says which application in the origin this database belongs to, and defaults to `"weft"`.
It identifies the database together with `scopeId`. Two calls that agree on both are two tabs of one
database: one client in the worker, one outbox, one device id. Two that differ in either are two
databases that share nothing, even under one `scopeId`. `deviceStorage` is where the device id is
kept, `localStorage` by default. `connect` says how the connection to the worker is made, and by
default constructs a `SharedWorker` and hands back its port. Node has no `SharedWorker`, so
supplying `connect` is what lets a test drive the whole assembly there.

The relay's address is not among the options. The worker builds the transport, so the base URL
belongs there; the token is the exception, because a worker has no `localStorage` to read one from.
It is a function so that re-reading it is how a refreshed credential reaches the session, which is
what `setToken()` with no argument does.

`onError` is where a failure with no caller to reject reaches the page: a statement the worker
refused, a reconnect that failed, and a mutation whose promise nobody kept. A mutator's own refusal
is its own promise rejecting, and reaches the code that called it.

An open that cannot proceed rejects with a `WeftOpenError` carrying a `reason`:

| `reason`            | Condition                                                                    |
| ------------------- | ---------------------------------------------------------------------------- |
| `schema-mismatch`   | The page and the worker were built from different schemas                    |
| `no-worker`         | This environment has no `SharedWorker` and no `connect` was supplied         |
| `no-device-storage` | This environment has no `localStorage` for a device id and none was supplied |

Nothing is left running behind a failed open. The worker's tables are generated from its own copy of
the schema, so a page built from another one would select columns that database has never had.

## Assembling the same thing by hand

`openWeftDatabase` is built from parts that stay public, for an application that needs a piece of
this it cannot express through the front door. The worker half opens the database itself, and hands
each arriving port to `serveWeftWorker`:

```ts title="src/storage-worker.ts"
import { SqliteClientStore } from "weftdb/client/sqlite";
import { openWebSqliteExecutor } from "weftdb/client/wasm-sqlite";
import { serveWeftWorker } from "weftdb/client/worker-host";
import type { WeftWorkerScope } from "weftdb/client/worker-entry";
import { schemaHash } from "weftdb/schema";
import { schema } from "./schema.ts";
import { sqlite } from "./sqlite.ts";

const executor = await openWebSqliteExecutor(await sqlite(), { path: "weft.sqlite3", name: "weft-app" });
const store = new SqliteClientStore(executor, schema);
await store.installSchema();

const host = serveWeftWorker({ executor, store, schemaHash: schemaHash(schema) });

(globalThis as unknown as WeftWorkerScope).onconnect = (event) => {
  const port = event.ports[0];
  if (port !== undefined) host.connect(port);
};
```

`openWebSqliteExecutor` builds the VFS under `name`, opens `path` against it, and returns a
`WebSqliteExecutor`: an `AsyncSqlExecutor` with a `close()`. The connection names its VFS, so two
databases opened in one worker each read the storage their own name points at, however many have
been registered since. Give the host the same executor the store writes through, or a watched
statement runs against one file while the rows it selects are saved into another.

`WorkerPortTransport` carries the protocol over a port. `WeftClientMirror` holds the rows the worker
last said the scope contains, applies every delta the worker pushes, and wakes the subscriptions
that read them:

```ts title="src/store.ts"
import { SubscriptionEngine, WeftClientMirror, WorkerPortTransport } from "weftdb/client";
import { todosMutators } from "./generated/bindings.ts";

const shared = new SharedWorker(new URL("./storage-worker.ts", import.meta.url), { type: "module" });
export const transport = new WorkerPortTransport(shared.port);

export const mirror = new WeftClientMirror({
  transport,
  scopeId: "user-1",
  deviceId: "laptop",
  engine: new SubscriptionEngine(),
  onError: (error) => {
    console.error(error);
  },
});

await mirror.hydrate();

export const todos = todosMutators(mirror);
```

`openWeftDatabase` adds what this leaves out. It mints the device id and keeps it. It compares
`mirror.schemaHash` against the schema the page was built from. It hands the worker a credential,
and it builds a new transport and calls `mirror.attach` when the browser stops the worker under
memory pressure. A mirror also needs a `SubscriptionEngine` of its own, because two mirrors sharing
one evict each other's cached rows on every render.

`hydrate()` loads the scope's rows out of the worker and resolves once they are on the page. It is
the one round trip that grows with the data, and the page has no rows to render until it settles.

A mutator posts and hands back the worker's own promise. The worker applies the change, writes it
through to SQLite, and pushes back the rows that moved, and only then does the mirror hold the new
value. Nothing is applied on the page first, so nothing on the page can need undoing. A mutation the
worker refuses rejects that promise, which is why a call site that discards it writes `void`:

```tsx title="src/todo-list.tsx"
import { useTodosQuery } from "./generated/bindings.ts";
import { mirror, todos } from "./store.ts";

export function TodoList() {
  const rows = useTodosQuery(mirror, (statement) => statement.orderBy("rank"));
  return (
    <ul>
      {rows.map((todo) => (
        <li key={todo.id}>
          <button onClick={() => void todos.update(todo.id, { done: !todo.done })}>{todo.title}</button>
        </li>
      ))}
    </ul>
  );
}
```

`<collection>Mutators` takes an optional `notify` callback as its second argument. Leave it out over
a mirror: the worker's push wakes the subscriptions when the change arrives, and a callback fired
when the mutator returns would wake them before there is anything new to read.

A statement has to be registered with the worker before the mirror can answer it, because the
mirror answers out of what the worker last pushed. `use<Collection>Query` does that in an effect
through the source's `watch` and hands it back on unmount, so nothing above needs to. Reading a
statement without the hooks means calling `mirror.watch(query)` and `mirror.unwatch(query)`
around it; registrations are counted, so one statement read in two places is one statement in the
worker.

Send `{ type: "disconnect" }` and dispose the mirror from a `pagehide` handler, which is what
`weft.dispose()` does. A `MessagePort` has no liveness signal the worker can rely on. A tab that
goes away without saying so leaves each statement it watched registered, and the worker re-runs
those statements after every mutation any tab makes for the rest of the session.

Per-field hybrid logical clock (HLC) readings, three-way merge ancestors, and the outbox stay in
the worker. The sync session and retention read those, and neither runs on the page, so the mirror
carries only what a component renders from.

## Syncing from the worker

The sync session runs beside the client, in the worker, for the same reason the client is there. It
drives the sync against a `WeftClient`, and reads that client's outbox and quarantine to say what is
pending. Give `serveWeftWorker` a `session`:

```ts title="src/storage-worker.ts"
import { connectSocketTransport, httpTransport } from "weftdb/client";

const host = serveWeftWorker({
  executor,
  store,
  schemaHash: schemaHash(schema),
  session: {
    schemaHash: schemaHash(schema),
    transport: (token) => httpTransport({ baseUrl: "/api/db", token }),
    openSocket: (handlers, token) =>
      connectSocketTransport({
        url: "/api/db/sync",
        token,
        onWake: () => handlers.onWake(),
        onBatch: handlers.onBatch,
        onStatusChange: () => handlers.onStatusChange(),
        cursor: handlers.cursor,
      }),
  },
});
```

`transport` is a function of the token rather than a transport, because a transport carries its
credential. The socket presents one when it connects, and HTTP sends one per request. Signing in as
somebody else is a new transport, so the session is rebuilt around it and the socket reopened.

The page keeps the token, because the page is where a token can be got. A worker has no
`localStorage` and no redirect to read one out of, so the mirror hands it over:

```ts
await mirror.setToken(await signIn());
await mirror.setToken(null);
```

Signing out ends the session and closes the socket. It leaves the outbox exactly as it is: unsent
work belongs to the device rather than to the session that would have pushed it, and signing back in
pushes it. Dropping it is `discardQuarantine`, which is a separate decision about work the relay
has refused.

`sync()` syncs now rather than at the next poll, and resolves when that sync has finished, so a
pull-to-refresh stops spinning at the right moment. A relay that cannot be reached is an ordinary
state: it settles into the status rather than rejecting.

`status()` is what the session last reported, and `subscribeStatus` wakes when it changes. It reads
`undefined` before the device has signed in, which is where an application starts rather than a
failure. The worker sends a status only when something in it has moved, and the mirror holds the
object it was given, so a component can compare it by identity:

```tsx
const status = useSyncExternalStore(
  (listener) => mirror.subscribeStatus(listener),
  () => mirror.status(),
);
```
