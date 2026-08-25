---
title: Scopes
description: What a scope is, how authorization reduces to one equality check, and the room left for multi-user.
sidebar:
  order: 6
---

A scope is the unit of sync and the unit of authorization. Every row a device creates carries a
`scope_id`, written once at creation and never changed afterward, and every relay operation,
handshake, push, pull, or snapshot, acts on exactly one scope.
[Architecture](/concepts/architecture/) covers how the relay's field store is keyed by `scope_id`
together with table name and row id, so a scope's data is reachable by one indexed query and never
requires a join across scopes. Because every row already names its scope, deciding whether an
operation belongs there is a single equality comparison between the scope named on the operation
and the scope a bearer token resolved to. A scope corresponds to one user, and one relay
deployment holds many scopes side by side, each isolated from the others by that comparison alone.

## The `scope_id` field name

An `owner_id` column commits to a single owner per row. `scope_id` names a bucket that sync and
authorization both key on, without saying how many identities can act inside it. A membership
table added later, where more than one identity reaches into the same scope, would join against
the `scope_id` column that already exists on every row, so introducing it needs no migration of
rows already stored. A scope has no members: it resolves to the one identity a token names.

## Where the scope is enforced

[Authentication](/guides/authentication/) covers how a bearer token resolves to a `scopeId` and
`deviceId`. That resolved `scopeId` is what the relay's scope checks compare against. A handshake
and a push are checked differently, and report failure differently.

A handshake carries a `scope_id` in its request body. The relay compares it against the token's
resolved scope before running the handshake, and answers with an HTTP 403 if the two differ. A
push carries no scope in its body at all: every operation inside it names its own scope, and the
relay checks each one individually while validating its transaction. An operation whose scope
differs from the token's is rejected with reason `scope_mismatch`, and that rejection travels back
inside an ordinarily successful push response rather than as an HTTP error status: the response
still carries status 200, with the rejection recorded in the outcome body alongside acknowledgments
for whatever else in the same push was already valid.
[The sync protocol](/concepts/sync-protocol/) covers how a push groups operations into
transactions and applies each in turn.

```ts
import { scopeId } from "weftdb/core";

// a set op inside a push names its own scope; the relay checks it against the
// token's scope on every operation in the push, not once for the whole request
const foreign = scopeId("someone-elses-scope");
```

A handshake's `scope_id` is a value the caller chose to send, so refusing the request outright
costs nothing. A push's operations are the write itself, grouped into transactions with partial
success, so a scope mismatch is reported the same way any other per-operation rejection is: one
entry in a response that also carries acknowledgments for everything validated ahead of it.

## Row id reuse across scopes

A `RowId` is unique within a scope, not globally. Two different scopes can create a row under the
identical id without conflict, because a stored record is addressed by `scope_id`, table name, and
row id together, never by row id alone.

Create a row under the same `RowId` in two separate scopes, each with a different title, and each
scope's snapshot holds exactly one row under that id, carrying the title that scope wrote and never
the other scope's value. A row id shared between two scopes changes nothing about either scope's
stored data. An operation whose `scopeId` differs from the scope it targets is rejected with reason
`scope_mismatch`, and `scope_id` itself cannot be overwritten on a row that already exists —
rejected with `base_field_violation`.

## Scopes, devices, and tokens

A `WeftClient` is constructed for one scope, passed as its first constructor argument, and that
scope never changes for the client's lifetime. Every row and queued write it holds belongs to that
one scope; nothing moves a client, or a row, from one scope to another.

```ts
import { deviceId, scopeId } from "weftdb/core";
import { WeftClient } from "weftdb/client";
import { schema } from "./src/schema.ts";

const client = new WeftClient(scopeId("user-1"), deviceId("laptop"), schema);
```

A scope has many devices. A bearer token names one scope and one device inside it, so a scope with
several devices in active use holds one token per device, all resolving to the same `scopeId`. The
demo applications in `demos/shared/src/identity.ts` assign a random scope id to each visitor on
first load and keep it in local storage, giving every visitor a scope of their own on a relay
shared by many visitors. The id is generated from several words of `crypto.getRandomValues` output
specifically because the relay accepts whatever scope a token names: a guessable id would let one
visitor construct a token that reads another visitor's scope. An unguessable id raises the cost of
guessing a scope. The relay performs no check beyond comparing the token's resolved scope, so a
deployment that hands out tokens to anyone who asks stays exposed regardless of how long the id
is.

## Limits of the model

Scope is the only boundary weftdb enforces. There is no per-row permission, no field-level access
control, and no sharing of a row or a scope between identities. An operation either names the scope
its token resolved to, and is permitted in full, or it does not, and is rejected in full. Nothing
narrower than a scope is checked.
