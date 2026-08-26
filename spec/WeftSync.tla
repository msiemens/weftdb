-------------------------------- MODULE WeftSync --------------------------------
(***************************************************************************)
(* The row-lifecycle half of the weftdb sync protocol: local writes held in *)
(* an outbox, push with the rejections that can follow, delete and restore  *)
(* on the liveness register, incremental pull against a server sequence     *)
(* counter, snapshot resync, quarantine and its repair, and tombstone       *)
(* pruning with a floor.                                                    *)
(*                                                                          *)
(* Field values are not carried. What is carried is the delivery of a       *)
(* field write's outcome: the stamp on a write either beats the stored one  *)
(* or does not, and a device whose write lost has to be told. Per-field     *)
(* merge is a join-semilattice, and a semilattice converges only once every *)
(* replica has seen the winning value; a loser that is acknowledged and     *)
(* never told performs no join at all. Delivery is what a sync protocol is  *)
(* answerable for, so `superseded` tracks which devices are holding a value *)
(* the scope has moved past, and FieldConsistent says a device that has     *)
(* caught up is holding none. The arithmetic of the join is left out:       *)
(* which of two stamps wins is a clock comparison, and both answers are     *)
(* reachable here as separate steps.                                        *)
(*                                                                          *)
(* Three constants model fixes, so the specification can be shown to fail   *)
(* without them (WeftSyncBuggy.cfg, WeftSyncRacyPrune.cfg,                  *)
(* WeftSyncSilentLoss.cfg):                                                 *)
(*                                                                          *)
(*   PullChecksFloor  a device whose cursor is below the floor must resync  *)
(*                    rather than pull. Without it, a purged row strands on *)
(*                    the device: TLC finds it in five steps.               *)
(*                                                                          *)
(*   FloorRisesFirst  pruning raises the floor before removing records.     *)
(*                    Without it, a pull landing between the two steps sees *)
(*                    the records already gone and the floor still low, and *)
(*                    strands the row even though the floor check is on.    *)
(*                                                                          *)
(*   AckReportsSupersession                                                 *)
(*                    the ack for a field write that lost carries the       *)
(*                    record that beat it, so the pushing device learns at  *)
(*                    the moment it is told the push was taken. Without it, *)
(*                    the loser is acknowledged, drops the op from its      *)
(*                    outbox, and keeps a value no pull will ever carry     *)
(*                    away: a losing write leaves the stored record where   *)
(*                    it was, below that device's cursor, so no incremental *)
(*                    batch mentions the field again.                       *)
(***************************************************************************)
EXTENDS Naturals, TLC

CONSTANTS
    Devices,          \* symmetric set of device identifiers
    Rows,             \* symmetric set of row identifiers
    MaxSeq,           \* bound on the server sequence counter, to keep the space finite
    PullChecksFloor,  \* TRUE models the shipped pull path
    FloorRisesFirst,  \* TRUE models the shipped prune order
    AckReportsSupersession  \* TRUE models an ack that names the record a losing write lost to

VARIABLES
    serverState,      \* Rows -> {"absent", "live", "deleted"}
    serverRowSeq,     \* Rows -> the sequence number of that row's latest record
    serverSeq,        \* the scope's monotonic counter
    fieldSeq,         \* Rows -> the sequence number of that row's stored field record, 0 for none
    floor,            \* tombstone_floor_seq
    purging,          \* rows whose records have been removed but whose floor has not risen
    cursor,           \* Devices -> last_server_seq
    view,             \* Devices -> Rows -> what that device believes
    superseded,       \* Devices -> Rows -> holding a field value the scope has moved past
    outbox,           \* Devices -> Rows -> the unsent local op, if any
    quarantined,      \* Devices -> Rows -> local work the server refused
    resyncing,        \* Devices -> discarded local work, waiting for a snapshot to re-derive
    purgeSeq          \* Rows -> the record a purge was started against

vars == <<serverState, serverRowSeq, serverSeq, fieldSeq, floor, purging, purgeSeq, cursor, view,
          superseded, outbox, quarantined, resyncing>>

RowStates == {"absent", "live", "deleted"}
Ops == {"none", "create", "write", "delete", "restore"}

TypeOK ==
    /\ serverState \in [Rows -> RowStates]
    /\ serverRowSeq \in [Rows -> 0..MaxSeq]
    /\ serverSeq \in 0..MaxSeq
    /\ fieldSeq \in [Rows -> 0..MaxSeq]
    /\ floor \in 0..MaxSeq
    /\ purging \subseteq Rows
    /\ cursor \in [Devices -> 0..MaxSeq]
    /\ view \in [Devices -> [Rows -> RowStates]]
    /\ superseded \in [Devices -> [Rows -> BOOLEAN]]
    /\ outbox \in [Devices -> [Rows -> Ops]]
    /\ quarantined \in [Devices -> [Rows -> BOOLEAN]]
    /\ purgeSeq \in [Rows -> 0..MaxSeq]
    /\ resyncing \in [Devices -> BOOLEAN]

Init ==
    /\ serverState = [r \in Rows |-> "absent"]
    /\ serverRowSeq = [r \in Rows |-> 0]
    /\ serverSeq = 0
    /\ fieldSeq = [r \in Rows |-> 0]
    /\ floor = 0
    /\ purging = {}
    /\ cursor = [d \in Devices |-> 0]
    /\ view = [d \in Devices |-> [r \in Rows |-> "absent"]]
    /\ superseded = [d \in Devices |-> [r \in Rows |-> FALSE]]
    /\ outbox = [d \in Devices |-> [r \in Rows |-> "none"]]
    /\ quarantined = [d \in Devices |-> [r \in Rows |-> FALSE]]
    /\ purgeSeq = [r \in Rows |-> 0]
    /\ resyncing = [d \in Devices |-> FALSE]

Max(a, b) == IF a > b THEN a ELSE b

(***************************************************************************)
(* Local work. A device edits its own copy and queues the op; nothing       *)
(* reaches the server until it pushes. A row already holding unsent work    *)
(* keeps one op for simplicity — enough to make it dirty, which is what the *)
(* protocol keys off.                                                       *)
(***************************************************************************)
(***************************************************************************)
(* A row whose earlier work is quarantined can still be edited: quarantine  *)
(* surfaces the divergence for the user to resolve, it does not freeze the  *)
(* row.                                                                     *)
(*                                                                          *)
(* The client queues operations per row; this model carries one. A row with  *)
(* something already pending therefore takes no further local operation      *)
(* here, and trace validation only records histories that respect that.      *)
(***************************************************************************)
Idle(d, r) == outbox[d][r] = "none"

LocalCreate(d, r) ==
    /\ Idle(d, r)
    /\ view[d][r] = "absent"        \* the client refuses to create over a local tombstone
    /\ view' = [view EXCEPT ![d][r] = "live"]
    /\ outbox' = [outbox EXCEPT ![d][r] = "create"]
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, fieldSeq, floor, purging, cursor,
                   superseded, quarantined, purgeSeq, resyncing>>

LocalWrite(d, r) ==
    /\ Idle(d, r)
    /\ view[d][r] = "live"
    /\ outbox' = [outbox EXCEPT ![d][r] = "write"]
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, fieldSeq, floor, purging, cursor, view,
                   superseded, quarantined, purgeSeq, resyncing>>

LocalDelete(d, r) ==
    /\ Idle(d, r)
    /\ view[d][r] = "live"
    /\ view' = [view EXCEPT ![d][r] = "deleted"]
    /\ outbox' = [outbox EXCEPT ![d][r] = "delete"]
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, fieldSeq, floor, purging, cursor,
                   superseded, quarantined, purgeSeq, resyncing>>

LocalRestore(d, r) ==
    /\ Idle(d, r)
    /\ view[d][r] = "deleted"
    /\ view' = [view EXCEPT ![d][r] = "live"]
    /\ outbox' = [outbox EXCEPT ![d][r] = "restore"]
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, fieldSeq, floor, purging, cursor,
                   superseded, quarantined, purgeSeq, resyncing>>

(***************************************************************************)
(* Push. Accepting drains the outbox entry; rejecting moves it to           *)
(* quarantine, which is never retried on its own. Pushing does not advance  *)
(* the cursor — only applying a pull does.                                  *)
(*                                                                          *)
(* An accepted field write has two outcomes, and they are separate steps    *)
(* because the protocol has to be right under both: the stamp beats the     *)
(* stored one, or it does not. Acceptance does not decide it. A rejection   *)
(* is the server refusing the operation and is a third thing again — that   *)
(* one the device is told about, and quarantine is where it lands.          *)
(***************************************************************************)
Accepts(r, op) ==
    CASE op = "create"  -> serverState[r] = "absent"
      [] op = "write"   -> serverState[r] # "absent"      \* a set may land on a tombstone
      [] op = "delete"  -> serverState[r] # "absent"
      [] op = "restore" -> serverState[r] # "absent"
      [] OTHER          -> FALSE

\* Reached only for the three operations that address the liveness register.
Applied(r, op) ==
    CASE op = "create"  -> "live"
      [] op = "delete"  -> "deleted"
      [] op = "restore" -> "live"
      [] OTHER          -> serverState[r]

(***************************************************************************)
(* A row-level change moves the row's record, and an incremental pull       *)
(* carries it to every device whose cursor sits below it.                   *)
(***************************************************************************)
RegisterMoves(d, r) ==
    /\ serverSeq' = serverSeq + 1
    /\ serverState' = [serverState EXCEPT ![r] = Applied(r, outbox[d][r])]
    /\ serverRowSeq' = [serverRowSeq EXCEPT ![r] = serverSeq + 1]
    /\ outbox' = [outbox EXCEPT ![d][r] = "none"]
    /\ UNCHANGED <<fieldSeq, superseded, quarantined>>

(***************************************************************************)
(* A field write that beats the stored stamp advances the scope counter —   *)
(* the two ranges share it (§5.6) — and stores a record at that number,     *)
(* while leaving the row's own record where it was: an incremental pull     *)
(* carries nothing about this row's liveness. Every other device is now     *)
(* holding a value the scope has moved past, and every one of them has a    *)
(* cursor below the new record, so the next pull each of them makes         *)
(* carries the winner.                                                      *)
(***************************************************************************)
WriteWins(d, r) ==
    /\ serverSeq' = serverSeq + 1
    /\ fieldSeq' = [fieldSeq EXCEPT ![r] = serverSeq + 1]
    /\ superseded' = [e \in Devices |-> [q \in Rows |->
                        IF q = r THEN e # d ELSE superseded[e][q]]]
    /\ outbox' = [outbox EXCEPT ![d][r] = "none"]
    /\ UNCHANGED <<serverState, serverRowSeq, quarantined>>

(***************************************************************************)
(* A field write that loses stores nothing: no record, no new sequence      *)
(* number. The transaction was valid and was received, so it is             *)
(* acknowledged all the same, and the device drains it from the outbox.     *)
(* The record that beat it keeps the number it already had, which is at or  *)
(* below the cursor of a device that had pulled before it wrote — so no     *)
(* later incremental batch mentions the field, and only the ack can carry   *)
(* the winner back.                                                         *)
(***************************************************************************)
WriteLoses(d, r) ==
    /\ fieldSeq[r] > 0                     \* there is a stored record to lose to
    /\ superseded' = [superseded EXCEPT ![d][r] = ~AckReportsSupersession]
    /\ outbox' = [outbox EXCEPT ![d][r] = "none"]
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, fieldSeq, quarantined>>

Quarantines(d, r) ==
    /\ outbox' = [outbox EXCEPT ![d][r] = "none"]
    /\ quarantined' = [quarantined EXCEPT ![d][r] = TRUE]
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, fieldSeq, superseded>>

Push(d, r) ==
    /\ outbox[d][r] # "none"
    /\ serverSeq < MaxSeq
    /\ IF ~Accepts(r, outbox[d][r])
       THEN Quarantines(d, r)
       ELSE IF outbox[d][r] = "write"
            THEN WriteWins(d, r) \/ WriteLoses(d, r)
            ELSE RegisterMoves(d, r)
    /\ UNCHANGED <<floor, purging, cursor, view, purgeSeq, resyncing>>

(***************************************************************************)
(* Repair. The user discards the quarantined work. The client cannot        *)
(* re-derive the row there and then — it has no server state in hand at     *)
(* that moment — so it marks itself for a resync and the next read fetches  *)
(* a snapshot. Between the two it holds a row it no longer has any claim    *)
(* to, which is why `Consistent` excuses a device that is resyncing.        *)
(***************************************************************************)
Repair(d, r) ==
    /\ quarantined[d][r]
    /\ quarantined' = [quarantined EXCEPT ![d][r] = FALSE]
    /\ resyncing' = [resyncing EXCEPT ![d] = TRUE]
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, fieldSeq, floor, purging, cursor, view,
                   superseded, outbox, purgeSeq>>

(***************************************************************************)
(* Pruning, in two steps so the window between them is reachable. With      *)
(* FloorRisesFirst the floor covers the rows before their records go, which *)
(* is the order the implementation uses; without it, records vanish while   *)
(* the floor still says an incremental pull would be enough.                *)
(***************************************************************************)
\* Removing a row's records takes its field records with them. Nothing is stored for that
\* field any more, so no device is behind on it.
Purge(r) ==
    /\ serverState' = [serverState EXCEPT ![r] = "absent"]
    /\ serverRowSeq' = [serverRowSeq EXCEPT ![r] = 0]
    /\ fieldSeq' = [fieldSeq EXCEPT ![r] = 0]
    /\ superseded' = [e \in Devices |-> [q \in Rows |->
                        IF q = r THEN FALSE ELSE superseded[e][q]]]

PruneStart(r) ==
    /\ serverState[r] = "deleted"
    /\ r \notin purging
    /\ purging' = purging \union {r}
    /\ purgeSeq' = [purgeSeq EXCEPT ![r] = serverRowSeq[r]]
    /\ IF FloorRisesFirst
       THEN /\ floor' = Max(floor, serverRowSeq[r])
            /\ UNCHANGED <<serverState, serverRowSeq, fieldSeq, superseded>>
       ELSE /\ Purge(r)
            /\ UNCHANGED floor
    /\ UNCHANGED <<serverSeq, cursor, view, outbox, quarantined, resyncing>>

(***************************************************************************)
(* Finishing a purge re-checks that nothing moved underneath it: the row is *)
(* still tombstoned, and still the same record the floor was computed from. *)
(* A restore in between takes the row back out of scope, and a delete after *)
(* a restore gives it a *newer* record than the floor covers — purging that *)
(* would strand it on any device whose cursor sits in between. The          *)
(* implementation gets this for free by pruning in one synchronous pass; a  *)
(* prune against a real database needs the check and the delete in one      *)
(* transaction.                                                             *)
(***************************************************************************)
PruneFinish(r) ==
    /\ r \in purging
    /\ purging' = purging \ {r}
    /\ purgeSeq' = purgeSeq
    /\ IF serverState[r] # "deleted" \/ serverRowSeq[r] # purgeSeq[r]
       THEN UNCHANGED <<serverState, serverRowSeq, fieldSeq, superseded, floor>>
       ELSE IF FloorRisesFirst
            THEN /\ Purge(r)
                 /\ UNCHANGED floor
            ELSE /\ floor' = Max(floor, serverRowSeq[r])
                 /\ UNCHANGED <<serverState, serverRowSeq, fieldSeq, superseded>>
    /\ UNCHANGED <<serverSeq, cursor, view, outbox, quarantined, resyncing>>

(***************************************************************************)
(* Reading. An incremental pull carries the records above the cursor; a     *)
(* purged row has no record, so it carries nothing about it. Rows the       *)
(* device holds unsent or quarantined work for are not overwritten — that   *)
(* divergence is surfaced, not erased.                                      *)
(***************************************************************************)
Holds(d, r) == outbox[d][r] # "none" \/ quarantined[d][r]

(***************************************************************************)
(* Local work the arriving batch contradicts is *moved* to quarantine, not  *)
(* skipped and left pushable: skipping alone would let the device drain its *)
(* outbox later and count as settled while still showing the row it never   *)
(* reconciled. Only rows the batch actually spoke about are affected — an   *)
(* incremental batch carries nothing at all about a row the server has no   *)
(* record for, so local work on it is untouched.                            *)
(***************************************************************************)
Surfacing(d, doomed) ==
    /\ quarantined' = [quarantined EXCEPT ![d] = [r \in Rows |-> IF r \in doomed THEN TRUE ELSE quarantined[d][r]]]
    /\ outbox' = [outbox EXCEPT ![d] = [r \in Rows |-> IF r \in doomed THEN "none" ELSE outbox[d][r]]]

\* Incremental: a tombstone the device had not seen, for a row it holds work on.
PulledOver(d) == {r \in Rows : Holds(d, r) /\ serverRowSeq[r] > cursor[d] /\ serverState[r] = "deleted"}

\* Snapshot: absence is authoritative too, so anything not live contradicts local work.
SnapshotOver(d) == {r \in Rows : Holds(d, r) /\ serverState[r] # "live"}

(***************************************************************************)
(* A batch carries the field records above the cursor as well as the row    *)
(* records, and a field record repairs a superseded value wherever the two  *)
(* meet. A device holding local work on the row is repaired too: field      *)
(* merge is by stamp and has nothing to say about the row's liveness, so    *)
(* the divergence `Holds` protects is not this one.                         *)
(*                                                                          *)
(* This is the line the defect turns on. A write that lost left the stored  *)
(* record's number where it was, and the loser's cursor is already at or    *)
(* above it, so `fieldSeq[r] > cursor[d]` is false for ever after and no    *)
(* batch ever repairs it.                                                   *)
(***************************************************************************)
IncrementalPull(d) ==
    /\ view' = [view EXCEPT ![d] =
         [r \in Rows |-> IF serverRowSeq[r] > cursor[d] /\ serverState[r] # "absent" /\ ~Holds(d, r)
                         THEN serverState[r]
                         ELSE view[d][r]]]
    /\ superseded' = [superseded EXCEPT ![d] =
         [r \in Rows |-> IF fieldSeq[r] > cursor[d] THEN FALSE ELSE superseded[d][r]]]
    /\ cursor' = [cursor EXCEPT ![d] = serverSeq]
    /\ Surfacing(d, PulledOver(d))
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, fieldSeq, floor, purging, purgeSeq, resyncing>>

\* A snapshot carries every field record the scope has, whatever its number, so it repairs
\* every superseded value at once. This is the only thing that repairs the defect today, and
\* nothing in the protocol makes a device take one.
Resync(d) ==
    /\ view' = [view EXCEPT ![d] = [r \in Rows |-> IF Holds(d, r) THEN view[d][r] ELSE serverState[r]]]
    /\ superseded' = [superseded EXCEPT ![d] = [r \in Rows |-> FALSE]]
    /\ cursor' = [cursor EXCEPT ![d] = serverSeq]
    /\ resyncing' = [resyncing EXCEPT ![d] = FALSE]
    /\ Surfacing(d, SnapshotOver(d))
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, fieldSeq, floor, purging, purgeSeq>>

(***************************************************************************)
(* A read is a snapshot when the incremental stream cannot serve: below the *)
(* floor, or with discarded work waiting to be re-derived. Otherwise it is  *)
(* the incremental path. This is what the client's `sync` does.             *)
(***************************************************************************)
Pull(d) ==
    IF (PullChecksFloor /\ floor > cursor[d]) \/ resyncing[d] THEN Resync(d) ELSE IncrementalPull(d)

Next ==
    \/ \E d \in Devices, r \in Rows : LocalCreate(d, r)
    \/ \E d \in Devices, r \in Rows : LocalWrite(d, r)
    \/ \E d \in Devices, r \in Rows : LocalDelete(d, r)
    \/ \E d \in Devices, r \in Rows : LocalRestore(d, r)
    \/ \E d \in Devices, r \in Rows : Push(d, r)
    \/ \E d \in Devices, r \in Rows : Repair(d, r)
    \/ \E r \in Rows : PruneStart(r)
    \/ \E r \in Rows : PruneFinish(r)
    \/ \E d \in Devices : Pull(d)
    \* A client may take a snapshot whenever it likes — on cold open, say — not only when
    \* the incremental path cannot serve. Fairness is stated per device on Pull, so an
    \* always-enabled action here no longer lets the liveness property pass for free.
    \/ \E d \in Devices : Resync(d)

(***************************************************************************)
(* Fairness is per device and per row rather than on the whole next-state   *)
(* relation. Global fairness would let the system satisfy a liveness        *)
(* property by taking unrelated steps forever, which proves nothing about   *)
(* any particular device catching up.                                       *)
(***************************************************************************)
Fairness ==
    /\ \A d \in Devices : WF_vars(Pull(d))
    /\ \A d \in Devices, r \in Rows : WF_vars(Push(d, r))
    /\ \A d \in Devices, r \in Rows : WF_vars(Repair(d, r))

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* Safety. A device that has caught up agrees with the server about which   *)
(* rows are live — except where it is holding local work the server has not *)
(* taken, which the protocol deliberately keeps rather than overwriting     *)
(* (§5.7, §5.5). "Deleted" and "absent" are both simply not live: a device  *)
(* may remember a tombstone the server has already purged.                  *)
(***************************************************************************)
CaughtUp(d) == cursor[d] = serverSeq /\ ~resyncing[d]

Settled(d, r) == ~Holds(d, r)

Consistent ==
    \A d \in Devices :
        CaughtUp(d) => \A r \in Rows :
            Settled(d, r) => ((view[d][r] = "live") <=> (serverState[r] = "live"))

(***************************************************************************)
(* The same claim for field values. A device that has caught up is holding  *)
(* no value the scope has moved past: everything it wrote either won, or it *)
(* has since been handed what beat it.                                      *)
(*                                                                          *)
(* There is no `Settled` here. Unsent and quarantined work are divergences  *)
(* the device knows about, which is why `Consistent` excuses them. A write  *)
(* that was pushed, lost and acknowledged is a divergence the device does   *)
(* not know about: it has an empty outbox, nothing in quarantine, a cursor  *)
(* at the head, and a value the scope does not have. Nothing it can do on   *)
(* its own will tell it, so there is nothing here to excuse.                *)
(***************************************************************************)
FieldConsistent ==
    \A d \in Devices :
        CaughtUp(d) => \A r \in Rows : ~superseded[d][r]

(***************************************************************************)
(* "Quarantined work is never auto-retried" is a property of the transition *)
(* that quarantines it — `Surfacing` moves the operation out of the outbox  *)
(* rather than copying it — and not something a state predicate can say     *)
(* here. A row may hold a quarantined operation and a freshly queued one at *)
(* the same time, because quarantine surfaces a divergence for the user     *)
(* without freezing the row, and this model carries one slot per row so the *)
(* two are indistinguishable in any single state.                          *)
(***************************************************************************)

(***************************************************************************)
(* Liveness. Once devices keep pulling, pushing and repairing, the fleet    *)
(* stops disagreeing and stays that way — about which rows are live, and    *)
(* about what is in their fields. The second half is what a device that     *)
(* pushed a losing write fails: it keeps its own value for ever.            *)
(***************************************************************************)
EventuallyConsistent == <>[](Consistent /\ FieldConsistent)

(***************************************************************************)
(* Devices and rows are interchangeable, so the safety-only configurations  *)
(* may fold permutations together. The liveness configuration may not:      *)
(* symmetry reduction is unsound for temporal properties.                   *)
(***************************************************************************)
Symmetry == Permutations(Devices) \union Permutations(Rows)
=============================================================================
