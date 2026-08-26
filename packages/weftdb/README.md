# weftdb

Main WeftDB runtime package.

A scope is the unit of sync and of authorization: one relay holds many scopes side by side, and a
scope holds one person's data across their devices. A bearer token resolves to one scope and one
device, and that comparison is the only boundary enforced — there is no per-row permission, and no
sharing of a scope between identities.

## Import Paths

```ts
import { defineSchema, S, WeftClient } from "weftdb";
import { deviceId, scopeId } from "weftdb/core";
import { schemaHash } from "weftdb/schema";
import { httpTransport } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { generateArtifacts } from "weftdb/codegen";
```

## Exports

- `weftdb` - core types, schema helpers, and client APIs.
- `weftdb/core` - branded ids, operation types, HLCs, diff3, ranks.
- `weftdb/shared` - hashing, the wire-value codec, the `SqlExecutor` and `AsyncSqlExecutor` ports.
- `weftdb/schema` - schema DSL and schema hashing.
- `weftdb/client` - client model, `openWeftDatabase`, sync, transports, subscriptions, query keys.
- `weftdb/client/sqlite` - SQLite-backed client store.
- `weftdb/client/wasm-sqlite` - wa-sqlite executor helpers.
- `weftdb/client/worker-entry` - `serveWeftStorageWorker`, the origin's storage `SharedWorker`.
- `weftdb/client/worker-host` - `serveWeftWorker`, the protocol host over one database.
- `weftdb/server` - in-memory schema-blind server.
- `weftdb/server/sqlite` - SQLite-backed server store.
- `weftdb/server/node-sqlite` - `node:sqlite` executor.
- `weftdb/server/relay` - HTTP relay handler.
- `weftdb/server/serve` - Node HTTP relay.
- `weftdb/server/websocket` - sync socket hub.
- `weftdb/server/websocket-frames` - WebSocket frame codec.
- `weftdb/server/snapshot` - snapshot serialization.
- `weftdb/server/jwt` - JWT verifier.
- `weftdb/codegen` - generated SQL, types, mutators, bindings, and reconciliation SQL.

## Schema

```ts
import { defineSchema, S, type DatabaseOf } from "weftdb/schema";

export const schema = defineSchema({
  tasks: S.collection({
    title: S.string(),
    notes: S.string({ merge: "diff3" }),
  }),
});

export type Database = DatabaseOf<typeof schema>;
```

## Client

```ts
import { deviceId, fieldName, rowId, scopeId, tableName } from "weftdb/core";
import { WeftClient } from "weftdb/client";

const client = new WeftClient(scopeId("user-1"), deviceId("laptop"), schema);

await client.create(tableName("tasks"), rowId("task-1"), {
  [fieldName("title")]: "Write README",
});
```

Writes return a promise — it resolves once the change has committed and rejects when it was
refused. Reads (`getRow`, `listRows`, `isRowDirty`) answer directly.

## SQLite Client Store

```ts
import { SqliteClientStore } from "weftdb/client/sqlite";

const store = new SqliteClientStore(executor, schema);
const client = await store.hydrate(scopeId, deviceId);
```

The executor is an `AsyncSqlExecutor`. The store creates missing tables and columns from the current
schema when opened.

## Storage Worker

One `SharedWorker` per origin holds every database that origin has open, and each tab reaches it
over a port of its own.

```ts
import { serveWeftStorageWorker, type WeftWorkerScope } from "weftdb/client/worker-entry";

const worker = serveWeftStorageWorker({ schema, sqlite });

(globalThis as unknown as WeftWorkerScope).onconnect = (event) => {
  const port = event.ports[0];
  if (port !== undefined) worker.connect(port);
};
```

`sqlite` builds the wa-sqlite API, the module it was built over, and the VFS its databases live in.
The page opens through `openWeftDatabase({ schema, scopeId, worker })`, naming that module's URL.

## Server

```ts
import { inProcessTransport } from "weftdb/client";
import { WeftServer } from "weftdb/server";

const server = new WeftServer();
await client.syncWith(inProcessTransport(server), schemaHash(schema));
```

Durable server:

```ts
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import { SqliteWeftServer } from "weftdb/server/sqlite";

using executor = openSqliteExecutor("./weft.sqlite");
const server = new SqliteWeftServer(executor);
```

## Relay

```ts
import { authContext, createRelayHandler, staticTokenVerifier } from "weftdb/server/relay";

const handler = createRelayHandler({
  server,
  verifier: staticTokenVerifier(new Map([["secret", authContext("user-1", "laptop")]])),
});
```

## Codegen

```ts
import { generateArtifacts } from "weftdb/codegen";

const artifacts = generateArtifacts(schema);
```
