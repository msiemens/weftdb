---
title: Writing data
description: Typed mutators, awaiting a write, the outbox, transactions, why there is no optimistic layer, and collections named at runtime.
sidebar:
  order: 4
---

Application code writes through the mutators `weft generate` writes per collection, alongside the
query key and decoder [reading data](/guides/reading-data/) covers. Which methods a collection gets
depends on how it was declared:

| Collection kind | Generated methods            | What `create` calls |
| --------------- | ---------------------------- | ------------------- |
| `S.collection`  | `create`, `update`, `delete` | `WeftClient.create` |
| `S.eventLog`    | `create`                     | `WeftClient.append` |

## Generated mutators

A `tasks` collection declared with `S.collection` gets all of them:

```ts
await tasks.create("task-1", { title: "Write the quick start", notes: "", rank: "a0" });
await tasks.update("task-1", { title: "Write the guide" });
await tasks.delete("task-1");
```

Each call is typed against the collection's own mutation input, generated from its fields, so a
field the schema does not declare or one marked `merge: "immutable"` is a compile error rather
than a write that is silently accepted and then never applied.

## What a mutator call does

`tasks.update("task-1", { title: "Write the guide" })` returns a promise. `WeftClient.update`
writes the new value into the row it holds, appends a `set` operation to the outbox, advances the
row's `_weft_rev` counter, and writes the result through to the device's database. The promise
resolves once that database write has committed. `create`, `delete`, `restore`, and `append`
follow the same shape.

## Awaiting a write

A mutation whose promise resolves has been committed to the device's database. A mutation whose
promise rejects was refused, and the rejection names which refusal it was: an event-log row that
cannot be edited, a row that does not exist, a value SQLite cannot store. A caller that awaits the
promise is told which of the two happened.

A caller that does not await accepts a window in which the change is in the worker's memory and
not yet in the file. Discarding the promise is something the call site has to write down, because
`@typescript-eslint/no-floating-promises` refuses it otherwise:

```ts
void tasks.update("task-1", { title: "Write the guide" });
```

[React](/guides/react/) covers the same idiom inside an event handler, where there is nowhere to
put an `await`.

There is no method on `WeftClient` that writes to local storage without also queuing an outbox
entry. `create`, `update`, `delete`, `restore`, and `append` are the only ways to change a row, and
every one of them pushes an operation onto the outbox as part of the same call. Application code
never gets a handle to the on-device database that would let it write around this: the generated
mutators call nothing but these five methods, and there is no method that takes a query instead of
a table, a row id, and typed values. The outbox is the only path a write can take, which makes it
a complete record of everything a device has done that the relay has not yet seen.

## Local storage is the source of truth

A mutator call has nothing to roll back, because there is no server-confirmed copy for a locally
written row to diverge from. The row `update` writes into is the same row `getRow` and `listRows`
read back immediately afterwards; nothing else holds a separate, pending version of it. An
optimistic-update model, the one most readers arrive with, treats a local write as provisional
until a server confirms it, with a rollback path for when it does not. weftdb has no such layer.
Local storage is the client's actual state, kept current by each mutator call directly, so a write
is finished, from the application's perspective, when that call's promise resolves. A later sync
either leaves the write alone, because it was accepted, or moves it to quarantine, because it was
rejected. [Handling conflicts](/guides/handling-conflicts/) covers what an application does with a
rejected write.

## Transactions

Every write to `WeftClient` carries a `txnId`. The generated mutators supply one automatically:
`create` derives it from the row's own id, since a row is created once, while `update` and `delete`
append a random suffix, since the same row can be written to more than once before a sync. Creating
a row bundles its opening `create` operation and its initial field values under one `txnId`, so a
row is never visible on the relay without the fields it was created with. Atomicity is a property
of the transaction: the relay applies every operation sharing a `txnId` as one unit, and rejects
the whole transaction if any part of it is rejected. For a `diff3` field, `update` also computes a
base hash from the value the client last wrote, used to detect that the relay has moved on since.
[Merge model](/concepts/merge-model/) covers what happens with that hash on both sides.

## Appending to an event log

A collection declared with `S.eventLog` instead of `S.collection` is append-only:

```ts title="src/schema.ts"
import { defineSchema, S } from "weftdb/schema";

export const schema = defineSchema({
  todos: S.collection({
    title: S.string(),
  }),
  // Append-only: rows are written once and never edited afterwards.
  todo_events: S.eventLog({
    todo_id: S.string(),
    kind: S.string(),
    actor: S.string(),
  }),
});
```

`weft generate` gives an event-log collection a `create` method and nothing else, and
`WeftClient.update`, `delete`, and `restore` all refuse a row that belongs to one. The generated
`create` does not call `WeftClient.create`: it calls `WeftClient.append`, which starts a row the
same way `create` does and then reclassifies its opening transaction so the relay treats the row as
append-only from then on:

```ts
await todoEvents.create(`event-${crypto.randomUUID()}`, {
  todo_id: "task-1",
  kind: "completed",
  actor: "laptop",
});
```

Each call writes a new row rather than editing an existing one, so two devices logging an event at
the same moment produce two rows rather than a write racing another, and there is nothing for
either device to merge.

## Writing a collection named at runtime

A generated mutator names its collection when `weft generate` runs, which is what gives it a
mutation input of its own and lets it leave out a field marked `merge: "immutable"`. Where the
collection is picked while the code runs, there is nothing for the generator to name.
`createWeftDb` takes a client and a schema and offers `create`, `update`, `delete`, `get`, and
`list` over any collection the schema declares:

```ts
import { createWeftDb } from "weftdb/client";
import { schema } from "./schema.ts";

const db = createWeftDb(client, schema);
const counts = new Map<string, number>();

for (const table of ["todos", "todo_events"] as const) {
  counts.set(table, db.collection(table).list().length);
}
```

Values are typed from the schema, so a field the collection does not declare does not compile, and
a field declared `S.json({ as })` carries the type it declares. `create`, `update`, and `delete`
return promises on the same terms as a generated mutator and take the same optional `txnId`, and
`create` appends where the collection is an event log. `get` and `list` answer directly. The name
has to be one the schema declares, so a name read back out of `Object.keys(schema.collections)` as
a `string` does not compile.

It accepts a field marked `merge: "immutable"`, which the generated mutation input leaves out and
the relay applies like any other write. It takes no `notify` callback, so a component subscribed
through the engine has to be woken some other way. Use the generated mutators wherever the
collection name is known when the code is written.
