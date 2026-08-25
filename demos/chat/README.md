# weftdb-demo-chat

A chat room you open in two tabs. Each tab is a separate device with its own outbox, clock and
sync cursor, and the relay pushes over a WebSocket, so a message posted in one tab arrives in the
other without a poll. The message log is an event log: rows are created once and are never edited
or deleted.

Both tabs are the same person: they share one scope, and what the demo shows is a device talking to
its own other device, not two people in a room. Nothing here is collaborative.

```sh
pnpm --filter weftdb-demo-chat dev
```

That starts the shared relay and the page in one process. Open the printed URL in two tabs.

## Things worth trying

| Try this                                   | What happens                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Post in one tab                            | It appears in the other as soon as the relay pushes the wake-up.                                                        |
| Close a tab                                | Its chip on the device strip goes quiet within 15 seconds, because its heartbeat stops.                                 |
| Go offline in one tab and keep posting     | Messages land in the outbox, the unsent count climbs, and they drain in order when you come back.                       |
| Post from both tabs while both are offline | Every message survives. Append-class rows are written once, so two devices writing at the same moment produce two rows. |
| Reload a tab with unsent messages          | They are still there. Local storage holds the client's state.                                                           |

## How it is put together

```
src/schema.ts      the schema: one event log, one mutable collection
src/generated/     weft generate output: row types, queries, decoders, mutators, React hooks
src/scope.ts       what this demo calls itself on the shared relay
src/store.ts       what codegen cannot know: sync, connectivity, status, the heartbeat
src/app.tsx        the page
dev.ts             the shared relay and the page, in one process
```

### The schema

Two collections, and the difference between them is the point:

```ts title="src/schema.ts"
messages: S.eventLog({ body: S.string(), device: S.string(), author: S.string() }),
devices: S.collection({ label: S.string(), last_seen: S.number() }),
```

`S.eventLog` declares an append-class collection. The generated mutators for `messages` carry
`create` and nothing else: there is no `update` and no `delete`, because the rows accept no write
after the transaction that created them, and the relay rejects one that arrives anyway with
`append_class_violation`. Two devices posting at the same moment produce two rows, so nothing has
to merge. `devices` is an ordinary collection, rewritten by each tab every 5 seconds, and its
fields merge last-writer-wins.

Run `pnpm --filter weftdb-demo-chat generate` after editing the schema. The output is committed so
the page builds without a codegen step.

### Live updates

`store.ts` passes `openSocket` to `WeftSession`, which opens `connectSocketTransport` against
`/api/sync` with this tab's bearer token. The relay holds one socket per tab and sends the scope's
new sequence number when anything is pushed to it; the session answers by running the same sync it
would have run on a timer. The socket carries no rows, so there is one code path whose correctness
everything else depends on. The chip in the header reads `live` while the socket is up and
`polling` when it is not, and the fallback timer drops to a few seconds while the connection is
away.

### Presence

There is no presence service. Each tab writes one row into `devices` on start and every 5 seconds
after that, holding its label and `last_seen`. The strip reads those rows and marks a device
connected if its heartbeat is under 15 seconds old. Closing a tab stops the heartbeat, so the chip
goes quiet on its own. The strip is ordered by device id, which no heartbeat changes, so chips keep
their places while `last_seen` moves under them.

### Identity

Two levels, from `weftdb-demo-shared/identity`. The scope lives in `localStorage`, so every tab of
one browser joins the same room and another visitor gets their own. The device lives in
`sessionStorage`, which is per tab: reloading keeps unsent work, and a new tab is a new device.
The client's state lives in `localStorage` under `weftdb-demo/chat/<scope>/<device>`.

The relay accepts any `demo.<scope>.<device>` bearer token, which is why it binds to loopback. One
visitor's rows are separated from another's by the scope id being long and random. That is
unguessable rather than authorised: anyone who learns a scope id can read it.

## Scripts

| Script          | What it does                                                                   |
| --------------- | ------------------------------------------------------------------------------ |
| `pnpm dev`      | relay and page in one process                                                  |
| `pnpm page`     | just the page (`WEFT_DEMO_PORT`, default `5174`), proxying `/api` to the relay |
| `pnpm build`    | production build of the page                                                   |
| `pnpm generate` | regenerate `src/generated/` from the schema                                    |
