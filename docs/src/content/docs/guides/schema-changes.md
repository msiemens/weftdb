---
title: Schema changes
description: The schema hash handshake, and deploying a schema change without a server migration.
sidebar:
  order: 11
---

weftdb never runs a migration against the relay, the server devices sync through. The relay
stores field values in one generic table and never learns an application's table shapes, so adding
a field to a schema is a change deployed to devices, never to the relay.
[Architecture](/concepts/architecture/) covers why the relay's own table never has to change.

## Hashing the schema

`schemaHash()`, from `weftdb/schema`, hashes the whole schema: `schemaVersion`, and for every
collection its kind and, for every field, its name, `type`, `merge` annotation, `nullable` flag,
allowed `values`, and `retentionAnchor` flag, plus every relationship's target table and its two
field names. Fields are read as an object keyed by name, so a rename changes the hash exactly as a
changed `type` does.

The relay never reads the hash. It stores whatever the first device sends as an opaque string on
the scope, the unit of data one person's devices share (see [Scopes](/concepts/scopes/)), and
compares later hashes to it for exact equality. Catching a device on a different schema than the
rest of its scope is the hash's only job.

## Handling handshake outcomes

`handshakeRequest()` sends the current hash, `schema.schemaVersion`, and the device's last known
server sequence. The relay's response reduces to one of three outcomes:

| Outcome    | Relay response                             | What `sync` and `syncWith` do                          |
| ---------- | ------------------------------------------ | ------------------------------------------------------ |
| `continue` | `{ ok: true }`                             | Push queued writes, then pull                          |
| `resync`   | `{ ok: false, reason: "resync_required" }` | Pull a full copy of the scope before applying anything |
| `abort`    | `{ ok: false, reason: "schema_mismatch" }` | Return immediately                                     |

:::caution
An `abort` outcome throws nothing and logs nothing. `sync` and `syncWith` return before pushing or
pulling, leaving unsent writes exactly where they were. A device stuck here looks like it syncs
normally on every open, and nothing moves until its code changes.
:::

## Reconciling the database on open

Before a device's first sync after an upgrade, its local SQLite database only has the columns an
earlier schema created. `SqliteClientStore.installSchema()` creates any table the current schema
adds, and adds whatever column that schema expects and an existing table lacks. That covers the
field itself, its `_weft_hlc_<field>` stamp column, and, for a field whose
[merge annotation](/concepts/merge-model/) is `diff3`, its `_weft_base_<field>` column. This runs on
every open, so a device that skipped several schema versions while offline catches up in one pass.

Reconciliation only ever adds a column. It does not compare an existing column's stored type
against the field's current one, and it never drops or renames a column.

## Deploying a schema change

1. Edit the schema and raise `schemaVersion`, the second argument to `defineSchema()`. The relay
   adopts a new hash only when the version rises; an equal version with a changed hash mismatches
   permanently.
2. Run `weft generate` to refresh the artifacts. [Generating artifacts](/guides/generating-artifacts/)
   lists what it writes.
3. Ship the new build however the application is normally deployed. weftdb has no separate deploy
   step of its own.
4. The first device to sync on the new build rolls the scope forward: the relay adopts the higher
   `schemaVersion` and its hash the moment it sees them.
5. Every other device gets `schema_mismatch` until it runs the new build too. A device offline
   throughout the change is in the same position once it reconnects: its handshake depends only on
   which build it is running, not on how long it was gone.

```ts title="src/schema.ts"
import { defineSchema, S, type DatabaseOf } from "weftdb/schema";

export const schema = defineSchema(
  {
    tasks: S.collection({
      title: S.string(),
      notes: S.string({ merge: "diff3" }),
      rank: S.string({ merge: "fracIndex" }),
      done: S.boolean(), // the new field
    }),
  },
  2, // was 1
);

export type Database = DatabaseOf<typeof schema>;
```

## Sequencing updates before the handshake

A rarely opened device is the one most likely to still be running an old build: whatever bundle a
service worker served at startup is the code computing the handshake's hash, regardless of what
has already shipped. Calling `sync` or `syncWith` before a background update check has finished
runs the handshake against that stale build, on every open, even after a newer one has been
fetched.

:::caution
Because the abort is silent, this reads as a device that fails to sync on every single open. Wait
for the update to finish applying, so the code sending the handshake is the code that matches the
deployed hash, before the first `sync` or `syncWith` call of a session.
:::

## Recovering a scope with `weft set-schema-hash`

The handshake has no path to move a scope's schema version backward: a lower version always
mismatches, whatever the hash. Rolling code back after a bad deploy therefore needs an operator to
move the scope directly. `weft set-schema-hash --scope <id> --hash <hash> --version <version>`
prints the SQL that does it, or writes it with `--out`, to run against the relay's own SQLite
file, the one passed to `weft serve --db`.

```sh
$ npx weft set-schema-hash --scope user-1 --hash 3f2a9c1b8e --version 3

INSERT INTO scope_state (scope_id, server_seq, tombstone_floor_seq, schema_hash, schema_version)
VALUES ('user-1', 0, 0, '3f2a9c1b8e', 3)
ON CONFLICT(scope_id) DO UPDATE SET
  schema_hash = excluded.schema_hash,
  schema_version = excluded.schema_version;
```

## Choosing what is safe to change

| Change                      | What the client does locally                                                  | Position                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adding a field              | Adds the missing column on next open                                          | Safe: the supported path                                                                                                                                                    |
| Removing a field            | Leaves the old column and its data in place                                   | Safe: nothing is dropped, though the evolution check below flags it                                                                                                         |
| Renaming a field            | Leaves the old column, starts the new one empty                               | Not safe as a plain rename: treat it as a remove and an add, migrating the value in application code if it must carry over                                                  |
| Changing a merge annotation | Adds `_weft_base_<field>` if the new annotation is `diff3`, otherwise nothing | Safe at the storage layer                                                                                                                                                   |
| Changing a field's type     | Leaves the existing column's declared type as it was                          | Not safe once a device has already stored the field under the old type                                                                                                      |
| Changing an enum's values   | Leaves the existing column's `CHECK` constraint as it was                     | Not safe: the old column refuses a value the new build writes. The allowed values are part of the schema hash, so the version gate below is what keeps the two builds apart |

`lintAdditiveEvolution()`, from `weftdb/codegen`, compares two schema definitions and reports every
non-additive change: a removed collection or field, a changed `type` or `merge`, a changed set of
enum values, and a field that went from nullable to required. No `weft` command runs it
automatically; an application wires it into its own build to enforce it.

The version gate is what makes any of this safe to roll out. Once a newer version has landed on a
scope, a device on the previous one cannot push or pull until it updates, so no two schema
versions ever write to the same scope at once.
