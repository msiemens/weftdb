---
title: Sync over WebSocket
description: Connecting a socket transport, wake-ups, subscriptions, reconnection, and the framing that carries a token as a subprotocol.
sidebar:
  order: 9
---

A device can reach the relay over a WebSocket instead of HTTP (Hypertext Transfer Protocol), using
`connectSocketTransport` from `weftdb/client` in place of `httpTransport`. `SocketTransport`
satisfies the same `AsyncSyncTransport` interface as the HTTP transport, so `WeftClient.syncWith`
runs identical code against either one. Only the way the four calls travel changes.

## Connecting over a socket

`connectSocketTransport` takes a `url`, a `token`, and an `onWake` callback:

```ts title="socket.ts"
import { deviceId, scopeId } from "weftdb/shared";
import { connectSocketTransport, WeftClient } from "weftdb/client";
import { schemaHash } from "weftdb/schema";
import { schema } from "./src/schema.ts";

const hash = schemaHash(schema);
const laptop = new WeftClient(scopeId("user-1"), deviceId("laptop"), schema);

const transport = connectSocketTransport({
  url: "ws://localhost:8787/sync",
  token: "laptop-token",
  onWake: () => {
    void laptop.syncWith(transport, hash);
  },
});
```

The token is the same bearer token `httpTransport` takes, so it maps to a scope and device the
same way. See [Authentication](/guides/authentication/) for how tokens are issued and verified,
and [Running the relay](/guides/running-the-relay/) for starting the process this connects to.

A request sent over the socket names the operation it wants (`handshake`, `push`, `pull`, or
`snapshot`) rather than describing a route. Both the socket and the HTTP surface carry out the
same four calls, so a device sees no difference in what a call does, only in how it travels. The
connection is authenticated once, at the upgrade, and every request on it runs under the identity
the token established then.

## Receiving wake-ups

The relay tells a device when its scope moved by writing a message to the socket, and the device
turns that into the same sync it would otherwise have run on a timer. Without a subscription,
`onWake` fires with no argument on every message that reports a change, and the callback responds
by calling `syncWith` itself, exactly as it would on a schedule.

A scope moves for reasons no device pushed. Pruning tombstones past their retention window
advances a scope the same way a push does, and every connection attached to that scope is told.
Connecting itself fires `onWake` as well. A socket that has just come up cannot know what happened
while it was down, so the client syncs once on connect rather than assuming it missed nothing.

## Subscribing to batches

Passing `onBatch` and `cursor` turns a connection that only listens into one that is pushed to.
`cursor` reports where this device has got to; the relay reads it on every connect and sends the
records beyond it as a batch, the same batch a call to `pull` would have answered with:

```ts
const transport = connectSocketTransport({
  url: "ws://localhost:8787/sync",
  token: "laptop-token",
  onBatch: (batch) => laptop.applyPull(batch),
  cursor: () => laptop.lastServerSeq,
});
```

`applyPull` is the same method a poll-driven sync calls, so a subscribed device ends up holding
exactly what a device that kept polling would hold.

The relay records a subscriber's cursor as advanced the moment it writes a batch, rather than when
the device acknowledges receiving it. A socket that dies mid-delivery leaves the relay believing
the batch arrived. Re-delivering the same records on reconnect is safe because applying a batch is
idempotent: a device that reconnects reports where it actually got to, and any record it already
holds is applied again without changing anything.

## Reconnecting and going back to polling

A dropped connection retries with a backoff that starts at 500 milliseconds and doubles on each
attempt, up to 30 seconds. A request made while the socket is down fails rather than queuing,
because the outbox, the writes not yet sent, is already the queue: a failed sync is one the client
runs again once it reconnects.

A device that cannot open a socket at all stays on `httpTransport` and syncs on a timer.
`httpTransport` is a complete implementation on its own, and the socket lowers the latency of the
same four calls rather than adding a second protocol.

## Framing the connection

The relay implements RFC 6455 framing directly rather than depending on a WebSocket library for
it. A frame it cannot parse, one with reserved bits set, an unmasked frame from a client, or one
declaring a payload larger than `8 MiB`, closes the connection rather than being guessed at.

A browser's `WebSocket` constructor cannot set headers, so the token travels as a subprotocol,
`weft.token.<token>`, instead of in the query string, where it would land in every access log
between the device and the relay. RFC 6455 requires a subprotocol value to be a valid HTTP token,
and the `WebSocket` constructor throws on a value that is not. A token containing a separator
character such as a colon never opens the socket, and a page written to fall back to polling on
that failure does so silently, with nothing to say why. `tests/demo.test.ts` asserts that every
token issued is a legal subprotocol value, because a colon in a token has broken this before.

An answer too large for one message, mainly a snapshot, is split into `32KB` chunks and written
across separate turns of the event loop so nothing else on the connection has to wait behind it.
The relay pings every 30 seconds and drops a connection that answers neither a ping nor anything
else before the next one, since a connection an idle network device has quietly dropped looks the
same as a healthy one until something is written to it.
