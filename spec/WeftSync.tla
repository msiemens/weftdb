-------------------------------- MODULE WeftSync --------------------------------
(***************************************************************************)
(* The row-lifecycle half of the weftdb sync protocol: local writes held in *)
(* an outbox, push with the rejections that can follow, delete and restore  *)
(* on the liveness register, incremental pull against a server sequence     *)
(* counter, snapshot resync, quarantine and its repair, and tombstone       *)
(* pruning with a floor.                                                    *)
(*                                                                          *)
(* Field values are absent on purpose. Per-field merge is a join-semilattice *)
(* and converges by construction; what does not converge by construction is  *)
(* the interaction between pruning, the incremental cursor, and local work   *)
(* that has not been pushed yet.                                             *)
(*                                                                          *)
(* Two constants model fixes, so the specification can be shown to fail      *)
(* without them (see WeftSyncBuggy.cfg and WeftSyncRacyPrune.cfg):           *)
(*                                                                          *)
(*   PullChecksFloor  a device whose cursor is below the floor must resync   *)
(*                    rather than pull. Without it, a purged row strands on  *)
(*                    the device: TLC finds it in five steps.                *)
(*                                                                          *)
(*   FloorRisesFirst  pruning raises the floor before removing records.      *)
(*                    Without it, a pull landing between the two steps sees  *)
(*                    the records already gone and the floor still low, and  *)
(*                    strands the row even though the floor check is on.     *)
(***************************************************************************)
EXTENDS Naturals, TLC

CONSTANTS
    Devices,          \* symmetric set of device identifiers
    Rows,             \* symmetric set of row identifiers
    MaxSeq,           \* bound on the server sequence counter, to keep the space finite
    PullChecksFloor,  \* TRUE models the shipped pull path
    FloorRisesFirst   \* TRUE models the shipped prune order

VARIABLES
    serverState,      \* Rows -> {"absent", "live", "deleted"}
    serverRowSeq,     \* Rows -> the sequence number of that row's latest record
    serverSeq,        \* the scope's monotonic counter
    floor,            \* tombstone_floor_seq
    purging,          \* rows whose records have been removed but whose floor has not risen
    cursor,           \* Devices -> last_server_seq
    view,             \* Devices -> Rows -> what that device believes
    outbox,           \* Devices -> Rows -> the unsent local op, if any
    quarantined,      \* Devices -> Rows -> local work the server refused
    resyncing,        \* Devices -> discarded local work, waiting for a snapshot to re-derive
    purgeSeq          \* Rows -> the record a purge was started against

vars == <<serverState, serverRowSeq, serverSeq, floor, purging, purgeSeq, cursor, view, outbox,
          quarantined, resyncing>>

RowStates == {"absent", "live", "deleted"}
Ops == {"none", "create", "write", "delete", "restore"}

TypeOK ==
    /\ serverState \in [Rows -> RowStates]
    /\ serverRowSeq \in [Rows -> 0..MaxSeq]
    /\ serverSeq \in 0..MaxSeq
    /\ floor \in 0..MaxSeq
    /\ purging \subseteq Rows
    /\ cursor \in [Devices -> 0..MaxSeq]
    /\ view \in [Devices -> [Rows -> RowStates]]
    /\ outbox \in [Devices -> [Rows -> Ops]]
    /\ quarantined \in [Devices -> [Rows -> BOOLEAN]]
    /\ purgeSeq \in [Rows -> 0..MaxSeq]
    /\ resyncing \in [Devices -> BOOLEAN]

Init ==
    /\ serverState = [r \in Rows |-> "absent"]
    /\ serverRowSeq = [r \in Rows |-> 0]
    /\ serverSeq = 0
    /\ floor = 0
    /\ purging = {}
    /\ cursor = [d \in Devices |-> 0]
    /\ view = [d \in Devices |-> [r \in Rows |-> "absent"]]
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
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, floor, purging, cursor, quarantined, purgeSeq, resyncing>>

LocalWrite(d, r) ==
    /\ Idle(d, r)
    /\ view[d][r] = "live"
    /\ outbox' = [outbox EXCEPT ![d][r] = "write"]
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, floor, purging, cursor, view, quarantined, purgeSeq, resyncing>>

LocalDelete(d, r) ==
    /\ Idle(d, r)
    /\ view[d][r] = "live"
    /\ view' = [view EXCEPT ![d][r] = "deleted"]
    /\ outbox' = [outbox EXCEPT ![d][r] = "delete"]
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, floor, purging, cursor, quarantined, purgeSeq, resyncing>>

LocalRestore(d, r) ==
    /\ Idle(d, r)
    /\ view[d][r] = "deleted"
    /\ view' = [view EXCEPT ![d][r] = "live"]
    /\ outbox' = [outbox EXCEPT ![d][r] = "restore"]
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, floor, purging, cursor, quarantined, purgeSeq, resyncing>>

(***************************************************************************)
(* Push. Accepting advances the counter and drains the outbox entry;        *)
(* rejecting moves it to quarantine, which is never retried on its own.     *)
(* Pushing does not advance the cursor — only applying a pull does.         *)
(***************************************************************************)
Accepts(r, op) ==
    CASE op = "create"  -> serverState[r] = "absent"
      [] op = "write"   -> serverState[r] # "absent"      \* a set may land on a tombstone
      [] op = "delete"  -> serverState[r] # "absent"
      [] op = "restore" -> serverState[r] # "absent"
      [] OTHER          -> FALSE

Applied(r, op) ==
    CASE op = "create"  -> "live"
      [] op = "delete"  -> "deleted"
      [] op = "restore" -> "live"
      [] OTHER          -> serverState[r]                  \* a write never moves the register

Push(d, r) ==
    /\ outbox[d][r] # "none"
    /\ serverSeq < MaxSeq
    /\ IF Accepts(r, outbox[d][r])
       THEN /\ serverSeq' = serverSeq + 1
            /\ serverState' = [serverState EXCEPT ![r] = Applied(r, outbox[d][r])]
            \* Only a row-level change moves the row's record. A field write advances the
            \* scope counter — the two ranges share it (§5.6) — but leaves the row record
            \* where it was, so an incremental pull carries nothing about that row's
            \* liveness, which is all this model tracks.
            /\ serverRowSeq' = IF outbox[d][r] = "write"
                               THEN serverRowSeq
                               ELSE [serverRowSeq EXCEPT ![r] = serverSeq + 1]
            /\ outbox' = [outbox EXCEPT ![d][r] = "none"]
            /\ UNCHANGED quarantined
       ELSE /\ outbox' = [outbox EXCEPT ![d][r] = "none"]
            /\ quarantined' = [quarantined EXCEPT ![d][r] = TRUE]
            /\ UNCHANGED <<serverState, serverRowSeq, serverSeq>>
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
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, floor, purging, cursor, view, outbox, purgeSeq>>

(***************************************************************************)
(* Pruning, in two steps so the window between them is reachable. With      *)
(* FloorRisesFirst the floor covers the rows before their records go, which *)
(* is the order the implementation uses; without it, records vanish while   *)
(* the floor still says an incremental pull would be enough.                *)
(***************************************************************************)
PruneStart(r) ==
    /\ serverState[r] = "deleted"
    /\ r \notin purging
    /\ purging' = purging \union {r}
    /\ purgeSeq' = [purgeSeq EXCEPT ![r] = serverRowSeq[r]]
    /\ IF FloorRisesFirst
       THEN /\ floor' = Max(floor, serverRowSeq[r])
            /\ UNCHANGED <<serverState, serverRowSeq>>
       ELSE /\ serverState' = [serverState EXCEPT ![r] = "absent"]
            /\ serverRowSeq' = [serverRowSeq EXCEPT ![r] = 0]
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
       THEN UNCHANGED <<serverState, serverRowSeq, floor>>
       ELSE IF FloorRisesFirst
            THEN /\ serverState' = [serverState EXCEPT ![r] = "absent"]
                 /\ serverRowSeq' = [serverRowSeq EXCEPT ![r] = 0]
                 /\ UNCHANGED floor
            ELSE /\ floor' = Max(floor, serverRowSeq[r])
                 /\ UNCHANGED <<serverState, serverRowSeq>>
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

IncrementalPull(d) ==
    /\ view' = [view EXCEPT ![d] =
         [r \in Rows |-> IF serverRowSeq[r] > cursor[d] /\ serverState[r] # "absent" /\ ~Holds(d, r)
                         THEN serverState[r]
                         ELSE view[d][r]]]
    /\ cursor' = [cursor EXCEPT ![d] = serverSeq]
    /\ Surfacing(d, PulledOver(d))
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, floor, purging, purgeSeq, resyncing>>

Resync(d) ==
    /\ view' = [view EXCEPT ![d] = [r \in Rows |-> IF Holds(d, r) THEN view[d][r] ELSE serverState[r]]]
    /\ cursor' = [cursor EXCEPT ![d] = serverSeq]
    /\ resyncing' = [resyncing EXCEPT ![d] = FALSE]
    /\ Surfacing(d, SnapshotOver(d))
    /\ UNCHANGED <<serverState, serverRowSeq, serverSeq, floor, purging, purgeSeq>>

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
(* stops disagreeing and stays that way.                                    *)
(***************************************************************************)
EventuallyConsistent == <>[]Consistent

(***************************************************************************)
(* Devices and rows are interchangeable, so the safety-only configurations  *)
(* may fold permutations together. The liveness configuration may not:      *)
(* symmetry reduction is unsound for temporal properties.                   *)
(***************************************************************************)
Symmetry == Permutations(Devices) \union Permutations(Rows)
=============================================================================
