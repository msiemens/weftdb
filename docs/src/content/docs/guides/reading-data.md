---
title: Reading data
description: Generated query helpers, the Database and InternalDatabase interfaces, relations, nested records, and the worker boundary.
sidebar:
  order: 3
---

Application code reads through the functions `weft generate` writes for each collection, never
through SQL composed by hand. For the `tasks` collection from the quick start, that means a
generated query key, a decoder, and a React hook. Against the client directly, it means
`WeftClient.getRow` and `WeftClient.listRows`.

## Reading a row

`getRow` returns one row or `undefined`, and `listRows` returns every row in a table:

```ts
import { rowId, tableName } from "weftdb/shared";

const task = client.getRow(tableName("tasks"), rowId("task-1"));
const tasks = client.listRows(tableName("tasks"));
```

Both return a `MaterializedRow`: a frozen object with `id`, `scope_id`, `created`, and a `fields`
map keyed by `FieldName`. That shape is the same for every collection, so a decoder is what turns
it into the row type a collection actually promises. `weft generate` writes one decoder per
collection:

```ts title="src/generated/bindings.ts"
export function decodeTodos(row: MaterializedRow): TodosRow {
  return {
    id: typeof row.fields.get(fieldName("id")) === "string" ? (row.fields.get(fieldName("id")) as string) : "",
    scope_id:
      typeof row.fields.get(fieldName("scope_id")) === "string"
        ? (row.fields.get(fieldName("scope_id")) as string)
        : "",
    created:
      typeof row.fields.get(fieldName("created")) === "string" ? (row.fields.get(fieldName("created")) as string) : "",
    title: typeof row.fields.get(fieldName("title")) === "string" ? (row.fields.get(fieldName("title")) as string) : "",
    notes: typeof row.fields.get(fieldName("notes")) === "string" ? (row.fields.get(fieldName("notes")) as string) : "",
    done: row.fields.get(fieldName("done")) === true,
    rank: typeof row.fields.get(fieldName("rank")) === "string" ? (row.fields.get(fieldName("rank")) as string) : "",
    due_at:
      typeof row.fields.get(fieldName("due_at")) === "number" ? (row.fields.get(fieldName("due_at")) as number) : null,
    auto_delete_days:
      typeof row.fields.get(fieldName("auto_delete_days")) === "number"
        ? (row.fields.get(fieldName("auto_delete_days")) as number)
        : null,
  };
}
```

A query key and its decoder are paired by a `TypedQueryKey<Row>`, so passing the query key for one
collection to the decoder for another is a compile error rather than a row that reads back wrong.
The generated hook, `useTodos`, wraps both behind `useWeftRows`; [React](/guides/react/) covers how
a component subscribes to one and re-renders when it changes.

## The generated interfaces

Alongside the decoders, `weft generate` writes `Database` and `InternalDatabase` from the schema.
`Database` lists only the fields a collection declares, and it is the interface a decoded row
satisfies:

```ts title="src/generated/database.d.ts"
export interface Database {
  todos: {
    id: string;
    scope_id: string;
    created: string;
    title: string;
    notes: string;
    done: boolean;
    rank: string;
    due_at: number | null;
    auto_delete_days: number | null;
  };
  // todo_events follows the same pattern
}
```

`InternalDatabase` adds every column the sync engine reads and writes: a clock reading per
mergeable field (`_weft_hlc_title`), the diff3 ancestor for a field merged that way
(`_weft_base_notes`), and the revision and dirty counters (`_weft_rev`, `_weft_dirty`). Application
code never sees `InternalDatabase`. A decoded row is typed against `Database` alone, so none of
those columns can appear in an editor's autocomplete for it.

## Crossing the worker boundary

Building a query and running it are two separate steps. A query builder's `compile()` method runs
on the calling thread and yields a `CompiledQuery`. The compiled query is what crosses a worker
boundary:

```ts
import type { WireValue } from "weftdb/shared";

export interface CompiledQuery {
  readonly sql: string;
  readonly parameters: readonly WireValue[];
}

export function queryCacheKey(query: CompiledQuery): string {
  return JSON.stringify({ sql: query.sql, parameters: query.parameters });
}
```

`OpfsWorkerTransport` sends a `CompiledQuery` over `postMessage` and returns its result the same
way, so nothing but the compiled statement and its parameters leaves the calling thread. The same
pair is also the subscription's identity: `queryCacheKey` derives a cache key from `sql` and
`parameters` together, so two builders that compile to the same statement share one cached result
and one set of subscribers.

## Relations

A collection's schema can declare a relationship with `S.hasMany` or `S.hasOne`, naming the
related table and the two fields that join to it:

```ts title="src/schema.ts"
import { defineSchema, S } from "weftdb/schema";

export const schema = defineSchema({
  todos: S.collection({ title: S.string() }, { events: S.hasMany("todo_events", "id", "todo_id") }),
  todo_events: S.eventLog({
    todo_id: S.string(),
  }),
});
```

`weft generate` writes one helper per declared relationship, named
`<collection>_<relationship>Relation`, returning the source table, the target table, both fields,
and whether the relationship is one row or many. Fetching a collection together with its relation
is one round trip. Joining two separately subscribed collections in application code is not
offered, because it would double the paths that have to be invalidated whenever either side
changes.

## Nested records

A field name that contains a double underscore is a path into a nested object rather than a flat
value. A field declared as `nutrition_facts__sodium` is stored as one column, and a decoded row
exposes it as `nutrition_facts.sodium`:

```ts title="src/schema.ts"
import { defineSchema, S } from "weftdb/schema";

export const schema = defineSchema({
  meals: S.collection({
    nutrition_facts__sodium: S.number(),
    nutrition_facts__vitamin_d: S.number(),
  }),
});
```

`weft generate` writes one mapper per collection that needs it, named `map<Collection>Row`, which
reassembles the paths before a decoder reads the result. Merge state stays attached to the flat
column underneath, under the same [merge model](/concepts/merge-model/) that governs every other
field, so two devices correcting `sodium` and `vitamin_d` in the same record do not conflict with
each other. A query's filters still name the flat column; only what a read returns is nested.

[Writing data](/guides/writing-data/) covers the other half of a generated collection: the
mutators that write the rows a query reads back.
