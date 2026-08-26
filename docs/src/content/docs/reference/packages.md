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

| Subpath                          | Provides                                                                                                   | Environment      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| `weftdb`                         | Re-exports `weftdb/core`, `weftdb/shared`, `weftdb/schema`, and `weftdb/client`                            | Browser and Node |
| `weftdb/core`                    | Branded ids, operation types, hybrid logical clocks (HLCs), diff3, and fractional ranks                    | Browser and Node |
| `weftdb/shared`                  | Hashing, the wire-value codec, and the `SqlExecutor` and `AsyncSqlExecutor` ports                          | Browser and Node |
| `weftdb/schema`                  | The schema DSL and schema hashing                                                                          | Browser and Node |
| `weftdb/client`                  | `WeftClient`, `openWeftDatabase`, sync transports, subscriptions, query keys, and a `kysely` query builder | Browser and Node |
| `weftdb/client/sqlite`           | `SqliteClientStore`, a client store generic over an `AsyncSqlExecutor`                                     | Browser and Node |
| `weftdb/client/wasm-sqlite`      | `openWebSqliteExecutor` and `waSqliteExecutor`, SQLite compiled to WebAssembly as an `AsyncSqlExecutor`    | Browser only     |
| `weftdb/client/worker-entry`     | `serveWeftStorageWorker`, the storage worker an application's `SharedWorker` module is                     | Browser only     |
| `weftdb/client/worker-host`      | `serveWeftWorker`, the protocol host that owns one database's client                                       | Browser and Node |
| `weftdb/server`                  | `WeftServer`, the in-memory schema-blind server                                                            | Browser and Node |
| `weftdb/server/sqlite`           | `SqliteWeftServer`, the same server backed by a `SqlExecutor`                                              | Browser and Node |
| `weftdb/server/node-sqlite`      | `openSqliteExecutor`, an executor built on `node:sqlite`                                                   | Node only        |
| `weftdb/server/snapshot`         | `contentAddressSnapshot`, the snapshot serialisation format                                                | Browser and Node |
| `weftdb/server/relay`            | `createRelayHandler` and the token verifiers it takes                                                      | Browser and Node |
| `weftdb/server/serve`            | `main`, `startRelay`, and `serveOptionsFromEnv`: the Node HTTP relay run by `weft serve`                   | Node only        |
| `weftdb/server/websocket`        | `SyncSocketHub`, the `/sync` connection registry                                                           | Node only        |
| `weftdb/server/websocket-frames` | `decodeFrame` and `encodeFrame`, the WebSocket frame codec                                                 | Node only        |
| `weftdb/server/jwt`              | `jwtVerifier`, for the `--jwt-*` flags                                                                     | Node only        |
| `weftdb/codegen`                 | `generateArtifacts`, generated SQL, types, mutators, and bindings                                          | Browser and Node |

Five subpaths are Node-only: `weftdb/server/node-sqlite` imports `node:sqlite`,
`weftdb/server/serve` imports `node:http`, `weftdb/server/websocket` imports `node:crypto`,
`node:http`, and `node:stream`, and `weftdb/server/jwt` imports `node:crypto`.
`weftdb/server/websocket-frames` has no `node:*` import; it is Node-only because it builds frames
with the `Buffer` global, which Node provides and a browser does not.

`weftdb/client/wasm-sqlite` has no `node:*` import either, and no dependency on any WebAssembly
build of SQLite. The caller passes in an initialised wa-sqlite API, the module it was built over,
and a function that builds the VFS to store in. It is browser-only because that VFS stores in
IndexedDB, and `weftdb/client/worker-entry` is browser-only because it opens a database through it
and serves that database to a `SharedWorker`'s ports.

`weft serve`'s flags, environment variables, and limits are at
[Configuration reference](/reference/configuration/).

## SQLite

`weftdb` takes no runtime dependency on any SQLite build. `weftdb/server/node-sqlite` opens
`node:sqlite`, part of Node's standard library. `weftdb/client/wasm-sqlite` takes a `WaSqliteBuild`
from the caller: the initialised API, the module it was built over, and the VFS its databases live
in. Which WebAssembly build of SQLite ships, and which VFS stores it, stays the application's
choice. [Storage on the device](/guides/device-storage/) covers the build the demos ship.
