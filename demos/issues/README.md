# weftdb-demo-issues

An issue tracker in three collections: `projects` hold `issues`, and `issues` hold `comments`. The
schema declares the joins between them, and the page renders the joined result. Each browser tab is
a separate device with its own outbox, clock, and sync cursor, talking to the shared relay over
HTTP.

```sh
pnpm --filter weftdb-demo-issues dev
```

That starts the relay and the page together. Open the printed URL in two tabs.

## What the relationships do here

The schema declares four relationships:

| Relationship      | Kind      | Resolves to                                                            |
| ----------------- | --------- | ---------------------------------------------------------------------- |
| `projects.issues` | `hasMany` | the issue count beside each project in the rail                        |
| `issues.project`  | `hasOne`  | the project name on each issue row and in the detail heading           |
| `issues.comments` | `hasMany` | the comment count on each issue row, and the thread in the detail view |
| `comments.issue`  | `hasOne`  | declared for the reverse lookup; the page does not read it             |

`weft generate` writes one descriptor per relationship into `src/generated/relationships.ts`. A
descriptor names the table on each side, the field on each side, and whether the far side holds many
rows. `Related` in `src/store.ts` takes a descriptor and the rows a hook returned, indexes them by
the field the descriptor names, and answers `all(source)` and `one(source)`. No foreign key is
written down anywhere in `src/app.tsx`.

Counts are resolved from rows rather than stored on the row they describe. A comment arriving from
another device changes the count on the issue row without anything writing to the issue.

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
visitor who deletes the seeded rows does not get them back. Seeding runs before the session
starts, so the rows go into the outbox and reach the relay in the first sync.

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
src/schema.ts      collections, relationships, and merge annotations
src/generated/     weft generate output: row types, queries, decoders, mutators, hooks,
                   relationship descriptors, nested mappers
src/store.ts       what codegen cannot know: sync, connectivity, status, and join resolution
src/app.tsx        the page
dev.ts             the relay and the page in one process
```

Run `pnpm --filter weftdb-demo-issues generate` after every schema edit. The output is committed, so
the page builds without a codegen step.

## Identity

Identity comes from `weftdb-demo-shared/identity` and has two levels. The scope lives in
`localStorage`, so every tab of one browser opens the same tracker and another visitor opens their
own. The device lives in `sessionStorage`, so reloading keeps your unsent work and a new tab is a
new device. Client state lives in `localStorage` under `weftdb-demo/issues/<scope>/<device>`, one
slot per device.

The relay accepts any `demo.<scope>.<device>` bearer token, which is why it binds to loopback. One
visitor's rows are separated from the next visitor's by a scope id that is long and random. That is
unguessable rather than authorised: anyone who learns a scope id can read it. A deployment issues
tokens after sign-in.

## Scripts

| Script          | What it does                                                                      |
| --------------- | --------------------------------------------------------------------------------- |
| `pnpm dev`      | relay and page in one process                                                     |
| `pnpm page`     | just the page, on `WEFT_DEMO_PORT` (default `5174`), proxying `/api` to the relay |
| `pnpm build`    | production build of the page                                                      |
| `pnpm generate` | regenerate `src/generated/` from the schema                                       |
