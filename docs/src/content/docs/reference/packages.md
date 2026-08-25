---
title: Packages
description: The published packages, the weftdb subpath exports, their environments, and the runtime dependencies.
sidebar:
  order: 4
---

weftdb publishes three packages: `weftdb`, the runtime; `weftdb-cli`, which provides the `weft`
command; and `weftdb-react`, React bindings for applications that use React. `demos/` holds two
further workspace packages that are not published.

## Published packages

| Package        | Provides                                        | Install                                                                                      |
| -------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `weftdb`       | Schema, client, server, relay, and codegen APIs | Every application built with weftdb                                                          |
| `weftdb-cli`   | The `weft` command                              | A project that generates artifacts, hashes a schema, or runs the relay from the command line |
| `weftdb-react` | React hooks over a `weftdb` client              | React applications only                                                                      |

The complete command surface is at [CLI reference](/reference/cli/).

## Dependencies

| Package        | Depends on                                          |
| -------------- | --------------------------------------------------- |
| `weftdb`       | `kysely` (`^0.29.5`)                                |
| `weftdb-cli`   | `weftdb` (workspace dependency)                     |
| `weftdb-react` | `weftdb`, `react` (`>=18.0.0`) as peer dependencies |

`weftdb` has no dependency on `weftdb-cli` or `weftdb-react`. Command-line and React concerns
stay outside the runtime package; the dependency runs from `weftdb-cli` and `weftdb-react` toward
`weftdb`, never the other way.

## Subpath exports

`weftdb`'s `package.json` declares one subpath per part of the runtime, so a build imports only
what it uses.

| Subpath                          | Provides                                                                                                                 | Environment      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `weftdb`                         | Re-exports `weftdb/shared`, `weftdb/schema`, and `weftdb/client`                                                         | Browser and Node |
| `weftdb/shared`                  | Branded ids, operation types, hybrid logical clocks (HLCs), diff3, fractional ranks, hashing, and the `SqlExecutor` port | Browser and Node |
| `weftdb/schema`                  | The schema DSL and schema hashing                                                                                        | Browser and Node |
| `weftdb/client`                  | `WeftClient`, sync transports, subscriptions, query keys, and a compile-only query builder built on `kysely`             | Browser and Node |
| `weftdb/client/sqlite`           | `SqliteClientStore`, a client store generic over a `SqlExecutor`                                                         | Browser and Node |
| `weftdb/client/wasm-sqlite`      | Executor helpers for a WebAssembly build of SQLite, opened from a dedicated worker                                       | Browser only     |
| `weftdb/server`                  | `WeftServer`, the in-memory schema-blind server                                                                          | Browser and Node |
| `weftdb/server/sqlite`           | `SqliteWeftServer`, the same server backed by a `SqlExecutor`                                                            | Browser and Node |
| `weftdb/server/node-sqlite`      | `openSqliteExecutor`, an executor built on `node:sqlite`                                                                 | Node only        |
| `weftdb/server/snapshot`         | `contentAddressSnapshot`, the snapshot serialisation format                                                              | Browser and Node |
| `weftdb/server/relay`            | `createRelayHandler` and the token verifiers it takes                                                                    | Browser and Node |
| `weftdb/server/serve`            | `main`, `startRelay`, and `serveOptionsFromEnv`: the Node HTTP relay run by `weft serve`                                 | Node only        |
| `weftdb/server/websocket`        | `SyncSocketHub`, the `/sync` connection registry                                                                         | Node only        |
| `weftdb/server/websocket-frames` | `decodeFrame` and `encodeFrame`, the WebSocket frame codec                                                               | Node only        |
| `weftdb/server/jwt`              | `jwtVerifier`, for the `--jwt-*` flags                                                                                   | Node only        |
| `weftdb/codegen`                 | `generateArtifacts`, generated SQL, types, mutators, and bindings                                                        | Browser and Node |

Five subpaths are Node-only: `weftdb/server/node-sqlite` imports `node:sqlite`,
`weftdb/server/serve` imports `node:http`, `weftdb/server/websocket` imports `node:crypto`,
`node:http`, and `node:stream`, and `weftdb/server/jwt` imports `node:crypto`.
`weftdb/server/websocket-frames` has no `node:*` import; it is Node-only because it builds frames
with the `Buffer` global, which Node provides and a browser does not.

`weftdb/client/wasm-sqlite` has no `node:*` import either, and no dependency on any WebAssembly
build of SQLite. It is browser-only because it opens a database in a dedicated worker against the
browser's origin-private storage, an API a browser provides and Node does not.

`weft serve`'s flags, environment variables, and limits are at
[Configuration reference](/reference/configuration/).

## SQLite

`weftdb` takes no runtime dependency on any SQLite build. `weftdb/server/node-sqlite` opens
`node:sqlite`, part of Node's standard library. `weftdb/client/wasm-sqlite` takes an
already-initialised `sqlite3` module from the caller: which WebAssembly build of SQLite ships,
and whether one ships at all, stays the application's choice.
