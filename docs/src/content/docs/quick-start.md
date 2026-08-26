---
title: Quick start
description: Install the packages, define a schema, generate the artifacts, and sync two devices through a relay.
sidebar:
  order: 2
---

Before two devices can share data, a project needs the packages installed, a schema describing the
tables, and a relay running somewhere both devices can reach.
The relay is the small server devices sync through. It holds their data but knows nothing about
the schema.

## Install

:::note
The examples on this page run as plain `.ts` files, on a Node version with built-in TypeScript
support, in a project with `"type": "module"` set in `package.json`. Without either, run them
through a bundler or `tsx` instead.
:::

Install the runtime package, and add the CLI as a development dependency:

```sh
$ npm install weftdb
$ npm install --save-dev weftdb-cli
```

`weftdb` is the package a project imports from. `weftdb-cli` provides the `weft` command, used
below to turn a schema into the files a client and a relay need.

## Define a schema

Describe the data once, in TypeScript, with `defineSchema` and the `S` field builders:

```ts title="src/schema.ts"
import { defineSchema, S, type DatabaseOf } from "weftdb/schema";

export const schema = defineSchema({
  tasks: S.collection({
    title: S.string(),
    notes: S.string({ merge: "diff3" }),
    rank: S.string({ merge: "fracIndex" }),
  }),
});

export type Database = DatabaseOf<typeof schema>;
```

Every field carries a `merge` option that decides how two devices' edits to it combine. Left at
its default, a field keeps whichever edit was made later, and every device decides which one that
was by reading the same clock the same way. `title` behaves that way here.
`notes` merges edits to different lines of the same text instead of letting one erase the other.
`rank` lets many devices reorder rows without renumbering the ones between them.
[Defining a schema](/guides/defining-a-schema/) covers every field type and option, and the
[merge model](/concepts/merge-model/) covers every merge strategy in full.

## Generate the artifacts

Run `weft generate` after writing the schema, and again after every edit to it:

```sh
$ npx weft generate --schema src/schema.ts --out src/generated
```

The command writes the SQL for the local database and for the relay's own table, TypeScript types
for `Database`, and typed write helpers into `src/generated`.
[Generating artifacts](/guides/generating-artifacts/) lists every file it writes and when to
commit them.

## Run a relay

The CLI starts one. Leave it running in its own terminal:

```sh
$ npx weft serve --tokens laptop-token:user-1:laptop,phone-token:user-1:phone --db weft.sqlite

weft relay: listening on http://127.0.0.1:8787, storage weft.sqlite
```

`--tokens` maps each bearer token to the `scope_id` and `device_id` that sent it, matching the ids
a `WeftClient` is constructed with below. A relay with no way to authenticate anyone refuses to
run. `--db` names a SQLite file to persist into and is optional: leaving it out keeps everything
in memory until the process exits. `--host` and `--port` move it off `0.0.0.0:8787`, and
`GET /health` answers without a token, for a process manager to poll.

Every flag has an environment variable of the same name, so `--port` is `WEFT_PORT`, and a flag
wins over the environment. That is how the container image is configured. Run `weft serve --help`
for the full set, including the `--jwt-*` flags that verify signed tokens instead of listing them.

For a deployment rather than a terminal, the same relay ships as a container image:

```sh
$ docker run -p 8787:8787 -v weft-data:/data \
    -e WEFT_TOKENS=laptop-token:user-1:laptop,phone-token:user-1:phone \
    ghcr.io/msiemens/weftdb-relay:latest

weft relay: listening on http://0.0.0.0:8787, storage /data/weft.sqlite
```

The image is distroless and runs as a non-root user with no shell. Its command line is fixed, so
it is configured by the environment variables rather than the flags. It persists to
`/data/weft.sqlite` by default, which is why the example mounts a volume there: a relay that
forgot its data on restart would hand every device a full resync and lose whatever had not been
pushed yet. [Running the relay](/guides/running-the-relay/) covers deployment in full, along with
the authentication a relay reachable from outside a laptop needs.

## Sync two devices

With the relay running in one terminal, run the following in another:

```ts title="sync.ts"
import { deviceId, fieldName, rowId, scopeId, tableName } from "weftdb/core";
import { httpTransport, WeftClient } from "weftdb/client";
import { schemaHash } from "weftdb/schema";
import { schema } from "./src/schema.ts";

const hash = schemaHash(schema);
const relay = (token: string) => httpTransport({ baseUrl: "http://localhost:8787", token });

const laptop = new WeftClient(scopeId("user-1"), deviceId("laptop"), schema);
await laptop.create(tableName("tasks"), rowId("task-1"), {
  [fieldName("title")]: "Write the quick start",
  [fieldName("notes")]: "",
  [fieldName("rank")]: "a0",
});
await laptop.syncWith(relay("laptop-token"), hash);

const phone = new WeftClient(scopeId("user-1"), deviceId("phone"), schema);
await phone.syncWith(relay("phone-token"), hash);

console.log(phone.getRow(tableName("tasks"), rowId("task-1"))?.fields.get(fieldName("title")));
```

```sh
$ node sync.ts

Write the quick start
```

Every write returns a promise, and awaiting it is how a caller learns the write was stored.
`create` makes the row on `laptop` and queues it; the sync that follows pushes it to the relay.
`phone` starts with nothing local. Its sync pulls the row down before `getRow` reads it back, still
under the title `laptop` wrote. Reads answer directly, without a promise.

The [todo list demo](/demos/todo/) runs the same push and pull across two browser tabs, with the
unsent count, live updates, and conflicts visible as they happen instead of printed to a console.
[React](/guides/react/) wires the same client and the generated bindings to a component, in place
of calling `syncWith` and `getRow` directly.
