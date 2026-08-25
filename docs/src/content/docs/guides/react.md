---
title: React
description: Generated query hooks, row identity, notification coalescing, and the editing cases that need care.
sidebar:
  order: 5
---

`weft generate` writes one hook per collection into the generated bindings, next to the row type
and the decoder it reads with. The todo list demo reads its list with the generated `useTodos`:

```tsx
const todos = useTodos(store.source, "rank").map((row) => store.view(row));
```

`store.source` is a `WeftSource`, the shape every generated hook takes as its first argument.
`useTodos` itself is a thin wrapper:

```ts
export function useTodos(source: WeftSource, orderBy: TodosField = "id"): readonly TodosRow[] {
  return useWeftRows(source, todosQuery(orderBy), decodeTodos);
}
```

Hold the source rather than rebuilding it per read. `useSyncExternalStore` re-subscribes whenever
the object it was given is a new one, so a getter returning a fresh literal every render tears down
and reopens the subscription on every pass.

`weftdb-react` also exports `useWeftQuery(source, key)` directly, for a value cached outside the
row query engine: `source` is anything with a `getSnapshot(key)` and a `subscribe(key, listener)`,
such as the package's own `QueryCache`. `useWeftSuspenseQuery` wraps the same pattern, throwing
`source.load(key)` while `getSnapshot` answers `undefined`, so one call site opts into Suspense on
its own. [Reading data](/guides/reading-data/) covers the query surface itself.

## Keeping re-renders cheap

Running a query over a few thousand rows costs microseconds. What costs more is the round trip
into the worker that holds the on-device database, on a build using the WebAssembly SQLite
executor ([Storage on the device](/guides/device-storage/)). The other cost is a component
re-rendering a row that has not changed.

The engine keeps that cost proportional to what changed, not to the result size. It diffs a
query's new rows against its previous ones into `added`, `removed`, and `changed` row ids, rather
than handing back a fresh list to re-render from scratch. That diff runs on row identity: a
materialized row is cached per `(table, id)`, keyed by a revision counter, `_weft_rev`, and a write
bumps only the counter of the row it touches:

```ts
// inside RowIdentityCache.materialize
if (cached?.rev === row.internals._weft_rev) return cached.row;
```

An unchanged row keeps the same object reference across renders, a stronger guarantee than value
equality. `React.memo` skips a row component's render when a prop is `===` to the one it rendered
with last, so an unchanged row costs a reference comparison rather than a repaint.

## Subscribing without tearing

Every generated hook is `useSyncExternalStore` underneath, through `useWeftQuerySnapshot`, and
`getSnapshot` always answers from a cache rather than recomputing:

```ts
// inside SubscriptionEngine.getSnapshot
if (cached !== undefined && sameRows(cached.rows, nextRows)) return cached;
```

React can call a component's render function more than once for one update, including
concurrently with another update in progress. `useSyncExternalStore` requires `getSnapshot` to
answer identically each time it is asked about one store state. Answering from the cache is what
makes that possible: two calls inside one render pass see the same object, tearing-free.

## Coalescing notifications

A write does not notify a query's subscribers directly. Every generated mutator calls `notify`
after it writes, wired to the session's `changed()`. An incoming batch over the sync socket wires
the same call, and a finished sync, incremental or a full snapshot resync alike, calls it exactly
once. Each reaches the engine's `notify()`, which queues at most one microtask flush per burst:

```ts
// inside SubscriptionEngine
notify(): void {
  if (this.#queued) return;
  this.#queued = true;
  queueMicrotask(() => {
    this.#queued = false;
    for (const listeners of this.#listeners.values()) {
      for (const listener of listeners) listener();
    }
  });
}
```

A burst of local writes inside one transaction, or a batch of remote rows, reaches a subscribed
component as one re-render, not one per row.

## Editing a field that merges three ways

A field marked `merge: "diff3"` in its schema, such as the demo's `notes`
([merge model](/concepts/merge-model/)), can receive a remote edit mid-sentence. Applying it
straight to the input would move text under the caret, so the demo buffers it with
`Diff3EditorBuffer` instead:

```tsx
// from useBufferedField's returned handlers
onFocus: () => buffer.current.focus(),
onBlur: () => {
  const edited = draft !== committed.current;
  send(draft);
  const held = buffer.current.blur();
  const last = held.at(-1);
  if (!edited && last !== undefined) {
    committed.current = last.value;
    setDraft(last.value);
  }
},
```

While the field is focused, `receiveRemote` holds every arriving value rather than applying it.
That includes the echo of the field's own write coming back through the query, which is how the
subscription recognises its own write instead of overwriting the caret with it. `blur` returns
whatever was held, applied only if nothing was typed locally since. Typing is debounced 600 ms past
the last keystroke and always flushed on blur, so a word in progress is one write.

:::caution
The demo flushes on blur only. An application also needs to flush on unmount and on
`visibilitychange`, or an edit made right before a tab is backgrounded is lost with it.
:::

## Reordering a sorted list

`rank`, the field `todos` is ordered by, is written so a reorder changes one value between its new
neighbours rather than renumbering the list. The demo's up and down buttons call `moveTodos`:

```ts
export function moveTodos(
  mutators: TodosMutators,
  rows: readonly TodosRow[],
  index: number,
  direction: "up" | "down",
  device: DeviceId,
): void {
  const rankOf = (row: TodosRow | undefined) => (row === undefined ? null : rankString(String(row["rank"])));
  const moving = rows[index];
  const neighbour = rows[direction === "up" ? index - 1 : index + 1];
  if (moving === undefined || neighbour === undefined) return;
  const beyond = rows[direction === "up" ? index - 2 : index + 2];
  const [before, after] = direction === "up" ? [beyond, neighbour] : [neighbour, beyond];
  mutators.update(String(moving["id"]), { rank: rankBetween(rankOf(before), rankOf(after), device) });
}
```

A pointer-drag version of the same list needs one thing this button pair does not. The query's
rows have to stay frozen while the drag is in progress, with any update that arrives applied only
on drop. Otherwise a remote reorder could resort the row out from under the pointer mid-drag.
[Writing data](/guides/writing-data/) covers `moveTodos` and `nextTodosRank` in full.

## Running across multiple tabs

An on-device database opened through the WebAssembly SQLite executor holds one OPFS synchronous
access handle, open in one tab at a time. `MultiTabCoordinator.elect()` resolves that with a Web
Lock: the tab that acquires it becomes `leader`, and every other tab becomes `follower`. A tab in a
browser without Web Locks is `degraded`, and so is a leader after it calls `close()`.

A Web Lock is held for exactly as long as the callback's promise is pending, so the leader's
callback returns one that stays pending until `close()`. A callback that returned straight away
would hand the lock back and leave each tab in turn believing it leads:

```ts
// inside MultiTabCoordinator.elect
locks.request(`weft:${this.scopeId}:opfs`, { ifAvailable: true }, (lock) => {
  if (lock === null) {
    this.role = "follower";
    resolveRole(this.role);
    return undefined;
  }
  this.role = "leader";
  resolveRole(this.role);
  return new Promise<void>((releaseLock) => {
    this.#release = releaseLock;
  });
});
```

A follower does not open the database itself. `BroadcastDbProxy` forwards its requests over a
`BroadcastChannel`, and `serveBroadcastDbProxy` answers them on the leader:

```ts
// on the leader, after elect() has returned "leader"
const server = serveBroadcastDbProxy({
  channel: new BroadcastChannel(`weft:${scopeId}:db`),
  target: transport,
  isLeader: () => coordinator.role === "leader",
});
```

`target` is anything with a `request` method, which `OpfsWorkerTransport` already has. A follower
speaks the whole worker protocol through it, so hydrating, mutating, and watching all cross the
channel. `isLeader` is consulted once per request, so a tab that has lost the lock stops answering
before its successor starts. Calling `server.stop()` detaches the responder, and a reply produced
after that is dropped rather than posted.

The leader also feeds its worker's unsolicited deltas to `server.relayPush`, or a follower's rows
never move after the first load.

Give the proxy and the responder the same channel name. `MultiTabCoordinator` opens a channel of
its own and never posts on it, so name a channel yourself and pass it to both.

`BroadcastDbProxy.request` waits without a deadline. A follower whose leader dies mid-request, or
that asks before any leader is serving, waits until the proxy is disposed. Drive a banner from
`role` rather than from a request that has not come back, and re-run `elect()` when a follower
needs to find out that leadership has moved.

The demo sidesteps this rather than exercising it: each tab gets its own device id and its own
`localStorage`-backed store, so tabs sync as separate devices through the relay instead of sharing
one on-device database. Its `BroadcastChannel` only wakes a tab's sync sooner when another tab
writes.
