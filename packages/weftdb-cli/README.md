# weftdb-cli

Command-line tools for WeftDB.

## Commands

```sh
weft serve
weft generate --schema src/schema.ts --out src/generated
weft hash --schema src/schema.ts
weft server-ddl
weft doctor --schema src/schema.ts
weft rehydrate --snapshot snapshot.ndjson --out rehydrated.sql
weft set-schema-hash --scope user-1 --hash abc123 --version 4 --out set-schema.sql
```

`serve` runs the relay, and is the same entry point the container image runs. Its flags are
`--host`, `--port`, `--db`, the authentication pair `--tokens` / `--tokens-file`, and the
`--jwt-*` set that verifies signed tokens instead of listing them; `weft serve --help` prints all
of them. Every flag has an environment variable of the same name, which is what the container is
configured with, and a flag wins over the environment.

It is the one command here that does not transform a schema, so the server is imported only when
it is asked for: `weft generate` in a build step never loads the socket stack or the SQLite
binding.

## Schema Modules

```ts
import { defineSchema, S } from "weftdb/schema";

export const schema = defineSchema({
  tasks: S.collection({
    title: S.string(),
  }),
});
```

`--schema` accepts a TypeScript module or JSON schema file. TypeScript modules may export
the schema as `schema`, as the default export, or as the only schema-shaped export.

## Generated Files

`weft generate` writes:

- `client.sql`
- `server.sql`
- `database.d.ts`
- `internal-database.d.ts`
- `kysely.d.ts`
- `mutators.ts`
- `bindings.ts`
- `relationships.ts`
- `nested-mappers.ts`
- `schema-hash.txt`

## Hash

```sh
weft hash --schema src/schema.ts
```

## Doctor

```sh
weft doctor --schema src/schema.ts
```

Checks schema shape, reserved field names, field definitions, relationship references,
artifact generation, and schema hash generation.

## Operator SQL

```sh
weft rehydrate --snapshot snapshot.ndjson --out rehydrated.sql
weft set-schema-hash --scope user-1 --hash abc123 --version 4 --out set-schema.sql
```
