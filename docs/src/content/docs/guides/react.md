---
title: React
description: Generated query hooks, row identity, notification coalescing, writing from a handler, and the editing cases that need care.
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
into the `SharedWorker` that holds the device's database
([Storage on the device](/guides/device-storage/)). The other cost is a component re-rendering a
row that has not changed.

The engine keeps that cost proportional to what changed, not to the result size. It reports a
query's change as `added`, `removed`, and `changed` row ids, so a result that gained one row costs
one row. A write bumps the revision counter, `_weft_rev`, of the row it touches and of no other,
which is what decides whether a row is handed back as the object it already was.

An unchanged row keeps the same object reference across renders, a stronger guarantee than value
equality. `React.memo` skips a row component's render when a prop is `===` to the one it rendered
with last, so an unchanged row costs a reference comparison rather than a repaint.

## Subscribing without tearing

Every generated hook is `useSyncExternalStore` underneath, through `useWeftQuerySnapshot`, and
`getSnapshot` always answers from a cache rather than recomputing.

React can call a component's render function more than once for one update, including
concurrently with another update in progress. `useSyncExternalStore` requires `getSnapshot` to
answer identically each time it is asked about one store state. Answering from the cache is what
makes that possible: two calls inside one render pass see the same object, tearing-free.

## Coalescing notifications

A write does not notify a query's subscribers directly. The storage worker applies the mutation,
commits it, and pushes back the rows that moved; the mirror applies that push and wakes the
subscriptions. An incoming batch over the sync socket arrives the same way, and a finished sync,
incremental or a full snapshot resync alike, wakes them exactly once. The engine flushes at most
once per microtask, however many wake-ups arrive before it runs.

A burst of local writes inside one transaction, or a batch of remote rows, reaches a subscribed
component as one re-render, not one per row.

## Writing from an event handler

Every mutator returns a promise, and a DOM handler has nowhere to await one. Discard it with
`void`, which is the form `@typescript-eslint/no-floating-promises` requires a call site to write:

```tsx title="src/done-button.tsx"
import { todos } from "./store.ts";

export function DoneButton({ id, done }: { id: string; done: boolean }) {
  return <button onClick={() => void todos.update(id, { done: !done })}>{done ? "Undo" : "Done"}</button>;
}
```

Nothing above renders from the promise. The row this button shows arrives on the worker's next
push, which the mirror applies once the write has committed. Await the promise where the handler
has something left to do: a dialog that closes on success, or a message that reports a refusal.
[Writing data](/guides/writing-data/) covers what resolving and rejecting each mean.

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

```ts title="src/generated/bindings.ts"
export async function moveTodos(
  mutators: TodosMutators,
  rows: readonly TodosRow[],
  index: number,
  direction: "up" | "down",
  device: DeviceId,
): Promise<void> {
  const rankOf = (row: TodosRow | undefined) => (row === undefined ? null : rankString(String(row["rank"])));
  const moving = rows[index];
  const neighbour = rows[direction === "up" ? index - 1 : index + 1];
  if (moving === undefined || neighbour === undefined) return;
  const beyond = rows[direction === "up" ? index - 2 : index + 2];
  const [before, after] = direction === "up" ? [beyond, neighbour] : [neighbour, beyond];
  await mutators.update(String(moving["id"]), { rank: rankBetween(rankOf(before), rankOf(after), device) });
}
```

`moveTodos` hands back the promise of the one write it makes, so a button discards it with `void`
on the same terms as any other handler.

A pointer-drag version of the same list needs one thing this button pair does not. The query's
rows have to stay frozen while the drag is in progress, with any update that arrives applied only
on drop. Otherwise a remote reorder could resort the row out from under the pointer mid-drag.
[Writing data](/guides/writing-data/) covers `moveTodos` and `nextTodosRank` in full.

## Running across multiple tabs

One `SharedWorker` per origin holds the database, and every tab connects a port of its own to it.
A component reads the same rows and writes through the same outbox in every tab, and a tab has no
coordination of its own to do. [Multi-tab coordination](/concepts/multi-tab/) covers what one
worker per origin settles.

A browser may stop a `SharedWorker` under memory pressure, which closes every port to it at once.
`openWeftDatabase` constructs one at the same URL again, and the mirror re-hydrates and registers
every watched statement with whichever worker answers, so each `use<Collection>Query` re-renders
with the rows that worker reports. A request in flight when the previous worker went away rejects
rather than resolving, because the tab cannot know whether the write landed. That rejection reaches
the mutator's own caller, and `onError` where nobody kept the promise.

The demo sidesteps this rather than exercising it: each tab opens its own database under a
namespace of its own, so tabs sync as separate devices through the relay instead of sharing one
on-device database.
