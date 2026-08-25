---
title: CLI reference
description: Every weft command, its flags, and what it writes.
sidebar:
  order: 2
---

`weft` is the command-line entry point installed by the `weftdb-cli` package. It provides seven
commands: `serve`, `generate`, `hash`, `server-ddl`, `doctor`, `rehydrate`, and `set-schema-hash`.
An unrecognised command prints a usage line naming all seven and exits 1.

## `serve`

Synopsis: `weft serve [flags]`.

Starts a relay. `weft serve` is the same entry point the container image runs; see
[Running the relay](/guides/running-the-relay/) for deployment and
[Authentication](/guides/authentication/) for the token and JWT model.

| Flag                             | Environment variable       | Default            | Meaning                                                                   |
| -------------------------------- | -------------------------- | ------------------ | ------------------------------------------------------------------------- |
| `--host <address>`               | `WEFT_HOST`                | `0.0.0.0`          | address to listen on                                                      |
| `--port <number>`                | `WEFT_PORT`                | `8787`             | port to listen on                                                         |
| `--db <path>`                    | `WEFT_DB`                  | unset              | SQLite file to persist into; unset means in-memory                        |
| `--tokens <entries>`             | `WEFT_TOKENS`              | none               | `token:scope_id:device_id` entries, comma-separated                       |
| `--tokens-file <path>`           | `WEFT_TOKENS_FILE`         | none               | same list, read from a file                                               |
| `--jwt-algorithms <list>`        | `WEFT_JWT_ALGORITHMS`      | none               | accepted algorithms, for example `RS256`                                  |
| `--jwt-secret <value>`           | `WEFT_JWT_SECRET`          | none               | shared secret, for `HS256`, `HS384`, or `HS512`                           |
| `--jwt-secret-file <path>`       | `WEFT_JWT_SECRET_FILE`     | none               | same secret, read from a file                                             |
| `--jwt-public-key <pem>`         | `WEFT_JWT_PUBLIC_KEY`      | none               | public key, for `RS256`, `RS384`, `RS512`, `ES256`, or `ES384`            |
| `--jwt-public-key-file <path>`   | `WEFT_JWT_PUBLIC_KEY_FILE` | none               | same key, read from a file                                                |
| `--jwt-issuer <value>`           | `WEFT_JWT_ISSUER`          | none               | required `iss` claim, if set                                              |
| `--jwt-audience <value>`         | `WEFT_JWT_AUDIENCE`        | none               | required `aud` claim, if set                                              |
| `--prune-interval-ms <number>`   | `WEFT_PRUNE_INTERVAL_MS`   | `86400000` (a day) | how often to prune tombstones across every scope; `0` turns the sweep off |
| `--prune-older-than-ms <number>` | `WEFT_PRUNE_OLDER_THAN_MS` | unset (30 days)    | tombstone age a scheduled prune removes                                   |

Every flag has an environment variable of the same name; a flag wins when both are set. Exactly
one of `--tokens`/`--tokens-file` or the `--jwt-*` pair is required: setting a token list together
with any `--jwt-*` flag is refused at startup, and setting neither is refused too.

`--help` or `-h` prints the flag list above and returns without starting a relay. On success, the
process writes `weft relay: listening on <url>, storage <path or memory (nothing is persisted)>`
to stdout and keeps running until `SIGINT` or `SIGTERM`. On a configuration error or a failure to
bind the port, it writes one line per error to stderr and sets the exit code to 1.

## `generate`

Synopsis: `weft generate --schema <path> [--out <path>]`.

Writes the derived artifact set for a schema. [Generating artifacts](/guides/generating-artifacts/)
lists every file it writes and what each one holds.

| Flag              | Required | Default          | Meaning                                                 |
| ----------------- | -------- | ---------------- | ------------------------------------------------------- |
| `--schema <path>` | yes      | none             | schema module or JSON file, see schema resolution below |
| `--out <path>`    | no       | `weft-generated` | directory the artifacts are written into                |

Creates `--out` (and any missing parent directories) if it does not exist. Writes ten files into
it and, for each one, prints `weft generate: <path>` to stdout. If the schema fails to load or
validate, writes one `weft generate: <error>` line per error to stderr instead and sets the exit
code to 1.

## `hash`

Synopsis: `weft hash --schema <path> [--out <path>]`.

Prints or writes a schema's hash on its own.

| Flag              | Required | Default | Meaning                                                 |
| ----------------- | -------- | ------- | ------------------------------------------------------- |
| `--schema <path>` | yes      | none    | schema module or JSON file, see schema resolution below |
| `--out <path>`    | no       | none    | file the hash is written to; omitted prints to stdout   |

The hash is followed by a newline either way. If the schema fails to load or validate, writes one
`weft hash: <error>` line per error to stderr and sets the exit code to 1.

## `server-ddl`

Synopsis: `weft server-ddl`.

Takes no flags and does not read a schema: the relay's field store is the same table for every
application. Prints the server DDL to stdout. Does not accept `--out`.

## `doctor`

Synopsis: `weft doctor [--schema <path>]`.

Validates a schema and reports on it.

| Flag              | Required | Default                                 | Meaning                    |
| ----------------- | -------- | --------------------------------------- | -------------------------- |
| `--schema <path>` | no       | discovered, see schema resolution below | schema module or JSON file |

Does not accept `--out`. When a schema is found and loads, prints these lines to stdout, in order:

- `weft doctor: schema <path>`
- `weft doctor: schema version <version>`
- `weft doctor: schema hash <hash>`
- `weft doctor: collections <count>`
- `weft doctor: client DDL <bytes> bytes`
- `weft doctor: server DDL <bytes> bytes`
- `weft doctor: warning: <collection>.<relationship> references missing table <table>`, one per
  relationship whose target collection is not in the schema
- `weft doctor: ok`

Sets the exit code to 0 in that case, warnings included. If no schema file is found or the schema
fails to load or validate, prints only the error lines (`weft doctor: no schema file found` and
`weft doctor: pass --schema schema.ts or create weft.schema.ts`, or one `weft doctor: <error>` line
per validation error) and sets the exit code to 1.

## `rehydrate`

Synopsis: `weft rehydrate --snapshot <path> [--out <path>]`.

Turns an exported snapshot into relational SQL. [Running the relay](/guides/running-the-relay/)
covers when to use it and what `GET /snapshot` returns.

| Flag                | Required | Default | Meaning                                                     |
| ------------------- | -------- | ------- | ----------------------------------------------------------- |
| `--snapshot <path>` | yes      | none    | newline-delimited JSON snapshot, as `GET /snapshot` returns |
| `--out <path>`      | no       | none    | file the SQL is written to; omitted prints to stdout        |

Writes one `INSERT` statement per row, columns in alphabetical order, preceded by a
`-- rehydrated from weft snapshot` comment line.

## `set-schema-hash`

Synopsis: `weft set-schema-hash --scope <id> --hash <value> --version <n> [--out <path>]`.

Writes an operator statement that records a [scope](/concepts/scopes/)'s schema hash and version
directly, without a device reporting them through a handshake.

| Flag             | Required | Default | Meaning                                              |
| ---------------- | -------- | ------- | ---------------------------------------------------- |
| `--scope <id>`   | yes      | none    | scope the row is upserted for                        |
| `--hash <value>` | yes      | none    | schema hash to record                                |
| `--version <n>`  | yes      | none    | schema version to record; must be a positive integer |
| `--out <path>`   | no       | none    | file the SQL is written to; omitted prints to stdout |

Writes an `INSERT INTO scope_state ... ON CONFLICT(scope_id) DO UPDATE` statement. Does not read a
schema; `--hash` and `--version` are taken as given, not computed.

## Schema resolution

`generate`, `hash`, and `doctor` all take `--schema`. `rehydrate`, `set-schema-hash`, and `serve`
do not read a schema at all.

A path ending in `.json` is parsed as JSON directly; the parsed value is the schema itself, not a
wrapper object. Any other path is imported as a module, and its exported schema is taken from, in
order: a `schema` named export, then a `default` export, then the first exported value shaped like
a schema (an object with a `collections` object and a numeric `schemaVersion`).

Either way, the resulting value is validated:

- `schemaVersion` is a positive integer.
- `collections` is an object.
- Each collection's `kind` is `collection` or `eventLog`.
- Each field's `type` is one of `string`, `number`, `boolean`, `json`, or `date`.
- Each field's `merge` is one of `lww`, `diff3`, `fracIndex`, or `immutable`.
- Each field's `nullable` is a boolean.
- No field name starts with the reserved `_weft_` prefix.

`generate` and `hash` require `--schema`; omitting it is an error. `doctor` accepts `--schema`, and
when it is omitted looks in the current directory, in this order, for the first file that exists:
`weft.schema.ts`, `schema.ts`, `weft.schema.json`, `schema.json`. This discovery fallback applies
only to `doctor`.

## Exit codes

| Code                  | Meaning                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0                     | the command completed without error                                                                                                                                                                         |
| 1                     | schema failed to load or validate (`generate`, `hash`, `doctor`); `doctor` found no schema file; the command name was not recognised; or `serve`'s configuration was invalid, or it could not bind its port |
| non-zero, unspecified | an error not handled by the command escaped as an uncaught exception: a required flag was missing, `--version` was not a positive integer, or `--snapshot` content was not valid JSON                       |

A CI job runs `weft doctor` and checks that it exits 0. To confirm committed artifacts still match
the schema, run `weft generate` again and diff its output against what is committed:
[Generating artifacts](/guides/generating-artifacts/) establishes that an unchanged schema produces
identical bytes, so any difference means the committed artifacts are stale.
