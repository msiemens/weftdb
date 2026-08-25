---
title: Running the relay
description: Starting a relay from source or as a container, its configuration, persistence, and what it does with each request.
sidebar:
  order: 7
---

A relay reaches the same code by two paths: the `weft serve` command used in the
[Quick start](/quick-start/), and the bundled file a container runs. Both call `main` from
`weftdb/server/serve`, so a flag on the command line and its equivalent environment variable
configure either path identically.

## Starting a relay

`weft serve` is the CLI's `serve` command: it imports `main` only when invoked, and passes it the
process environment together with its own arguments. Running the bundled file reaches the same
`main` without the CLI in between.

`pnpm build:server` runs a Vite build, configured in `vite.config.ts`, that bundles
`server/main.ts` and the workspace packages it imports into `dist/server.mjs`, one ECMAScript
module with only Node's own builtins left external. The SQLite executor stays a separate chunk in
the same output, loaded only when `--db` names a file, so a deployment that runs in memory never
loads it. This is why the runtime image carries no package manager, no `node_modules`, and no
source tree: `dist` holds only what a relay needs to run.

```sh
pnpm build:server
```

Running the bundle directly takes the same settings as environment variables, plus one flag of its
own: `node:sqlite` sits behind an experimental flag on Node 22.

```sh
$ WEFT_TOKENS=laptop-token:user-1:laptop WEFT_DB=weft.sqlite \
    node --experimental-sqlite dist/server.mjs

weft relay: listening on http://127.0.0.1:8787, storage weft.sqlite
```

## Building the container image

The image builds in two stages, both defined in the repository's `Dockerfile`. The first, on
`node:22-bookworm-slim`, installs the workspace with
`pnpm install --frozen-lockfile --ignore-scripts` and runs `pnpm build:server`. The second copies
only `dist` onto
`gcr.io/distroless/nodejs22-debian12:nonroot`, a base with no shell, and runs as the `nonroot`
user rather than root. Its default command is `node --experimental-sqlite /app/server.mjs`.

| Setting      | Value               |
| ------------ | ------------------- |
| `WEFT_HOST`  | `0.0.0.0`           |
| `WEFT_PORT`  | `8787`              |
| `WEFT_DB`    | `/data/weft.sqlite` |
| Volume       | `/data`             |
| Exposed port | `8787`              |

```sh
docker build -t weftdb-relay .
```

## Persisting data

Outside a container, `--db` (or `WEFT_DB`) is optional and unset by default: a relay holds
everything in memory and forgets it when the process exits. The image sets
`WEFT_DB=/data/weft.sqlite` so it persists by default instead, which is why a deployment mounts a
volume at `/data`. Losing that state on restart costs more than the data: a relay with nothing to
compare against sends every device a full copy of its data instead of catching it up
incrementally, and any change a device made but had not yet pushed is gone.

Setting `WEFT_DB` to an empty string overrides the image's default and runs entirely in memory:

```sh
$ docker run -p 8787:8787 -e WEFT_DB= \
    -e WEFT_TOKENS=laptop-token:user-1:laptop,phone-token:user-1:phone \
    ghcr.io/msiemens/weftdb-relay:latest

weft relay: listening on http://127.0.0.1:8787, storage memory (nothing is persisted)
```

## Configuring flags and environment

Every flag `weft serve --help` lists has an environment variable of the same name, and when both
are set the flag wins. This is how the container image is configured: its command line is fixed
by the `Dockerfile`'s `CMD`, so environment variables are the only setting it can receive.

| Flag                    | Environment variable       |
| ----------------------- | -------------------------- |
| `--host`                | `WEFT_HOST`                |
| `--port`                | `WEFT_PORT`                |
| `--db`                  | `WEFT_DB`                  |
| `--tokens`              | `WEFT_TOKENS`              |
| `--tokens-file`         | `WEFT_TOKENS_FILE`         |
| `--jwt-algorithms`      | `WEFT_JWT_ALGORITHMS`      |
| `--jwt-secret`          | `WEFT_JWT_SECRET`          |
| `--jwt-secret-file`     | `WEFT_JWT_SECRET_FILE`     |
| `--jwt-public-key`      | `WEFT_JWT_PUBLIC_KEY`      |
| `--jwt-public-key-file` | `WEFT_JWT_PUBLIC_KEY_FILE` |
| `--jwt-issuer`          | `WEFT_JWT_ISSUER`          |
| `--jwt-audience`        | `WEFT_JWT_AUDIENCE`        |

`--host` defaults to `0.0.0.0` and `--port` to `8787`. `--tokens` (or `--tokens-file`, read from a
mounted path) lists bearer tokens directly; the `--jwt-*` flags verify signed tokens instead, and
`--jwt-secret-file` and `--jwt-public-key-file` read those from a mounted path too, the way Docker
and Kubernetes secrets arrive. Setting both a token list and any `--jwt-*` flag is refused, and
setting neither is refused: a relay with no way to authenticate a request refuses to start rather
than come up and reject every one.

## Answering health checks

`GET /health` answers before authentication runs: the request listener checks the path first and
returns `{"ok": true}` with a 200 status, so a probe needs no token. This is the endpoint the
image's `HEALTHCHECK` instruction polls every 30 seconds, with a 3-second timeout, a 2-second
start period, and 3 retries before Docker marks the container unhealthy.

## Capping the request body

A push is JSON, decoded into memory, so an unbounded body is an unbounded allocation. The relay
checks the `content-length` header first and refuses anything already declared over 8 MiB; for a
request with no declared length, it counts bytes as they arrive and refuses once the running total
passes the same limit, before the body is ever fully buffered. Either way the response is 413,
with a JSON body naming `payload_too_large`.

## Handling requests

Over HTTP, four routes carry the whole protocol: `POST /handshake`, `POST /push`, `GET /pull`, and
`GET /snapshot`. A WebSocket upgrade at `/sync` carries the same four operations for a device that
stays connected, which [syncing over a WebSocket](/guides/sync-over-websocket/) covers in full.
Every request but `/health` reduces to the same work, regardless of which surface it arrived on:

- Authenticates the caller, against a token list or a verified JWT
  ([Authentication](/guides/authentication/)).
- Checks that the request's `scope_id` matches the authenticated caller's own
  ([Scopes](/concepts/scopes/)).
- Checks each write's clock reading for skew ([Clocks](/concepts/clocks/)).
- Applies the merge that decides which of two conflicting writes wins
  ([Merge model](/concepts/merge-model/)).
- Serves the field ranges a handshake, pull, or snapshot asks for
  ([The sync protocol](/concepts/sync-protocol/)).

None of this requires knowing an application's tables: values are opaque to the relay, which is
also why adding a field never needs a server migration. [Architecture](/concepts/architecture/)
covers why the relay holds one generic table rather than a copy of an application's schema.

## Importing subpath exports

A deployment that only runs the relay needs a fraction of the package. `weftdb`'s `package.json`
declares each part of the server as its own subpath, so a build imports only what it executes:

| Subpath                     | Provides                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `weftdb/server`             | The in-memory `WeftServer`, used when no `--db` is set                                          |
| `weftdb/server/sqlite`      | `SqliteWeftServer`, the same server backed by a SQL executor                                    |
| `weftdb/server/node-sqlite` | `openSqliteExecutor`, the executor built on Node's `node:sqlite`                                |
| `weftdb/server/relay`       | `createRelayHandler` and the token verifiers it takes                                           |
| `weftdb/server/serve`       | `main`, `startRelay`, and `serveOptionsFromEnv`, called by `weft serve` and the container alike |
| `weftdb/server/websocket`   | `SyncSocketHub`, the `/sync` connection registry                                                |
| `weftdb/server/jwt`         | `jwtVerifier`, for the `--jwt-*` flags                                                          |
| `weftdb/server/snapshot`    | `contentAddressSnapshot`, the newline-delimited JSON format `GET /snapshot` returns             |

## Running as one process

A device that opens the `/sync` socket is pinned to the process holding that connection: only the
process that accepted it can push the scope's advances down it, so wake-ups for that device stop
if the connection moves. Running several relay processes against shared storage would need a way
for an advance seen by one process to reach a device connected to another, which does not exist.
HTTP has no such constraint: a request to `/handshake`, `/push`, `/pull`, or `/snapshot` is
complete in itself and can land on any process with access to the same storage.

## Backing up and inspecting data

Backing up a relay that persists is copying one file, whatever `--db` or `WEFT_DB` names: the
relay's whole state lives in one generic table, the same one for every application.

That table is not meant to be read directly. `weft rehydrate` turns an exported snapshot back into
relational SQL a person can read: `GET /snapshot` returns one as newline-delimited JSON, and
`weft rehydrate --snapshot <path> --out <path>` writes an `INSERT` statement per row, with its
columns in alphabetical order. It reads only the field values a snapshot carries, not deletion or
liveness state, so the result is a readable copy, not a working replacement for the database.
