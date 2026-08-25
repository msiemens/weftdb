---
title: Reading data
description: Query builders, query keys, generated decoders, the Database and InternalDatabase interfaces, relations, and nested records.
sidebar:
  order: 3
---

Application code reads through the functions `weft generate` writes for each collection. A
component reads a whole collection with `use<Collection>`, or part of one with
`use<Collection>Query`, which takes a query builder and does the filtering, ordering, and paging
in the database. Against the client directly, reading means `WeftClient.getRow` and
`WeftClient.listRows`.

## Filtering, ordering, and paging

`use<Collection>Query` takes a callback and hands it a statement over that collection. Chain
`where`, `orderBy`, `limit`, and `offset` onto it:

```tsx
import { useTodosQuery } from "./generated/bindings.ts";
import type { WeftSqlSource } from "./generated/bindings.ts";

export function OpenTodos({ source }: { source: WeftSqlSource }) {
  const todos = useTodosQuery(source, (todos) => todos.where("done", "=", false).orderBy("rank").limit(20));
  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  );
}
```

The statement is typed against the generated `Database`, so a predicate naming a field the schema
does not declare, or comparing one against the wrong type, does not compile.

The statement arrives already selecting `id` and already constraining `scope_id`, and a callback
can only add to it. Scoping is not the caller's to remember: one database file holds every scope a
person is signed into, and a row id is unique only within its collection, so an unscoped statement
can match another scope's row and hand it back under this scope's id.

`use<Collection>Query` re-renders when the rows it selected change, on the same terms as every
other generated hook. The statement decides which rows and in what order; the rows themselves come
from the client's in-memory map, so a row that did not change is the same object it was and
`React.memo` still skips it. The statement runs once per change rather than once per render.

`WeftSqlSource` is the client's engine and row map, the scope the statements are confined to, and
`select`, which answers which rows a statement matched: `{ engine, rows, select, scopeId }`.

`select` is a function rather than a database because the database is not always on the thread
that renders. On a device holding it there, `executorRowSelect(executor)` runs the statement. On a
device holding it in a worker, a `WeftClientMirror` reads the ids that worker last pushed and
satisfies `WeftSqlSource` on its own. Both answer synchronously, which is what a snapshot read
during render requires, and a component sees neither.

:::note
A browser reaches SQLite through a worker, because the only synchronous handle exists inside one.
[Storage on the device](/guides/device-storage/) covers the worker and the mirror that carries its
rows to the page.
:::

## Reading a whole collection

`use<Collection>` returns every row of a collection, ordered by one field:

```tsx
const todos = useTodos(source, "rank");
```

What it asks for is a `QueryKey`: one collection, the fields a row must carry, and at most one
field to order by.

```ts
import type { FieldName, TableName } from "weftdb/core";

export interface QueryKey {
  readonly tableName: TableName;
  readonly fields: readonly FieldName[];
  readonly orderBy?: FieldName;
}
```

A query key has no other members. There is no `where`, no `limit`, and no `offset`, and `orderBy`
names one field rather than a list. The engine scans the client's row map, keeps the rows of the
named collection that carry every listed field, and sorts them by `orderBy` ascending with `id` as
the tiebreak. Values are compared as text, so a number field orders lexicographically.

Use `use<Collection>` for a collection a device holds all of, and `use<Collection>Query` when the
answer is a part of one, is ordered by more than one field, or is a page. The query key path reads
the row map alone, so it is also the path that works on a device with no SQL database, such as one
storing through `WebStorageClientStore`.

The generated helper `todosQuery(orderBy)` builds the key, and `queryKey(schema, table, options)`
builds one for a query an application assembles itself. Both validate names against the schema and
throw on a collection or field it does not declare.

## Reading a row

`getRow` returns one row or `undefined`, and `listRows` returns every row in a table:

```ts
import { rowId, tableName } from "weftdb/core";

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
[React](/guides/react/) covers how a component subscribes and re-renders when a result changes.

## The generated interfaces

Alongside the decoders, `weft generate` writes `Database` and `InternalDatabase` from the schema.
`Database` lists only the fields a collection declares. It is the interface a decoded row
satisfies, and the one a query builder's statement is typed against:

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

A declared field is stored in a column of its own, as the type it declares: a number as a number, a
boolean as 1 or 0, a string, date, or enum as itself. That is what lets a statement compiled
against `Database` match the rows the store wrote.

`InternalDatabase` adds every column the sync engine reads and writes: a clock reading per
mergeable field (`_weft_hlc_title`), the diff3 ancestor for a field merged that way
(`_weft_base_notes`), the revision and dirty counters (`_weft_rev`, `_weft_dirty`), and
`_weft_null_fields`, which records the fields a row holds as null so that a field written as null
stays distinct from one never written. Application code never sees `InternalDatabase`. A decoded
row is typed against `Database` alone, so none of those columns can appear in an editor's
autocomplete for it.

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
and whether the relationship is one row or many. The helper returns that description and performs
no read. Resolve a relationship by reading the target collection with a statement that matches
`foreignField` against the ids the source rows carry.

## Nested records

A field name that contains a double underscore is a path into a nested object rather than a flat
value. A field declared as `view_settings__sort_order` is stored as one column, and a decoded row
exposes it as `view_settings.sort_order`:

```ts title="src/schema.ts"
import { defineSchema, S } from "weftdb/schema";

export const schema = defineSchema({
  custom_views: S.collection({
    view_settings__sort_order: S.number(),
    view_settings__column_width: S.number(),
  }),
});
```

`weft generate` writes one mapper per collection that needs it, named `map<Collection>Row`, which
reassembles the paths before a decoder reads the result. Merge state stays attached to the flat
column underneath, under the same [merge model](/concepts/merge-model/) that governs every other
field, so two devices changing `sort_order` and `column_width` in the same record do not conflict
with each other. A statement names the flat column, because that is the column the table has. Only
what a read returns is nested.

[Writing data](/guides/writing-data/) covers the other half of a generated collection: the
mutators that write the rows a query reads back.
