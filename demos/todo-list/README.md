# weftdb-demo-todo

A shared todo list you open in two tabs. Each tab is a **separate device** — its own database,
its own outbox, its own clock, its own sync cursor — syncing through a real relay. Nothing is
scripted and nothing is simulated: this is the same client, server, schema and merge machinery the
tests run against, wired up the way an application would wire it.

```sh
pnpm demo          # from the repo root
```

Then open the printed URL **in two tabs** and try to break it.

## Things worth trying

| Try this                                                 | What you should see                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Add something in one tab                                 | It appears in the other as soon as the relay pushes the wake-up, with no poll in between.                                                     |
| Go offline in one tab and keep editing                   | The list stays live, the unsent count climbs, nothing is lost. Come back online and it drains.                                                |
| Offline in both: rename in one, tick done in the other   | Both survive. Merging is per field, so two people touching one row do not overwrite each other.                                               |
| Offline in both: edit _different lines_ of the same note | diff3 merges the prose. Nobody is asked to resolve anything.                                                                                  |
| Offline in both: edit _the same line_                    | Both versions come back behind `WEFT_LOCAL` / `WEFT_REMOTE` markers. Resolving is an ordinary edit — there is no conflict record left behind. |
| Delete a row in one tab while the other edits it offline | The edit is **quarantined**, not dropped and not forced through. You decide what happens to it.                                               |
| Reload a tab with unsent work                            | It is still there. The device's own database is the client's state, not a cache of the server's.                                              |
| Reorder with ↑ / ↓                                       | One field write — a fractional index — so two tabs reordering at once do not undo each other.                                                 |

## How it is put together

```
src/schema.ts          the schema — the only place merge behaviour is declared
src/generated/         weft generate output: row types, queries, decoders, mutators, React hooks
src/store.ts           what codegen cannot know: which scope, which namespace, what a row shows
src/app.tsx            the page
src/storage-worker.ts  this tab's database, and the sync session beside it
src/broker.ts          the SharedWorker that moves a port between tabs
src/relay-worker.ts    the relay, as a SharedWorker of this browser
dev.ts                 the page, through Vite's API
```

**Codegen is load-bearing.** `pnpm --filter weftdb-demo-todo generate` writes `src/generated/` from
`src/schema.ts`. `bindings.ts` is the part an application would otherwise write by hand:

```tsx
const todos = useTodos(store.source, "rank"); // rows already typed as Database["todos"]
const recent = useTodoEventsQuery(store.source, (events) =>
  events.where("kind", "in", KINDS).orderBy("created", "desc").limit(8),
);
store.todos.update(todo.id, { done: true }); // a field the schema lacks is a type error
```

A hook, a query naming every field the row type promises, a statement builder typed against the
schema, a decoder that reads each field as the type it was declared as, and mutators, per
collection — with no `update` or `delete` for an append-only collection, because those rows are
written once. The activity panel is the statement builder in use: the `where`, the ordering and the
bound go down to SQLite in the storage worker, so eight rows cross the port rather than every event
the scope has ever recorded. Regenerate after touching the schema; the output is committed so the
page builds without a codegen step.

**One database per tab.** `openWeftDatabase` normally gives a browser one database however many
tabs are open, which is what the election and the port broker are for. These demos want the
opposite, so each tab passes a `namespace` of its own — derived from the per-tab device key in
`sessionStorage`. A database is a namespace and a scope together, so that is one election, one
storage worker, one OPFS pool and one device id per tab, under the one scope every tab of this
browser shares. What a second tab is here is what a second laptop is in a deployment.

**Identity.** Two levels, in `weftdb-demo-shared/identity`. The _scope_ lives in `localStorage`,
so every tab of one browser opens the same list and another visitor opens their own; it survives
reload and is made once. The per-tab key lives in `sessionStorage`, which is what the namespace is
named after: reloading keeps your unsent work, a new tab is a new device.

**The relay is in the browser.** A static page has no server behind it, so `src/relay-worker.ts`
runs a real `WeftServer` in a `SharedWorker` and every tab connects to it over a `MessagePort`.
That stands in for a deployment rather than for a transport: the four calls are the four calls, the
push is refused or accepted for the same reasons, and only the distance between the two ends
changes. It holds nothing back and authorises nobody, because every device it serves is a tab of
one person's browser. Anything modelled on it needs the scope taken out of the caller's hands
before it is put in front of a second person. The scope's history lasts as long as the worker:
close every tab and the relay's copy is gone, while each tab keeps its own rows in its own
database.

**Sync.** The page hands the relay's port to its storage worker as the worker is created, and the
sync session runs in there beside the client. The relay says "this scope is now at sequence N" when
anything is pushed, and the tab answers with the same sync session it would have run on a timer.
The badge in the header reads **live** while that line is up. Going offline cuts the line inside
the worker — edits keep landing in the outbox, and coming back drains it.

## Scripts

| Script          | What it does                                       |
| --------------- | -------------------------------------------------- |
| `pnpm dev`      | the page                                           |
| `pnpm page`     | the same, through Vite's binary (`WEFT_DEMO_PORT`) |
| `pnpm build`    | production build of the page                       |
| `pnpm generate` | regenerate `src/generated/` from the schema        |

The page is covered by `tests/demo.test.ts`, which mounts this component tree in jsdom and clicks
through the table above with two tabs, each on its own storage worker, against the relay this demo
ships.
