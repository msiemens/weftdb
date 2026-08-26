---
title: Generating artifacts
description: What weft generate writes, when to re-run it, and how to use the artifacts programmatically.
sidebar:
  order: 2
---

A schema is a TypeScript value: a description of collections and fields that nothing has acted on
yet. `weft generate` reads it and writes a set of artifacts, the files it derives from the schema.
A device and the relay, the server devices sync through, run as separate processes and need
something to compare without running each other's TypeScript. Some of what a schema implies is
written to disk for that reason. The rest is expressed as ordinary types, applied to those files
rather than generated again for every query.

## Splitting artifacts from inferred types

A `CREATE TABLE` statement is not a type, and SQLite has nothing else to execute, so the client's
own database needs literal SQL on disk. The schema hash needs to exist as a plain string for the
same reason: a device and the relay each read it without running the other's TypeScript.

Query result shapes do not need a second round of generation. `bindings.ts` types a query's result
and a decoded row using `TypedQueryKey` and `MaterializedRow`, two generic types from
`weftdb/client`, applied to the `Database` interface `weft generate` already wrote. Adding a query
does not add a file: the generic types cover it once, against the shape of the row, not once per
query.

## Writing the artifact set

```sh
weft generate --schema src/schema.ts --out src/generated
```

Three of the tables `client.sql` creates support sync rather than any one collection:

- The outbox holds writes not yet pushed to the relay.
- The quarantine holds writes the relay rejected.
- Tombstones record a deletion.

`sync_state` records a scope's own progress: the last sequence it pulled, the highest clock reading
it has written, and whether it needs a snapshot resync. The command above writes:

| Artifact            | What it holds                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.sql`        | domain columns per collection, `_weft_hlc_<field>` and `_weft_base_<field>` sidecar columns, and the `outbox`, `outbox_quarantine`, `tombstones`, and `sync_state` tables                                       |
| `server.sql`        | a `fields` table keyed on `scope_id`, `table_name`, `row_id`, and `field`, plus `rows`, `scope_state`, and `devices`, the same regardless of schema                                                             |
| `database.d.ts`     | the `Database` interface, one row shape per collection, domain columns only                                                                                                                                     |
| `mutators.ts`       | a `<Name>Mutation` input interface and a `<Name>Mutators` interface per collection                                                                                                                              |
| `bindings.ts`       | table name constants, row and field types, query builders, decoders, a `<name>Mutators(client)` factory per collection, a `use<Name>` React hook, and reorder helpers for a collection with a `fracIndex` field |
| `relationships.ts`  | a `<table>_<relationship>Relation(targets)` accessor, which indexes the target rows and returns a lookup over that index, and a `<Table><Relationship>Result` type, per relationship the schema declares        |
| `nested-mappers.ts` | a `map<Name>Row()` function that reassembles `__`-separated columns into a nested object, per collection that has any                                                                                           |
| `schema-hash.txt`   | the schema hash, as plain text                                                                                                                                                                                  |

`client.sql` and `server.sql` both open with a comment naming the schema version and the hash they
were generated from, so the two files a device and the relay load carry their own provenance.

## Placing and committing the output

`--out` names the directory `weft generate` writes into. Every example writes it to
`src/generated`, beside the schema; omitting `--out` writes into `weft-generated` in the current
directory instead.

Commit the artifacts, in the same commit as the schema edit that produced them. The todo list demo
does this. Its build reads `src/generated` directly, so building the page never runs the generator.
A schema edit's effect on generated code then shows up as an ordinary diff in the review that
changed the schema. An artifact produced only at build time hides that diff instead.

## Regenerating after a schema edit

Run `weft generate` again after every edit to the schema; nothing rebuilds it automatically. A
device computes its own schema hash from the schema module it was built with. The relay records
the hash and version reported by the first device it saw for a given scope, and it advances that
record only when a later device reports a higher version.

A device whose schema falls behind that record gets a mismatch on its next handshake.
`WeftClient.syncWith` then returns without pushing or pulling anything, and neither side's data
changes. [Schema changes](/guides/schema-changes/) covers every handshake outcome and the order in
which a schema change should reach devices and the relay.

## Calling the generator programmatically

The `generate` command calls `generateArtifacts` and `generateServerDdl` from `weftdb/codegen`,
then writes their return values to the files named above. Both are available directly:

```ts
import { generateArtifacts, generateServerDdl } from "weftdb/codegen";
import { schema } from "./src/schema.ts";

const artifacts = generateArtifacts(schema);
console.log(artifacts.schemaHash); // what schema-hash.txt holds
console.log(artifacts.clientDdl); // most of what client.sql holds
console.log(generateServerDdl()); // what server.sql holds; takes no schema argument
```

`generateArtifacts` returns `schemaHash`, `clientDdl`, `databaseDts`, `mutatorsTs`, `bindingsTs`,
`relationshipsTs`, and `nestedMappersTs`, one string property per artifact in the table above.
`generateServerDdl` takes no schema, because the table it describes does not depend on one.

## Diffing regenerated output

`weft generate` writes only what it derives from the schema object: no timestamp and no random
value enters an artifact. (`bindings.ts` contains the text `crypto.randomUUID()`, but that call
belongs to the mutator function the artifact defines, and runs later, when a row is created; the
generator itself never calls it.) Running the command twice on an unchanged schema writes the same
bytes both times, so a diff after regenerating shows only what the schema edit changed.
