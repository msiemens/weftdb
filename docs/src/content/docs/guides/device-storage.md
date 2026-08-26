---
title: Storage on the device
description: The SqlExecutor port, its SQLite implementations, the worker that holds the database, and the mirror the page reads.
sidebar:
  order: 6
---

A device persists what it holds through `SqlExecutor`, the port two SQLite builds implement.
`SqliteClientStore` runs against it, and it declares:

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
outbox entry and quarantined op back into a fresh `WeftClient`. It sets itself as the client's
persistence before `hydrate` returns, so every write the client makes afterward is saved.

## Choosing a storage backend

| Backend                 | Built from                                                                 | What it is for                                                            |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `openSqliteExecutor`    | `node:sqlite`                                                              | The relay's own storage, and a synchronous stand-in for a device in tests |
| `openWebSqliteExecutor` | SQLite compiled to WebAssembly, over the Origin Private File System (OPFS) | A device's durable database in a browser                                  |

`openWebSqliteExecutor` needs the worker setup below. `openSqliteExecutor` is for the relay and
the test suite; neither runs in a browser.

## Building the source a hook reads

A generated hook takes a `WeftSource` ([reading data](/guides/reading-data/)), which a client on
the thread that renders is not on its own: it holds the rows and the scope, and the subscription
engine and the statement selection come from beside it.

`executorRowSelect(executor)` supplies the statement selection where the executor is on the thread
that renders:

```ts title="src/store.ts"
import { executorRowSelect, SubscriptionEngine, type WeftSource } from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { deviceId, scopeId } from "weftdb/core";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import { schema } from "./schema.ts";

const executor = openSqliteExecutor("weft.sqlite3");
const store = new SqliteClientStore(executor, schema);
store.installSchema();
const client = store.hydrate(scopeId("user-1"), deviceId("laptop"));

export const source: WeftSource = {
  engine: new SubscriptionEngine(),
  rows: client.rows,
  scopeId: client.scopeId,
  select: executorRowSelect(executor),
  watch: () => Promise.resolve(),
  unwatch: () => undefined,
};
```

Give it the executor the store writes through. Otherwise a statement runs against one database
while the rows it selects are saved into another. `watch` and `unwatch` are no-ops here, because
the statement runs on the thread that reads it and there is nothing to register it with. Both
`use<Collection>` and `use<Collection>Query` read through this source unchanged.

The executor above is `node:sqlite`, which is synchronous and reachable from the thread that
renders. A browser reaches SQLite only through the worker below.

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

The worker module is `serveWeftWorkerDefaults` and the schema:

```ts title="src/storage-worker.ts"
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveWeftWorkerDefaults } from "weftdb/client/worker-entry";
import { schema } from "./schema.ts";

serveWeftWorkerDefaults({
  schema,
  sqlite3InitModule,
  relay: { baseUrl: "/api/db", socketUrl: "/api/db/sync" },
});
```

It opens the OPFS executor, builds the store, installs the schema, serves the protocol, and tells
the page whether the database opened. A browser with no access handle pool is reported rather than
thrown, so the page can fail the open with the reason rather than a stack from a worker.

`relay` says where the relay is. `{ baseUrl, socketUrl }` is the shorthand for the common case, and
the worker builds the transport from it. A relay that is not at a URL is given as a transport
instead:

```ts title="src/storage-worker.ts"
serveWeftWorkerDefaults({
  schema,
  sqlite3InitModule,
  relay: {
    transport: (token) => myTransport(token),
    openSocket: (handlers, token) => myLiveConnection(handlers, token),
  },
});
```

Those two members are the ones `serveWeftWorker`'s own `session` declares. The supplied form is
therefore the general one and the URL form is a shorthand for it, so an application that outgrows
the shorthand keeps everything else this entry point does. `transport` is a function of the
credential because a transport carries its token. The two forms cannot be mixed: each is `never` on
the other side, so a `baseUrl` beside a `transport` does not compile. The demos use the supplied
form. Their relay is a `WeftServer` in a `SharedWorker` of the same browser, reachable over a
`MessagePort` that no URL describes and `fetch` cannot reach.

The pool it opens in is named from the namespace `openWeftDatabase` wrote into this worker's URL, so
two applications in one origin hold two pools rather than contending for one. `poolName` names the
pool outright, for a worker an application loads itself.

The same worker assembled by hand, for an application that needs a piece of it:

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
ships, or whether one ships at all, stays the application's decision. Its `poolName` defaults to
whatever the SQLite build defaults to, so a worker assembled this way names its own pool wherever an
origin holds more than one database.

A build with no `installOpfsSAHPoolVfs` is refused rather than opened against memory:
`openWebSqliteExecutor` throws a `WasmSqliteUnavailableError`. Such a build has no durable storage
on any browser, so a memory-backed database would serve every read and write through development
and lose the data in production. `openMemorySqliteExecutor` opens an in-memory database directly,
and `serveWeftWorkerDefaults` opens one when a browser declines the pool.

## Opening a database

`openWeftDatabase` is the whole of what a page does. It elects this tab, creates the worker or gets
a port to the one another tab created, mints and stores a device id, builds the mirror, hydrates it,
and hands back what the generated code reads and writes through:

```ts title="src/store.ts"
import { openWeftDatabase } from "weftdb/client";
import { schema } from "./schema.ts";
import { todosMutators } from "./generated/bindings.ts";

export const weft = await openWeftDatabase({
  schema,
  scopeId: "user-1",
  worker: new URL("./storage-worker.ts", import.meta.url),
  broker: new URL("./broker.ts", import.meta.url),
  relay: { token: () => localStorage.getItem("token") },
  onError: (error) => {
    console.error(error);
  },
});

export const todos = todosMutators(weft.source);
```

Two modules, and each is one import. The storage worker holds the database; the broker is a
`SharedWorker` that hands a port to it from one tab to another. See
[Reaching the worker from another tab](#reaching-the-worker-from-another-tab).

`weft.source` is a `WeftSource`, so `use<Collection>` and `use<Collection>Query` take it unchanged,
and it is a `MutationTarget`, so `<collection>Mutators` writes through it. `weft.durability` is
`durable` or `ephemeral`; drive a banner from it, and tell a person their window will not remember.
It is settled at the open and holds for the session, so there is nothing to subscribe to.
`weft.role` is `leader` or `follower` and `weft.subscribeRole()` fires on a promotion; both are
diagnostics, because every tab reaches the worker in one hop whichever part it plays.
`weft.status()` and `weft.subscribeStatus()` report the
worker's sync session, `weft.setToken()` hands over a credential or signs out, and `weft.dispose()`
unwinds everything in the order it was built.

`namespace` says which application in the origin this database belongs to, and defaults to `"weft"`.
It identifies the database together with `scopeId`. Two calls that agree on both are two tabs of one
database. Two that differ in either are two databases, even under one `scopeId`: separate elections,
separate workers, separate device identifiers, and separate OPFS pools.
[Multi-tab coordination](/concepts/multi-tab/) covers the composed key and how the namespace reaches
the worker.

The relay's address is not among the options. The worker builds the transport, so the base URL
belongs there; the token is the exception, because a worker has no `localStorage` to read one from.
It is a function so that re-reading it is how a refreshed credential reaches the session, which is
what `setToken()` with no argument does.

A browser that declines the synchronous access handle pool is served an in-memory database, and
`weft.durability` reports `ephemeral`. Safari's private browsing mode is the case that reaches it.
Every query and hook works unchanged there. Rows, outbox, and quarantine all go when the window
closes, a reload included. [Multi-tab coordination](/concepts/multi-tab/) covers both modes.

An open still fails when the worker can open no database at all, and `WeftOpenError` carries a
`reason` naming the condition. Nothing is left running behind a failed open.

## Assembling the same thing by hand

`openWeftDatabase` is built from parts that stay public, for an application that needs a piece of
this it cannot express through the front door. `WorkerPortTransport` numbers each request and
settles the reply that carries the same number, over a dedicated `Worker` or over a `MessagePort` to
one. `WeftClientMirror` holds the rows the worker last said the scope contains, applies every delta
the worker pushes, and wakes the subscriptions that read them:

```ts title="src/store.ts"
import { WeftClientMirror, WorkerPortTransport } from "weftdb/client";
import { deviceId, scopeId } from "weftdb/core";
import { todosMutators } from "./generated/bindings.ts";

const worker = new Worker(new URL("./storage-worker.ts", import.meta.url), { type: "module" });
export const transport = new WorkerPortTransport(worker);

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

What the front door does that this does not: a mirror needs a `SubscriptionEngine` of its own, or
two of them evict each other's cached rows on every render; a second tab reaches the worker only
through the arrangement below; and the teardown has an order, because the Web Lock has to be handed
back after the worker has released the access handle.

`hydrate()` loads the scope's rows out of the worker and resolves once they are on the page. It is
the one round trip that grows with the data: hydrating 10,000 rows takes 361 ms in Firefox over
OPFS, during which the page has no rows to render.

A mutator posts and returns `void`. The worker applies the change, writes it through to SQLite, and
pushes back the rows that moved, and only then does the mirror hold the new value. Nothing is
applied on the page first, so nothing on the page can need undoing. A mutation the worker refuses
rejects a promise the mutator has already returned from, which is what `onError` is for: without it
a refused edit looks like an edit that had no effect.

Generated code reads and writes through the mirror. It is a `WeftSource` already, so
`use<Collection>` and `use<Collection>Query` take it unchanged, and `<collection>Mutators` writes
through it as a `MutationTarget`, the shape both `WeftClient` and `WeftClientMirror` have:

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

A statement has to be registered with the worker before the mirror can answer it, because the
mirror answers out of what the worker last pushed. `use<Collection>Query` does that in an effect
through the source's `watch` and hands it back on unmount, so nothing above needs to. Reading a
statement without the hooks means calling `mirror.watch(query)` and `mirror.unwatch(query)`
around it; registrations are counted, so one statement read in two places is one statement in the
worker.

Per-field hybrid logical clock (HLC) readings, three-way merge ancestors, and the outbox stay in
the worker. The sync session and retention read those, and neither runs on the page, so the mirror
carries only what a component renders from.

## Syncing from the worker

The sync session runs beside the client, in the worker, for the same reason the client is there: it
drives the sync against a `WeftClient` and reads that client's outbox and quarantine to say what is
pending. Give `serveWeftWorker` a `session` and it runs one:

```ts title="src/storage-worker.ts"
serveWeftWorker({
  port: globalThis as unknown as WorkerHostPortLike,
  executor,
  store,
  session: {
    schemaHash,
    transport: (token) => httpTransport({ baseUrl: "/api", token }),
    openSocket: (handlers, token) => connectSocketTransport({ url: "/sync", token, handlers }),
  },
});
```

`transport` is a function of the token rather than a transport, because a transport carries its
credential: the socket presents one when it connects, and HTTP sends one per request. Signing in as
somebody else is a new transport, so the session is rebuilt around it and the socket reopened.

The page keeps the token, because the page is where a token can be got. A worker has no
`localStorage` and no redirect to read one out of, so the mirror hands it over:

```ts
mirror.setToken(await signIn());
mirror.setToken(null);
```

Signing out ends the session and closes the socket. It leaves the outbox exactly as it is: unsent
work belongs to the device rather than to the session that would have pushed it, and signing back in
pushes it. Dropping it is `discardQuarantine`, which is a separate decision about work the relay
has refused.

`sync()` syncs now rather than at the next poll, and resolves when that sync has finished, so a
pull-to-refresh stops spinning at the right moment. A relay that cannot be reached is an ordinary
state: it settles into the status rather than throwing.

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

## Reaching the worker from another tab

`openWeftDatabase` elects the tab, moves the ports, and rebuilds the connection when leadership
changes, so an application that opens through it writes none of what follows.
[Multi-tab coordination](/concepts/multi-tab/) covers why one tab holds the database and how the
other tabs reach it.

Moving a port between tabs needs a `SharedWorker`, so ship one as a module of its own and give
`openWeftDatabase` its URL:

```ts title="src/broker.ts"
import "weftdb/client/broker-entry";
```

```ts title="src/main.ts"
const weft = await openWeftDatabase({
  schema,
  scopeId: "user-1",
  worker: new URL("./storage-worker.ts", import.meta.url),
  broker: new URL("./broker.ts", import.meta.url),
});
```

The broker touches no storage, and the module above is the whole of it. A browser with no
`SharedWorker` is refused at the open in every tab, with `reason` `"no-broker"`. A browser with no
Web Locks is refused the same way, with `reason` `"no-locks"`: nothing else can decide which tab may
hold the database.

One broker serves every database the origin has open, so `WeftBrokerClient` takes the namespace as
its third argument and registers under the namespace and the scope together. A port asked for in one
namespace reaches no other namespace's provider.

Assembling it by hand is two subscriptions:

```ts title="src/owner.ts"
import { WeftBrokerClient } from "weftdb/client";

const shared = new SharedWorker("/broker.js", { type: "module" });
const broker = new WeftBrokerClient(shared.port, "user-1");
const offPort = broker.onPort((port) => {
  worker.postMessage({ weft: "connect", port }, [port]);
});
broker.provide();
```

```ts title="src/guest.ts"
import { WeftBrokerClient, WeftClientMirror, WorkerPortTransport } from "weftdb/client";
import { deviceId, scopeId } from "weftdb/core";

const shared = new SharedWorker("/broker.js", { type: "module" });
const broker = new WeftBrokerClient(shared.port, "user-1");
const brokered = broker.requestPort();
const transport = new WorkerPortTransport(brokered.port);
const offSuccession = broker.onProvider(() => {
  // Another tab took the lock and now holds the worker. Reconnect through the broker; leadership
  // is the lock's to grant, and this message never says that this tab has it.
});

export const mirror = new WeftClientMirror({
  transport,
  scopeId: scopeId("user-1"),
  deviceId: deviceId("laptop"),
});

await mirror.hydrate();
```

The handover is never acknowledged: the broker forwards the port into another document and hears
nothing back. The `hydrate` above is what proves the port arrived: a reply to it is a document that
is still there. Its `durability` field is also how a tab handed a port learns what kind of database
it is reading. `brokered.refused` settles when the broker had no tab to give
the port to, which is a tab that opened while the winner of the election was still starting its
worker.

A dedicated worker dies with the document that created it, so when that tab goes, every other tab's
port breaks. The tab at the head of the lock queue learns of it from the Web Lock, which wakes one
waiter and tells nobody else; the rest learn of it from the broker, which passes the successor's
`provide()` on to every other connection as `onProvider`. That message asks a tab to reconnect and
can do nothing else: leadership is concluded from the lock alone, so a spurious one costs a
re-hydrate rather than a second worker on the access handle. `WeftClientMirror.attach` points the
mirror at a new connection, reloads the rows, and registers every statement the page is reading all
over again. A request in flight at that moment rejects: the tab cannot know whether the write
landed, and reporting success would be worse than reporting nothing. Nothing is applied
optimistically on the page and the database is durable, so the re-hydrate shows whatever committed.

Send `{ type: "disconnect" }` and dispose the mirror from a `pagehide` handler. A `MessagePort` has
no liveness signal the worker can rely on, so a tab that goes away without saying so leaves each
statement it watched registered, and the worker re-runs those statements after every mutation any
tab makes for the rest of the session.
