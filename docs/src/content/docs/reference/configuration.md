---
title: Configuration
description: Environment variables, embeddable options objects, and the limits weftdb compiles in for the relay and the client.
sidebar:
  order: 3
---

The relay reads its configuration from environment variables, with no config file.
`startRelay`, `createRelayHandler`, `SyncSocketHub`, and the client transports also accept
options objects directly, for an application that embeds weftdb rather than running the bundled
relay. A further set of numbers is compiled into weftdb and has no configuration surface at all.
[CLI reference](/reference/cli/) covers the command-line flags, each of which sets one of the
environment variables below.

## Environment variables

A relay needs exactly one way to authenticate a request: either a token list, `WEFT_TOKENS` or
`WEFT_TOKENS_FILE`, or JSON Web Token (JWT) verification, `WEFT_JWT_ALGORITHMS` plus either
`WEFT_JWT_SECRET`/`WEFT_JWT_SECRET_FILE` or `WEFT_JWT_PUBLIC_KEY`/`WEFT_JWT_PUBLIC_KEY_FILE`.
Setting both a token list and any `WEFT_JWT_*` variable is refused at startup, and setting
neither is refused too.

| Variable                   | Default                           | Meaning                                                                                                                              |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `WEFT_HOST`                | `0.0.0.0`                         | interface the relay binds to                                                                                                         |
| `WEFT_PORT`                | `8787`                            | port the relay binds to, `0` to `65535`                                                                                              |
| `WEFT_DB`                  | unset (in-memory)                 | SQLite file to persist into; unset or empty runs entirely in memory                                                                  |
| `WEFT_TOKENS`              | required unless JWT is configured | `token:scope_id:device_id` entries, separated by commas                                                                              |
| `WEFT_TOKENS_FILE`         | unset                             | path to read `WEFT_TOKENS` from; entries in the file may be separated by any whitespace, which is converted to commas before parsing |
| `WEFT_JWT_ALGORITHMS`      | unset                             | comma-separated algorithms this deployment accepts, required when a JWT key is set                                                   |
| `WEFT_JWT_SECRET`          | unset                             | shared secret, for `HS256`, `HS384`, or `HS512`                                                                                      |
| `WEFT_JWT_SECRET_FILE`     | unset                             | path to read `WEFT_JWT_SECRET` from                                                                                                  |
| `WEFT_JWT_PUBLIC_KEY`      | unset                             | public key, for `RS256`, `RS384`, `RS512`, `ES256`, or `ES384`                                                                       |
| `WEFT_JWT_PUBLIC_KEY_FILE` | unset                             | path to read `WEFT_JWT_PUBLIC_KEY` from                                                                                              |
| `WEFT_JWT_ISSUER`          | unset                             | required `iss` claim, if set                                                                                                         |
| `WEFT_JWT_AUDIENCE`        | unset                             | required `aud` claim, if set                                                                                                         |
| `WEFT_PRUNE_INTERVAL_MS`   | `86400000` (a day)                | how often to prune tombstones across every scope; `0` turns the sweep off                                                            |
| `WEFT_PRUNE_OLDER_THAN_MS` | unset (30 days)                   | passed to `pruneTombstones` on each scheduled sweep                                                                                  |
| `WEFT_SKEW_THRESHOLD_MS`   | `300000` (5 minutes)              | how far ahead of the relay's clock a write may be stamped before it is refused                                                       |

Setting `WEFT_TOKENS` directly accepts only comma-separated entries; only `WEFT_TOKENS_FILE`
converts whitespace, including newlines, to commas.

The container image built from the repository's `Dockerfile` sets `WEFT_HOST=0.0.0.0`,
`WEFT_PORT=8787`, and `WEFT_DB=/data/weft.sqlite`. The first two match the defaults above;
`WEFT_DB` does not, so a container persists to `/data/weft.sqlite` by default instead of running
in memory. Set `WEFT_DB=` (empty) to run a container entirely in memory. `WEFT_TOKENS` has no
default in either the library or the image, so a relay refuses to start without it or without a
JWT configuration.

## Relay options

### Startup options

`startRelay`, from `weftdb/server/serve`, takes a `ServeOptions` object.

| Field              | Type                               | Default                       | Meaning                                                                        |
| ------------------ | ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| `host`             | `string`                           | none, required                | interface to bind to                                                           |
| `port`             | `number`                           | none, required                | port to bind to                                                                |
| `databasePath`     | `string`                           | undefined (in-memory)         | SQLite file to persist into                                                    |
| `tokens`           | `ReadonlyMap<string, AuthContext>` | none, required                | the static token table, used unless `verifier` is set                          |
| `verifier`         | `TokenVerifier`                    | `staticTokenVerifier(tokens)` | replaces the static token table, for example with `jwtVerifier(...)`           |
| `keepaliveMs`      | `number`                           | 30 seconds                    | how often the sync socket pings; `0` turns the keepalive off                   |
| `pruneIntervalMs`  | `number`                           | `86400000` (a day)            | how often to prune tombstones across every scope; `0` turns the sweep off      |
| `pruneOlderThanMs` | `number`                           | unset (30 days)               | passed to `pruneTombstones` on each scheduled sweep                            |
| `skewThresholdMs`  | `number`                           | 5 minutes                     | how far ahead of the relay's clock a write may be stamped before it is refused |

### Relay handler options

`createRelayHandler` and `syncOperations`, from `weftdb/server/relay`, take a `RelayOptions`
object.

| Field        | Type                                            | Default        | Meaning                                       |
| ------------ | ----------------------------------------------- | -------------- | --------------------------------------------- |
| `server`     | `WeftServer`                                    | none, required | the `WeftServer` instance to read and write   |
| `verifier`   | `TokenVerifier`                                 | none, required | resolves a bearer token to a scope and device |
| `onAdvanced` | `(scopeId: ScopeId, serverSeq: number) => void` | unset          | called after a push moves the scope forward   |

### Sync socket options

`SyncSocketHub`, from `weftdb/server/websocket`, takes a `SyncSocketOptions` object.

| Field         | Type                                                | Default        | Meaning                                                                                             |
| ------------- | --------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `verifier`    | `TokenVerifier`                                     | none, required | resolves a bearer token to a scope and device                                                       |
| `operations`  | `SyncOperations`                                    | unset          | the protocol's four calls; without them the socket only carries wake-ups                            |
| `pull`        | `(scopeId, lastServerSeq) => { serverSeq: number }` | unset          | reads what a scope has beyond a cursor; without it a subscriber is only told that something changed |
| `keepaliveMs` | `number`                                            | 30 seconds     | how often to ping; `0` or less turns the keepalive off                                              |

### WeftServer settings

`WeftServer`, from `weftdb/server`, takes two constructor parameters and one method parameter.

| Setting                                                  | Type           | Default    | Configurable                                                                   |
| -------------------------------------------------------- | -------------- | ---------- | ------------------------------------------------------------------------------ |
| `now` (constructor parameter)                            | `() => number` | `Date.now` | passed to `new WeftServer(now)`; not reachable through `startRelay`            |
| `skewThresholdMs` (constructor parameter)                | `number`       | 5 minutes  | `new WeftServer(now, skewThresholdMs)`, or `skewThresholdMs` on `ServeOptions` |
| `olderThanMs` in `pruneTombstones(scopeId, olderThanMs)` | `number`       | 30 days    | method parameter; `startRelay` supplies it from `pruneOlderThanMs`             |

`startRelay` calls `pruneTombstones` on a schedule, covering every scope the server knows about. A
deployment that embeds `WeftServer` directly rather than through `startRelay` gets no schedule and
calls `pruneTombstones` itself.

### JWT verifier options

`jwtVerifier`, from `weftdb/server/jwt`, takes a `JwtVerifierOptions` object.

| Field                   | Type                                                                | Default        | Meaning                                                                                        |
| ----------------------- | ------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `keys`                  | `(header: JwtHeader) => KeyObject \| string \| Buffer \| undefined` | none, required | resolves the key for a token's header; returning `undefined` refuses the token                 |
| `algorithms`            | `readonly JwtAlgorithm[]`                                           | none, required | accepted algorithms: `HS256`, `HS384`, `HS512`, `RS256`, `RS384`, `RS512`, `ES256`, or `ES384` |
| `context`               | `(claims: JwtClaims) => AuthContext \| undefined`                   | none, required | resolves the scope and device the verified claims name                                         |
| `issuer`                | `string`                                                            | unset          | required `iss` claim, if set                                                                   |
| `audience`              | `string`                                                            | unset          | required `aud` claim, if set                                                                   |
| `clockToleranceSeconds` | `number`                                                            | 60 seconds     | tolerance for `exp` and `nbf` against the current time                                         |
| `now`                   | `() => number`                                                      | `Date.now`     | clock the verifier checks `exp` and `nbf` against                                              |

## Client options

### HTTP transport options

`httpTransport`, from `weftdb/client`, takes an `HttpTransportOptions` object.

| Field     | Type        | Default            | Meaning                                                              |
| --------- | ----------- | ------------------ | -------------------------------------------------------------------- |
| `baseUrl` | `string`    | none, required     | where the relay is mounted, for example `/api` or an absolute origin |
| `token`   | `string`    | none, required     | bearer token; the relay derives the scope and device from it         |
| `fetch`   | `FetchLike` | `globalThis.fetch` | fetch implementation to use                                          |

### Socket transport options

`connectSocketTransport`, from `weftdb/client`, takes a `SocketTransportOptions` object. It
carries whole sync sessions over the socket, so it replaces `httpTransport` rather than
supplementing it.

| Field            | Type                                             | Default                            | Meaning                                                                            |
| ---------------- | ------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------- |
| `url`            | `string`                                         | none, required                     | where the sync socket is mounted                                                   |
| `token`          | `string`                                         | none, required                     | bearer token, sent as a WebSocket subprotocol                                      |
| `onWake`         | `(advanced: ScopeAdvanced \| undefined) => void` | unset                              | called when the relay says the scope moved, and on every reconnect                 |
| `onBatch`        | `(batch: PullBatch) => void`                     | unset                              | called with a batch the relay sent unasked, once subscribed                        |
| `cursor`         | `() => number`                                   | unset                              | where this client has got to; given one, the transport subscribes on every connect |
| `onStatusChange` | `(connected: boolean) => void`                   | unset                              | called when the socket connects or disconnects                                     |
| `WebSocket`      | `WebSocketFactory`                               | the global `WebSocket` constructor | factory used to open the socket                                                    |
| `timeoutMs`      | `number`                                         | 15 seconds                         | how long a request waits before the connection is treated as gone quiet            |

Given `onBatch` and `cursor`, the connection subscribes and the relay sends what changed. Given
neither, it calls `onWake` on every connect and whenever the relay says the scope moved, and the
device syncs for itself over the transport and the timer it already runs.

## Fixed limits

These numbers are compiled into weftdb. None of them has an environment variable, an option, or
a flag.

| Limit                     | Value            | Applies to                                                                                              |
| ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| Request body cap          | `8 MiB`          | HTTP request bodies; over the limit, the relay returns `413` with `payload_too_large`                   |
| WebSocket frame cap       | `8 MiB`          | the payload of one raw WebSocket frame; a larger one is refused on read and cannot be produced on write |
| Socket chunk size         | `32KB`           | size of each piece when an answer or an unsolicited batch is split across several socket messages       |
| Reconnect backoff floor   | 500 milliseconds | first retry delay after a client socket disconnects, in `connectSocketTransport`                        |
| Reconnect backoff ceiling | 30 seconds       | the retry delay doubles on each attempt and stops growing here                                          |

The suite reads a further set of variables that tune its own run counts and seeds. None of them
configures the library, and none has a relay or client option; they are documented in `TESTING.md`
alongside the suites they belong to.
