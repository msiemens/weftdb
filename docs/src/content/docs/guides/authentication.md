---
title: Authentication
description: Static tokens, JWT verification, and the limits of both.
sidebar:
  order: 8
---

A device authenticates to the relay with a bearer token. The token resolves to exactly one
[scope](/concepts/scopes/), the same `scope_id` a `WeftClient` is constructed with, and to one
device inside it. Authorisation is scope equality: an operation is permitted when the scope it
names matches the scope the token resolved to, and nothing else is checked.

## Resolving a bearer token

The relay reads the token from the `Authorization: Bearer <token>` header and passes it to a
`TokenVerifier`, an object with a `verify` method that returns an `AuthContext` or `undefined`.
`AuthContext` holds two fields, `scopeId` and `deviceId`, and every downstream call, handshake,
push, pull, or snapshot, receives this context rather than the request body. The scope an
operation acts on always comes from the context, never from anything a device sent in that
request. A request with no bearer token, or a token the verifier does not resolve, gets a 401
response.

A request is held inside its own scope at whichever point it enters. A handshake carries a `scope_id`
in its body, to match against a device's local state, and the relay answers 403 before the
handshake runs if that value differs from the context's `scopeId`. A push carries no scope in
its body at all: every operation in it names the scope it belongs to, and the relay rejects any
operation whose scope differs from the context's. That rejection travels back inside the ordinary
push response, not as an HTTP error status.

## Verifying against a static list

The default verifier is `staticTokenVerifier`, built from a fixed table of token to
`AuthContext`. `--tokens` (`WEFT_TOKENS`) lists entries as `token:scope_id:device_id`, separated
by commas, and `--tokens-file` (`WEFT_TOKENS_FILE`) reads the same list from a mounted file
instead of an environment variable. Either way, the table is read once, when the relay starts.

A static token has no expiry, no rotation, and no revocation. It authenticates until its entry is
removed from the list and the relay is restarted with the new one. That suits a single
self-hosted relay with a short, known list of devices. A deployment serving more than one scope
needs tokens that expire, which is what the verifier below checks for.

```sh
weft serve --tokens-file /run/secrets/weft-tokens --db weft.sqlite
```

## Verifying a signed token

`jwtVerifier`, from `weftdb/server/jwt`, checks a signed token against configuration the
deployment supplies, rather than trusting what the token claims about itself. `weft serve` wires
it up when `--jwt-algorithms` and either `--jwt-secret` or `--jwt-public-key` are set instead of
`--tokens`; setting a token list together with any `--jwt-*` flag is refused at startup.

| Flag                                         | Meaning                                                        |
| -------------------------------------------- | -------------------------------------------------------------- |
| `--jwt-algorithms`                           | Algorithms this deployment accepts, for example `RS256`        |
| `--jwt-secret` / `--jwt-secret-file`         | Shared secret, for `HS256`, `HS384`, or `HS512`                |
| `--jwt-public-key` / `--jwt-public-key-file` | Public key, for `RS256`, `RS384`, `RS512`, `ES256`, or `ES384` |
| `--jwt-issuer`                               | Required `iss` claim, if set                                   |
| `--jwt-audience`                             | Required `aud` claim, if set                                   |

A secret and a public key are never both set, and the algorithms named must match which one is
given: an `HS*` algorithm needs `--jwt-secret`, and `RS*` or `ES*` needs `--jwt-public-key`. The
verifier checks the signature, then `exp` and `nbf` against the current time with a tolerance (60
seconds by default), then `iss` and `aud` if those flags are set. It hands the verified claims to
`claimsToContext`, which reads a `scope` claim and a `device` claim, falling back to `sub` when
there is no `device` claim, and refuses the token if a scope or a usable device name is still
missing.

Two decisions hold the verifier to what the deployment configured, not to what a token asks for.
The accepted algorithms are the `--jwt-algorithms` list: a token whose header names anything
outside it, including `none` or an `HS*` algorithm where a public key is configured, is refused
before its signature is checked. Key discovery is the caller's: `keys` receives the token's
header and returns a key or `undefined`, and `undefined` is how an unknown `kid` is refused.
Fetching and caching a JWKS, where a deployment wants one, happens inside that callback.

```ts title="serve-with-jwt.ts"
import { jwtVerifier, claimsToContext } from "weftdb/server/jwt";

const verifier = jwtVerifier({
  keys: () => process.env.JWT_PUBLIC_KEY ?? "",
  algorithms: ["RS256"],
  context: claimsToContext,
  issuer: "https://auth.example.com",
  audience: "weftdb-relay",
});
```

## Running without TLS or rate limiting

The relay listens over plain HTTP and applies no rate limiting to any request, authenticated or
not. Neither verifier, nor the relay around them, limits how often a token can be tried or how
many connections one caller can open. Terminate TLS and add rate limiting in a proxy placed in
front of the relay for any deployment reachable from outside a trusted network.
[Running the relay](/guides/running-the-relay/) covers how the process itself is started and
deployed.

## Surviving session expiry

A token's expiry is a client concern, not a data-loss risk. The local outbox, the writes queued
but not yet acknowledged by the relay, is keyed by scope rather than by session, so it stays on
disk while a token is expired. Signing in again and obtaining a token for the same scope pushes
whatever was queued. Nothing about resolving a new token clears what was waiting.
