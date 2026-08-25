# weftdb

Main WeftDB runtime package.

## Import Paths

```ts
import { defineSchema, S, WeftClient } from "weftdb";
import { deviceId, scopeId } from "weftdb/shared";
import { schemaHash } from "weftdb/schema";
import { httpTransport } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { generateArtifacts } from "weftdb/codegen";
```

## Exports

- `weftdb` - shared types, schema helpers, and client APIs.
- `weftdb/shared` - branded ids, operation types, HLCs, diff3, ranks, hashing, SQL port.
- `weftdb/schema` - schema DSL and schema hashing.
- `weftdb/client` - client model, sync, transports, subscriptions, query keys.
- `weftdb/client/sqlite` - SQLite-backed client store.
- `weftdb/client/wasm-sqlite` - sqlite-wasm executor helpers.
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
import { deviceId, fieldName, rowId, scopeId, tableName } from "weftdb/shared";
import { WeftClient } from "weftdb/client";

const client = new WeftClient(scopeId("user-1"), deviceId("laptop"), schema);

client.create(tableName("tasks"), rowId("task-1"), {
  [fieldName("title")]: "Write README",
});
```

## SQLite Client Store

```ts
import { SqliteClientStore } from "weftdb/client/sqlite";

const store = new SqliteClientStore(executor, schema);
const client = store.hydrate(scopeId, deviceId);
```

The store creates missing tables and columns from the current schema when opened.

## Server

```ts
import { WeftServer } from "weftdb/server";

const server = new WeftServer();
client.sync(server, schemaHash(schema));
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
