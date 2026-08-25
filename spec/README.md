# Specification

`WeftSync.tla` is a TLA+ model of the row lifecycle: local writes held in an outbox, push
with the rejections that can follow, quarantine and its repair, delete and restore on the
liveness register, incremental pull against the server sequence counter, snapshot resync, and
tombstone pruning with a floor.

Field values are absent on purpose. Per-field merge is a join-semilattice and converges by
construction; what does not converge by construction is the interaction between pruning, the
incremental cursor, and local work that has not been pushed yet.

**Safety**: a device that has caught up agrees with the server about which rows are live,
except for rows it holds unsent or quarantined work for — divergence the protocol
deliberately surfaces rather than overwrites (§5.5, §5.7) — and except while it is waiting to
resync after discarding quarantined work.

**Liveness**: devices that keep pulling, pushing and repairing stop disagreeing and stay that
way (`<>[]Consistent`), under fairness stated per device and per row rather than on the
next-state relation as a whole. That distinction is the difference between a property with
teeth and one that passes on a protocol known to be broken.

## Checking it

```sh
tlc -config spec/WeftSync.cfg spec/WeftSync.tla                  # safety, full model
tlc -config spec/WeftSyncLiveness.cfg spec/WeftSync.tla          # liveness, smaller bounds
tlc -config spec/WeftSyncBuggy.cfg spec/WeftSync.tla             # expected to fail
tlc -config spec/WeftSyncRacyPrune.cfg spec/WeftSync.tla         # expected to fail
tlc -config spec/WeftSyncLivenessBuggy.cfg spec/WeftSync.tla     # expected to fail
```

| Configuration | Result |
|---|---|
| `WeftSync.cfg` (2 devices, 2 rows, MaxSeq 3) | 3,870,301 distinct states, no violation, ~4m30s |
| `WeftSyncLiveness.cfg` (2 devices, 1 row, MaxSeq 3) | 40,364 states, temporal property holds |
| `WeftSyncBuggy.cfg` | `Consistent` violated, as expected |
| `WeftSyncRacyPrune.cfg` | `Consistent` violated, as expected |
| `WeftSyncLivenessBuggy.cfg` | temporal property violated, as expected |

Liveness runs at smaller bounds because temporal checking re-explores the space looking for
cycles; symmetry reduction, which the safety-only configurations use, is unsound for temporal
properties.

## The configurations that are supposed to fail

A specification that cannot fail proves nothing, so two modelled fixes can be switched off:

**`PullChecksFloor = FALSE`** — the pull path as it was before it consulted the tombstone
floor. `d1` creates a row, `d2` pulls it, `d1` deletes it, a prune purges the tombstone and
lifts the floor past `d2`'s cursor, and `d2` pulls again. The purged row leaves no record
behind, so the batch says nothing about it while the cursor still advances to the head — `d2`
is now "caught up" while showing a row the server no longer has. That is the defect this
model was written for, and it was a real one.

**`FloorRisesFirst = FALSE`** — pruning that removes records before raising the floor. The
floor check on the pull path is still on, and TLC still finds a violation: a reader landing
between the two steps sees the records gone and the floor still low. The implementation
raises the floor first for exactly this reason. Single-threaded JavaScript cannot interleave
the two steps today, so this is a guard on the design rather than a live defect — it starts
mattering the moment prune runs against a real database or the server handles requests
concurrently.

`WeftSyncLivenessBuggy.cfg` does the same job for the temporal property: it asserts only
`TypeOK`, so the liveness property is what fails rather than safety failing first.

## Pruning is modelled in two steps

`PruneStart` and `PruneFinish` exist so the window between raising the floor and removing the
records is reachable, and `PruneFinish` re-checks that nothing moved underneath it: the row is
still tombstoned, and still the same record the floor was computed from. Both checks came
from counterexamples. A restore landing in between takes the row back out of scope, and a
delete after that restore gives it a *newer* record than the floor covers — purging it then
would strand it on any device whose cursor sits in between. The implementation gets this free
by pruning in one synchronous pass; a prune against a real database needs the check and the
delete in one transaction.

## What this does and does not cover

The model checks the protocol's state machine exhaustively at small bounds. On its own it
says nothing about the TypeScript implementation matching it — that link is
`tests/trace-validation.test.ts`, which records what the real client and server do and asks
TLC whether the specification allows that behaviour.

Trace validation found four places where the two disagreed, and in every case the
implementation was right and this specification was wrong: repair defers re-deriving the row
to the next sync rather than doing it immediately; a row with quarantined work can still be
edited; a field write advances the scope counter without moving the row's record; and a
client may take a snapshot whenever it likes, not only when the incremental path cannot
serve.

Trace validation covers single-transaction pushes only — the client's `flush` can send
several transactions across several rows in one call, which matches no single step of a
specification that models one operation per row. Batching is left to the model-checking
configurations, which explore it directly.

Read the four together: TLA+ for the protocol's shape, trace validation for the link to the
code, `tests/exhaustive-model.test.ts` for every reachable state of a small real world, and
the fast-check suite for large random histories.
