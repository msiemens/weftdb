---
title: Defining a schema
description: Collections, event logs, field types, merge annotations, relationships, and retention anchors.
sidebar:
  order: 1
---

A schema is one TypeScript object, built with `defineSchema` and the `S` field builders. It is
the source that generates the local SQLite tables, the row types, the typed write helpers, and
the hash two devices compare to confirm they agree on the shape of the data. `defineSchema`
takes a record of collections, checks every collection and field name in it, and returns the
schema; `S` supplies the builders for fields, collections, and relationships.

This schema extends the one [Quick start](/quick-start/) defines:

```ts title="src/schema.ts"
import { defineSchema, S, type DatabaseOf } from "weftdb/schema";

export const schema = defineSchema({
  tasks: S.collection(
    {
      title: S.string(),
      notes: S.string({ merge: "diff3" }),
      rank: S.string({ merge: "fracIndex" }),
      priority: S.number({ nullable: true }),
      done: S.boolean(),
      due_at: S.date({ nullable: true, retentionAnchor: true }),
      status: S.enum(["open", "done"]),
      metadata: S.json({ nullable: true }),
      logged_minutes: S.number({ derived: "SUM(task_events.minutes)" }),
    },
    { events: S.hasMany("task_events", "id", "task_id") },
  ),
  task_events: S.eventLog({
    task_id: S.string(),
    kind: S.string(),
    minutes: S.number(),
  }),
});

export type Database = DatabaseOf<typeof schema>;
```

## Choosing a collection or an event log

`S.collection()` and `S.eventLog()` both take a record of field definitions and an optional
relationships object. The difference is in the mutators `weft generate` writes for the result. A
collection gets `create`, `update`, and `delete`; an event log gets `create` alone, so nothing in
the generated interface lets an application revise or remove a row after writing it. An event log
is a distinct kind rather than a collection an application merely refrains from updating, because
the relay enforces the same insert-only rule independently of the mutators, which is what lets
two devices append to the same history at once and converge without merging anything.

## Choosing field types

`S` offers six field types: `string`, `number`, `boolean`, `json`, `date`, and `enum`. `number`
and `boolean` store as an `INTEGER` column; the rest store as `TEXT`. `date` stores as an
ISO-8601 string, so `due_at` above is exactly what a device writes and what the column holds.
`json` stores its value as `TEXT` and carries the same scalar-or-array-or-object type sync itself
moves. `enum` takes a non-empty list of string values, generates a column with a `CHECK`
constraint, and narrows the row type to that union instead of the general `string`; `status`
above accepts only `"open"` or `"done"`. Every builder also accepts `nullable`, which adds `null`
to both the row type and the column; `priority`, `due_at`, and `metadata` above are nullable.

## Annotating fields

### Merge strategy

Every field carries a `merge` option, defaulting to `lww`. [Merge model](/concepts/merge-model/)
covers the mechanics in full; the values are:

| Value       | What it does                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `lww`       | Keeps whichever edit has the later clock reading, compared the same way on every device              |
| `diff3`     | Merges edits to different lines of text, with marker syntax where two devices changed the same lines |
| `fracIndex` | Lets any device reorder rows by writing one rank, without renumbering the rows around it             |
| `immutable` | Accepts the first write and rejects every later one                                                  |

`title` above keeps the default. `notes` uses `diff3` because two devices editing the same
paragraph under `lww` would discard one edit entirely. `rank` uses `fracIndex` because reordering
a list under `lww` would otherwise mean rewriting every row between the old position and the new
one. Reach for `immutable` on a value nothing should revise after creation, which is how the base
fields below are declared.

### Derived fields

`derived` takes a SQL select fragment instead of a merge option, as on `logged_minutes` above. A
derived field is never written by a mutator: `weft generate` gives it no column and no place in
the generated mutation interface, because its value comes from the fragment rather than from an
edit. Declaring a field `derived` keeps it present in the entity type on every row, rather than
present only where a particular query happened to compute it.

### Retention anchors

`retentionAnchor` marks the field a retention policy measures a row's age from, as on `due_at`
above. [Retention and deletion](/guides/retention-and-deletion/) covers how a device computes an
expiry date from it and pushes the resulting deletes.

### Relationships

A collection's second argument declares its relationships, built with
`S.hasMany(table, localField, foreignField)` and `S.hasOne(table, localField, foreignField)`.
Above, `tasks` declares `events` as `S.hasMany("task_events", "id", "task_id")`, naming the
related table and the field on each side that joins them. `weft generate` turns that declaration
into a `tasks_eventsRelation()` helper carrying the target table, the join fields, and whether the
relation returns one row or many, for the query layer to consume. Reach for a relationship when
generated queries need to fetch related rows together rather than as separate subscriptions.

## Base fields and reserved names

Every collection and event log carries three fields the framework adds automatically: `id` and
`scope_id`, both `string` and `immutable`, and `created`, a `date` and `immutable`. They are not
written into the fields object passed to `S.collection` or `S.eventLog`; each builder adds them to
the definition it returns, and the relay rejects any attempt to modify them, using the
`base_field_violation` reason.

A field name beginning with `_weft_` is refused by `defineSchema`, because that prefix is reserved
for the columns codegen adds itself, such as `_weft_rev` and `_weft_dirty`. Naming a field
`_weft_anything` throws before the schema reaches `weft generate`.

## Naming rules

`defineSchema` checks every collection and field name before returning the schema. A name must be
at least one character long and must not contain a control character. A control character does
not survive being written down: SQLite stops reading an identifier at the first NUL byte it
contains, so two different names could end up as the same shortened column. Both checks apply
identically to collection names and to field names.

`weft generate` adds a further check once it capitalises each collection name into a TypeScript
identifier: `todo_events` and `todoEvents` produce the same identifier, and the command refuses to
run rather than let one collection's query, decoder, hook, and mutators overwrite the other's.
Renaming one of the colliding collections is the only fix, which is worth knowing before that
error is the first time it comes up.

## Typing the database with `DatabaseOf`

`DatabaseOf<typeof schema>` maps a schema to a record with one property per collection, each
holding the entity type `S.collection` or `S.eventLog` produced for it: `nullable` fields carry
`| null`, and an `enum` field is narrowed to its literal values rather than the general `string`.
The schema above exports this as `Database`, and a project uses that type wherever it needs the
shape of a row, such as a function that accepts one.
