# weftdb

TypeScript local-first sync for single-user, multi-device apps.

One relay serves many users side by side, each in a scope of their own; within a scope the data
belongs to one person and syncs across their devices. There is no collaboration: merges and the
repair UI both assume the person resolving a conflict is the person who made both sides of it.
Devices may be offline for months.

WeftDB provides:

- Typed schema definitions.
- Local client state with outbox, tombstones, conflict handling, and durable persistence.
- A schema-blind relay/server.
- Generated SQL, TypeScript types, mutators, query bindings, and React hooks.

## Packages

- [`weftdb`](./packages/weftdb/README.md) - runtime package and subpath exports.
- [`weftdb-react`](./packages/weftdb-react/README.md) - React hooks.
- [`weftdb-cli`](./packages/weftdb-cli/README.md) - `weft` command.

Demos live under [`demos/`](./demos) and are not published:

- [`weftdb-demo-todo`](./demos/todo-list/README.md) - a shared todo list, one device per browser tab.
- `weftdb-demo-shared` - identity, token verifier, and the relay each demo runs against.

## Install

```sh
pnpm install
```

## Try The Demo

```sh
pnpm demo
```

## Define A Schema

```ts
import { defineSchema, S, type DatabaseOf } from "weftdb/schema";

export const schema = defineSchema({
  tasks: S.collection({
    title: S.string(),
    notes: S.string({ merge: "diff3" }),
    rank: S.string({ merge: "fracIndex" }),
  }),
  task_events: S.eventLog({
    task_id: S.string(),
    status: S.string(),
  }),
});

export type Database = DatabaseOf<typeof schema>;
```

## Generate Artifacts

```sh
weft generate --schema src/schema.ts --out src/generated
```

Programmatic generation:

```ts
import { generateArtifacts } from "weftdb/codegen";
import { schema } from "./schema.ts";

const artifacts = generateArtifacts(schema);
```

## Sync

```ts
import { deviceId, fieldName, rowId, scopeId, tableName } from "weftdb/core";
import { schemaHash } from "weftdb/schema";
import { WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { schema } from "./schema.ts";

const server = new WeftServer();
const client = new WeftClient(scopeId("user-1"), deviceId("laptop"), schema);

client.create(tableName("tasks"), rowId("task-1"), {
  [fieldName("title")]: "Write the sync spec",
  [fieldName("notes")]: "Keep protocol state typed.",
});

client.sync(server, schemaHash(schema));
```

## Run The Relay

```sh
pnpm build:server
WEFT_TOKENS=secret:user-1:laptop WEFT_DB=./weft.sqlite node dist/server.mjs
```

Docker:

```sh
docker build -t weftdb-server .
docker run -p 8787:8787 -v weft-data:/data -e WEFT_TOKENS=secret:user-1:laptop weftdb-server
```

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

Testing details are in [TESTING.md](./TESTING.md).
