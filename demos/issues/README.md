# weftdb-demo-issues

An issue tracker in three collections: `projects` hold `issues`, and `issues` hold `comments`. The
schema declares the joins between them, and the page renders the joined result. Each browser tab is
a separate device with its own database, outbox, clock, and sync cursor, syncing through the relay
this demo runs in the browser.

```sh
pnpm --filter weftdb-demo-issues dev
```

Open the printed URL in two tabs.

## What the relationships do here

The schema declares four relationships:

| Relationship      | Kind      | Resolves to                                                            |
| ----------------- | --------- | ---------------------------------------------------------------------- |
| `projects.issues` | `hasMany` | the issue count beside each project in the rail                        |
| `issues.project`  | `hasOne`  | the project name on each issue row and in the detail heading           |
| `issues.comments` | `hasMany` | the comment count on each issue row, and the thread in the detail view |
| `comments.issue`  | `hasOne`  | declared for the reverse lookup; the page does not read it             |

`weft generate` writes one accessor per relationship into `src/generated/relationships.ts`.
`projects_issuesRelation(issues)` indexes the rows a hook returned by the field the join names and
returns a lookup, which `src/app.tsx` builds once per render in `joinsOver` and calls per row. No
foreign key is written down anywhere on the page, and the accessor carries the row type through, so
a lookup against `IssueView[]` yields `IssueView[]` rather than the bare generated row.

Counts are resolved from rows rather than stored on the row they describe. A comment arriving from
another device changes the count on the issue row without anything writing to the issue.

The rail's counts read every issue the tracker holds, which is why they do not move when the list
below them is narrowed. That narrowing is the other half: the issue list is `useIssuesQuery` with
the rail's project and the chosen status compiled into one statement, run against SQLite in the
storage worker, so what crosses the port is the rows on screen. A relationship accessor answers a
question about the tracker; a statement answers a question about what to show.

Nothing cascades. Deleting a project leaves its issues in place, and their project name falls back
to `unknown project`. A row that points at a row this device does not hold is an ordinary state
while sync is in flight, so the page renders it rather than failing.

## Append-only comments

`comments` is declared with `S.eventLog`, so its rows are append-class: they are written once and
are immutable from the next transaction on. The generated mutators carry `create` alone. The
client refuses a `set` or a `delete` on such a row before it reaches the outbox, and the relay
applies the same rule to anything a client sends. The thread renders as text.

Two devices commenting on one issue at the same moment produce two rows, so there is nothing to
merge.

## First-run data

A new scope is seeded once with two projects, five issues across all three statuses, and one
thread of three comments. `IssueStore.seed` does it, guarded by a `localStorage` key beside the
scope's own. The guard is what makes it once per visitor: a second tab reads the same key, and a
visitor who deletes the seeded rows does not get them back. The ranks are chained as the seed is
written rather than read back per row, because a mutator posts to the storage worker and returns
before the row it wrote has come back.

A device that hydrates empty is not evidence of a fresh scope, because every new tab is a new
device and hydrates empty until it has synced. The key decides; the row count only keeps a cleared
key from seeding a scope that already has rows.

## Nested mappers

A comment's author is stored in two flat columns, `author__label` and `author__device`. The `__`
separator marks a nested path. `weft generate` writes `mapCommentsRow` into
`src/generated/nested-mappers.ts`, which folds those columns into an object, and `commentView` in
`src/store.ts` calls it. The page reads `comment.author.label`.

## Merge behaviour

| Field                          | Annotation         | Effect                                                                                               |
| ------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `issues.body`                  | `diff3`            | Two devices editing different lines both keep their work. Overlapping edits come back behind markers |
| `issues.status`                | `enum` under `lww` | The later write wins, and the column rejects any value outside the set                               |
| `projects.rank`, `issues.rank` | `fracIndex`        | Reordering writes one field, so two devices reordering at once do not undo each other                |

## Layout

```
src/schema.ts          collections, relationships, and merge annotations
src/generated/         weft generate output: row types, queries, decoders, mutators, hooks,
                       relationship accessors, nested mappers
src/store.ts           what codegen cannot know: which scope, the seed, what a row shows
src/app.tsx            the page
src/storage-worker.ts  this tab's database, and the sync session beside it
src/broker.ts          the SharedWorker that moves a port between tabs
src/relay-worker.ts    the relay, as a SharedWorker of this browser
dev.ts                 the page, through Vite's API
```

Run `pnpm --filter weftdb-demo-issues generate` after every schema edit. The output is committed, so
the page builds without a codegen step.

## Identity

Identity comes from `weftdb-demo-shared/identity` and has two levels. The scope lives in
`localStorage`, so every tab of one browser opens the same tracker and another visitor opens their
own. The per-tab key lives in `sessionStorage`, and this tab's database is named after it: a
database is a namespace and a scope together, so a namespace per tab is one election, one storage
worker, one OPFS pool and one device id per tab. Reloading keeps your unsent work, and a new tab is
a new device.

The relay authorises nobody, because every device it serves is a tab of one person's browser and
the rows never leave the machine. One visitor's rows are separated from the next visitor's by a
scope id that is long and random. That is unguessable rather than authorised, and anything modelled
on this relay needs the scope taken out of the caller's hands before a second person sees it.

## Scripts

| Script          | What it does                                               |
| --------------- | ---------------------------------------------------------- |
| `pnpm dev`      | the page                                                   |
| `pnpm page`     | the same, through Vite's binary (`WEFT_DEMO_PORT`: `5175`) |
| `pnpm build`    | production build of the page                               |
| `pnpm generate` | regenerate `src/generated/` from the schema                |
