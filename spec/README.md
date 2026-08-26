# Specification

`WeftSync.tla` is a TLA+ model of the row lifecycle: local writes held in an outbox, push
with the rejections that can follow, quarantine and its repair, delete and restore on the
liveness register, incremental pull against the server sequence counter, snapshot resync, and
tombstone pruning with a floor.

Field values themselves are not carried. What is carried is the *delivery* of a field write's
outcome. A write's stamp either beats the stored one or it does not; the model reaches both
answers as separate steps, tracks which devices are left holding a value the scope has moved
past, and asks whether they are ever told. Per-field merge is a join-semilattice, but a
semilattice converges only once every replica has seen the winning value, and a loser that is
acknowledged and never told performs no join at all. The arithmetic of the join is left to the
lattice; whether the loser hears about it is a protocol question, and it is asked here.

**Safety, rows**: a device that has caught up agrees with the server about which rows are
live, except for rows it holds unsent or quarantined work for — divergence the protocol
deliberately surfaces rather than overwrites (§5.5, §5.7) — and except while it is waiting to
resync after discarding quarantined work.

**Safety, fields**: a device that has caught up holds no field value the scope has moved past
(`FieldConsistent`). There is no exemption for local work here. Unsent and quarantined work
are divergences the device knows about, which is why the row-level invariant excuses them. A
write that was pushed, lost the stamp comparison and was
acknowledged anyway is a divergence the device does not know about: empty outbox, nothing
quarantined, cursor at the head, and a value the scope does not have.

**Liveness**: devices that keep pulling, pushing and repairing stop disagreeing and stay that
way (`<>[](Consistent /\ FieldConsistent)`), under fairness stated per device and per row
rather than on the next-state relation as a whole. That distinction is the difference between
a property with teeth and one that passes on a protocol known to be broken.

## Checking it

TLA+ ships as `tla2tools.jar`, and `tlc` is a launcher installed separately, so the jar is what most
machines have. Either works:

```sh
alias tlc='java -cp ~/.local/lib/tlaplus/tla2tools.jar tlc2.TLC'
```

`tests/trace-validation.test.ts` looks for that path on its own, and takes `WEFT_TLA_JAR` for a jar
elsewhere or `WEFT_TLC` for a launcher. Without one it skips, which is silent, so check that it says
it ran before believing the specification and the implementation still agree.

```sh
tlc -config spec/WeftSync.cfg spec/WeftSync.tla                  # safety, full model
tlc -config spec/WeftSyncLiveness.cfg spec/WeftSync.tla          # liveness, smaller bounds
tlc -config spec/WeftSyncBuggy.cfg spec/WeftSync.tla             # expected to fail
tlc -config spec/WeftSyncRacyPrune.cfg spec/WeftSync.tla         # expected to fail
tlc -config spec/WeftSyncSilentLoss.cfg spec/WeftSync.tla        # expected to fail
tlc -config spec/WeftSyncLivenessBuggy.cfg spec/WeftSync.tla     # expected to fail
```

| Configuration | Result |
|---|---|
| `WeftSync.cfg` (2 devices, 2 rows, MaxSeq 3) | 4,970,117 distinct states, no violation, ~5m |
| `WeftSyncLiveness.cfg` (2 devices, 1 row, MaxSeq 3) | 52,863 states, temporal property holds |
| `WeftSyncBuggy.cfg` | `Consistent` violated, as expected |
| `WeftSyncRacyPrune.cfg` | `Consistent` violated, as expected |
| `WeftSyncSilentLoss.cfg` (2 devices, 1 row, MaxSeq 3) | `FieldConsistent` violated at depth 8, as expected |
| `WeftSyncLivenessBuggy.cfg` | temporal property violated, as expected |

Modelling field delivery costs about 28% on the full safety configuration — it was 3,870,301
distinct states before `fieldSeq` and `superseded` — and about 31% on liveness, where it was
40,364. The search depth does not move. That is cheap because neither variable is a value
domain: `fieldSeq` reuses the sequence numbers already bounded by `MaxSeq`, and `superseded`
is one bit per device per row.

Liveness runs at smaller bounds because temporal checking re-explores the space looking for
cycles; symmetry reduction, which the safety-only configurations use, is unsound for temporal
properties.

## The configurations that are supposed to fail

A specification that cannot fail proves nothing, so three modelled fixes can be switched off:

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

**`AckReportsSupersession = FALSE`** — the push path when the ack for a field write says only
that the transaction was taken. TLC finds it in eight states: `d1` creates a row and pushes,
writes a field and pushes it, and that write wins and stores a record at sequence 2. `d1`
writes the field again, pulls — its cursor is now 2 — and pushes, and this time the stamp
loses. The server stores nothing, no record and no new sequence number, and acknowledges the
transaction anyway, because it was valid and it arrived. `d1` drops the acknowledged op from
its outbox and keeps the value it wrote. The record that beat it still sits at sequence 2, at
`d1`'s cursor, so no incremental batch will ever mention that field again. `d1` is caught up,
holds nothing pending, and holds a value the scope does not have.

Only a snapshot repairs that, and nothing in the protocol makes a device take one. The fix
this models is the one `applyField` is placed to make: it holds the record that beat the
write, so the ack carries that record back and the client applies it at the moment it is told
the push succeeded.

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

It also does not yet record `fieldSeq` or `superseded`. Its generated module names the
specification's constants and variables explicitly, so those two and `AckReportsSupersession`
have to be declared there before the INSTANCE resolves at all, and until the recorder emits
them the implementation's field-delivery behaviour is unchecked against this model.

### What the field half leaves out

The model says which devices are behind on a field. It never says what any of them holds:

- **No value domain, and no stamp domain.** That the higher stamp wins, that ties break the
  same way everywhere, that the value stored is the value sent — none of it is checked here.
  `superseded` is a single bit meaning "behind", and the join itself is taken on trust.
- **Which of two writes wins is a free choice.** Every accepted field write on a row that
  already has a record reaches both outcomes, because the comparison is between clocks this
  model does not carry. Real HLCs forbid some of those behaviours — a device's own successive
  writes have increasing stamps, so it cannot lose to a record it wrote itself. The model
  explores them anyway. It over-approximates, which keeps a clean run meaningful and means a
  counterexample has to be read to check it is realisable.
- **One field per row.** `fieldSeq` is one record. A transaction whose write to one field wins
  while its write to another loses is not distinguishable from either outcome alone.
- **Certified writes are not modelled.** A write carrying a `baseHash` fast-forwards whatever
  its stamp says (§5.4), so a lower stamp reaches storage on that path by design. Here every
  accepted write faces the comparison, and that branch is never taken.
- **`merge_required` is not a distinct answer.** The server can refuse a set by handing back
  its own value; the model has one refusal, and it goes to quarantine.
- **Restore does not replay fields.** The implementation gives a restored row's retained
  fields fresh sequence numbers, which is a second path by which a superseded value could be
  repaired. The model leaves the field record's number where it was, so it under-counts the
  ways a superseded value gets fixed and never over-counts them.
- **A purge clears the flag.** Removing a row's records takes its field records with them, and
  the model then says no device is behind on that field. Whether a device is still showing a
  purged row is a row-level question, and `Consistent` is what answers it.

Read the four together: TLA+ for the protocol's shape, trace validation for the link to the
code, `tests/exhaustive-model.test.ts` for every reachable state of a small real world, and
the fast-check suite for large random histories.
