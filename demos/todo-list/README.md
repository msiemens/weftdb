# weftdb-demo-todo

A shared todo list you open in two tabs. Each tab is a **separate device** — its own outbox,
its own clock, its own sync cursor — talking to a real relay over HTTP. Nothing is scripted and
nothing is simulated: this is the same client, server, schema and merge machinery the tests run
against, wired up the way an application would wire it.

```sh
pnpm demo          # from the repo root — starts the relay and the page together
```

Then open the printed URL **in two tabs** and try to break it.

## Things worth trying

| Try this                                                 | What you should see                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Add something in one tab                                 | It appears in the other within a poll (or instantly — tabs nudge each other over a `BroadcastChannel`).                                       |
| Go offline in one tab and keep editing                   | The list stays live, the unsent count climbs, nothing is lost. Come back online and it drains.                                                |
| Offline in both: rename in one, tick done in the other   | Both survive. Merging is per field, so two people touching one row do not overwrite each other.                                               |
| Offline in both: edit _different lines_ of the same note | diff3 merges the prose. Nobody is asked to resolve anything.                                                                                  |
| Offline in both: edit _the same line_                    | Both versions come back behind `WEFT_LOCAL` / `WEFT_REMOTE` markers. Resolving is an ordinary edit — there is no conflict record left behind. |
| Delete a row in one tab while the other edits it offline | The edit is **quarantined**, not dropped and not forced through. You decide what happens to it.                                               |
| Reload a tab with unsent work                            | It is still there. Local storage is the client's state, not a cache of the server's.                                                          |
| Reorder with ↑ / ↓                                       | One field write — a fractional index — so two tabs reordering at once do not undo each other.                                                 |

## How it is put together

```
src/schema.ts      the schema — the only place merge behaviour is declared
src/generated/     weft generate output: row types, queries, decoders, mutators, React hooks
src/auth.ts        who the relay lets in
src/identity.ts    this tab's device identity (session storage) and token
src/store.ts       what codegen cannot know: sync, connectivity, status
src/app.tsx        the page
relay.ts           the real relay, persisting to SQLite
dev.ts             both of the above, in one process
```

**Codegen is load-bearing.** `pnpm --filter weftdb-demo-todo generate` writes `src/generated/` from
`src/schema.ts`. `bindings.ts` is the part an application would otherwise write by hand:

```tsx
const todos = useTodos(store.source, "rank"); // rows already typed as Database["todos"]
store.todos.update(todo.id, { done: true }); // a field the schema lacks is a type error
```

A hook, a query naming every field the row type promises, a decoder that reads each field as
the type it was declared as, and mutators, per collection — with no `update` or `delete` for an
append-only collection, because those rows are written once. What is left in `store.ts` is only
what the schema cannot describe: when to sync, whether this tab is online, and what to show
about unsent work. Regenerate after touching the schema; the output is committed so the page
builds without a codegen step.

**Identity.** Two levels, in `weftdb-demo-shared/identity`. The _scope_ lives in `localStorage`,
so every tab of one browser opens the same list and another visitor opens their own; it survives
reload and is made once. The _device_ lives in `sessionStorage`, which is per-tab: reloading keeps
your unsent work, a new tab is a new device. The client's own state lives in `localStorage` under
`weftdb-demo/todo/<scope>/<device>`, one slot per device.

**Auth.** The relay accepts any `demo.<scope>.<device>` bearer token, so you can open a second tab
without a sign-up flow. That is why it binds to loopback only. A visitor's rows are separated from
the next visitor's by their scope id being long and random, which is unguessable rather than
unauthorized: anyone who learns a scope id can read it. A deployment issues tokens after sign-in —
see `packages/weftdb/src/server/serve.ts`, where `WEFT_TOKENS` names them explicitly, or supply
your own `TokenVerifier`.

**One relay for every demo.** The server is schema-blind, so the todo list and any other demo need
nothing different from it, and scope equality already keeps them apart. `pnpm demo:relay` from the
workspace root starts the one they share.

**Sync.** The relay holds a WebSocket per tab and says "this scope is now at sequence N" when
anything is pushed; the tab answers with the same sync session it would have run on a timer.
The socket carries no data — it only says _when_, so there is one code path whose correctness
everything else is about. The badge in the header reads **live** while that socket is up and
**polling** when it is not: the fallback timer drops from a minute to three seconds whenever
the connection goes away, so the page keeps working with the socket blocked or unsupported.
Tabs in the same browser also nudge each other over a `BroadcastChannel`. Going offline stops
the session entirely — edits keep landing in the outbox.

## Scripts

| Script          | What it does                                                   |
| --------------- | -------------------------------------------------------------- |
| `pnpm dev`      | relay + page in one process                                    |
| `pnpm page`     | just the page (`WEFT_DEMO_PORT`), proxying `/api` to the relay |
| `pnpm build`    | production build of the page                                   |
| `pnpm generate` | regenerate `src/generated/` from the schema                    |

The page is covered by `tests/demo.test.ts`, which mounts this component tree in jsdom and
clicks through the table above with two tabs against the real relay handler.
