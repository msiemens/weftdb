# Testing

Every invariant in [DESIGN.md section 9](./DESIGN.md#9-invariants-for-property-tests) is
covered by a property test built on [fast-check](https://fast-check.dev), so histories are
generated, replayed, and shrunk rather than only hand-written.

Run the normal suite:

```sh
pnpm test
```

Run counts are tunable, and a failing case can be replayed by pinning its seed:

```sh
WEFT_WORLD_RUNS=3000 WEFT_SCENARIO_RUNS=1500 pnpm test
WEFT_PROPERTY_SEED=1352270866 pnpm test
```

## Property Model

`tests/property-model.ts` is the world model: simulated devices against one server, plus a
neighbouring scope reusing the same row ids. Its commands cover mutation, partitioning,
incremental pull, snapshot resync, duplicate and reordered delivery, injected rejections,
offline stretches spanning the tombstone floor, and pruning.

Every invariant in `tests/property-invariants.ts` is asserted after each generated command
and again once the history has settled. Invariants needing a specific arrangement live in
the other `property-*.test.ts` files, named for the section 9 rule they check.

## Primitive Properties

`tests/property-primitives.test.ts` characterises the algebra the protocol depends on:

- HLCs round-trip and order totally.
- A rank lands strictly between its neighbours.
- Two devices inserting into one rank gap never collide.
- diff3 is idempotent and keeps what each side wrote.
- A wire value survives storage.

## SQL Safety

Generated SQL is built by string interpolation, so `tests/property-sql-safety.test.ts`
treats that as a claim to check. It feeds hostile names and values through:

- `weft rehydrate`, whose input is a server snapshot.
- `weft set-schema-hash`, whose input is a command line.
- The DDL generator.

The test then executes the result against SQLite and asks which tables exist and whether
stored values are byte-for-byte what went in. Identifiers are quoted by doubling `"` and
values by doubling `'`, which is complete for SQLite because it has no backslash escapes.
`defineSchema` refuses names carrying control characters because SQLite truncates
identifiers at a NUL.

## Codegen

`tests/property-codegen.test.ts` generates schemas rather than using only fixed fixtures.
It covers names that collide once punctuation is dropped, event logs, nullable fields, and
derived fields. The checked claims are that generated DDL is valid SQLite, every field is
declared, generation is deterministic, schema reconciliation adds missing columns, and
ambiguous collection names are refused.

## Rendering And Crash Safety

`tests/property-render.test.ts` mounts the demo page, drives generated sequences of user
actions, and holds rendering to a budget. This protects against infinite render loops in
the application-facing layer.

`tests/property-crash.test.ts` generates a history, kills the process with `SIGKILL`, and
asserts that every edit made before the kill comes back. Local storage is the client's
state, not a cache, so this is checked at arbitrary points in the history.

## Exhaustive And Formal Checks

`tests/exhaustive-model.test.ts` walks the state space of a deliberately tiny world:
two devices, two rows, and a clock that only moves when an action says so. It checks every
reachable state breadth-first and prunes states already seen, which catches short failure
sequences deterministically.

[`spec/`](./spec/README.md) holds a TLA+ model of the row lifecycle, model-checked with
TLC.

`tests/trace-validation.test.ts` records what the real client and server do, then asks TLC
whether the specification allows that behaviour. It needs TLC on `PATH`, or `WEFT_TLC`
pointing at it, and skips itself otherwise.

## Socket Coverage

The socket stack is covered at three levels.

`tests/websocket.test.ts` checks framing on its own: generated payload round-trips, the
three length encodings, frames split across TCP reads, and malformed frames that must be
refused. It also exercises the full socket path against Node's built-in WebSocket client.

`tests/property-socket.test.ts` generates histories of edits with connection failures
interleaved. It asserts that nothing acknowledged is lost, everything drains once the
relay is reachable again, devices converge, and a session over the socket lands where the
same session over HTTP does. `WEFT_SOCKET_RUNS` sets how many histories it generates.

`tests/property-ws-subscribe.test.ts` covers the socket push extension: listening devices
end where polling devices do, every record above a subscriber cursor reaches it, batches
do not advertise a cursor above what they carry, reconnect resumes from the client's real
cursor, and subscriptions are scope-isolated.

## Authentication

`tests/property-jwt.test.ts` treats a token as the deployment's access control boundary.
It checks tamper detection, algorithm selection, validity windows, issuer and audience
matching, key-id selection, public-key handling, and that malformed client input does not
make the verifier throw.

## Storage Ports

`tests/property-wasm-sqlite.test.ts` holds the browser SQLite storage port to the same
contract as `node:sqlite`: the same generated history saved through both executors must
hydrate into the same client, including outbox, quarantine, and merge metadata.

The application-facing layers are covered where they run:

- `tests/demo.test.ts` mounts the demo page in jsdom and drives two tabs through merge,
  offline, quarantine, and reload scenarios.
- `tests/http-transport.test.ts` runs sync sessions across the relay's real
  `Request`/`Response` boundary.
- `tests/web-storage.test.ts` pins the durable-state contract a reload depends on.

## Mutation Testing

`scripts/mutate.mjs` asks whether the suite would notice if the protocol were wrong. It
parses fourteen source files with the TypeScript compiler API, rewrites one node at a time,
runs the suite, then restores the file. Mutations include comparison and logical operators,
negation removal, boolean and numeric literals, `a ?? b` collapsed to `a`, method swaps such
as `Math.max` to `Math.min`, and each `if` condition forced both ways. That is 2288 mutants.

The targets are the three files the protocol's decisions live in — `shared/index.ts`,
`client/index.ts`, `server/index.ts` — followed by the modules that decide what is accepted,
what is stored, and what is generated: the schema DSL and codegen, the client's SQLite store,
subscriptions and multi-tab coordination, and the relay's HTTP surface, socket, framing, JWT
verification, snapshot format and configuration. `--only` takes a substring, so `--only
server/` narrows a run to one group.

```sh
node scripts/mutate.mjs --list          # what would be measured, and nothing else
node scripts/mutate.mjs                 # the whole run
node scripts/mutate.mjs --only client/  # one group
node scripts/mutate.mjs --limit 20      # a sample, for checking the harness itself
```

### Waves

The suite runs in waves, cheapest first, and a wave that kills the mutant means the next one is
never started. The ordering is what makes the cost bearable, but the membership is what makes
the answer true: a mutant that only a test outside the waves would catch is reported as a
survivor, which reads as "no test notices this" when the truth is "the harness never ran the
test that does". Because a wave is reached only by a mutant everything before it missed, a slow
test file placed last costs nothing for the mutants that die early and is paid for only by
survivors — which is exactly where the accuracy is needed. Every test file that exercises a
target therefore belongs in some wave, however slow.

Two are deliberately left out. `tests/demo-issues.test.ts` and `tests/todo-seed.test.ts` assert
seeded content and rendered layout, so they fail when a demo's copy changes rather than when the
protocol does; since the harness measures nothing until the baseline is green, a demo edit would
stop mutation testing outright. `tests/trace-validation.test.ts` checks the TLA+ spec rather
than the source and skips without TLC on `PATH`.

Run counts are lowered and the seed is pinned, so a survivor list is reproducible rather than a
function of whichever histories fast-check happened to draw. Each wave has its own wall-clock
budget: a timeout is scored as a detection, so a budget a healthy run could exhaust on its own
would turn every survivor into a false detection.

### Sharding

A run rewrites files in the working tree, so it owns that tree. `--shard k/n` divides the mutant
list; it does not divide the tree. Two shards started in one checkout would take turns rewriting
the same files and scoring each other's mutations, and the result would look like an ordinary
survivor list rather than nonsense — so the harness writes `.mutate-lock` and refuses to start
beside another run. Shards need a copy of the checkout each:

```sh
for shard in 1 2 3 4; do
  rsync -rlt --chmod=D755,F644 --exclude='node_modules/' --exclude='.git/' \
    --exclude='.mutate-lock' ./ "../weftdb-shard-$shard/"
  (cd "../weftdb-shard-$shard" && pnpm install)
done
# then, one per shard, on its own core budget:
(cd ../weftdb-shard-1 && node scripts/mutate.mjs --shard 1/4)
```

`pnpm install` has to run in each copy. pnpm's workspace links are absolute paths, so a copied
`node_modules` still resolves `weftdb` subpaths back to the original tree — every mutant would
then be measured against unmutated sources and survive. The harness refuses to start when it
finds such a link, which catches the mistake but does not repair it.

Shards are interleaved rather than sliced into blocks, because survivors cluster in regions the
tests never look at and contiguous blocks would hand one shard every expensive mutant. To
combine the results, take the union of the survivor lists and sum the detected and total counts;
averaging the per-shard scores is only right when the shards came out the same size.

### Reading the result

Each mutant is reported as `killed` (a test failed), `TIMEOUT` (the mutant hung a wave, which
counts as a detection), or `SURVIVED`. The survivors are listed again at the end with their file,
line, operator and replacement. A survivor is a claim about the tests, not about the code: it
says the suite cannot tell the difference between this source and a changed one. Some are
equivalent mutants that no test could distinguish; the rest are gaps.

## Entry Points

Check package entry points:

```sh
pnpm build
```

When working from a `/mnt/...` workspace, run `pnpm` through PowerShell as required by the
local agent instructions:

```sh
powershell.exe pnpm typecheck
```
