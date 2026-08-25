---
title: Row lifecycle
description: Delete, restore, prune, and why the two registers are independent.
sidebar:
  order: 4
---

Deletion in weftdb is tracked in a row-level register, separate from the per-field merge that
resolves ordinary edits. A delete-wins rule and per-field merge would contradict each other if a
delete had to be compared against a field's own history. The relay would need to decide, for every
field, whether a tombstone or a later edit should win. Keeping deletion in its own register removes
that comparison entirely.

## The liveness register

On the relay, each row carries two columns beside its field data: `deleted_hlc` and
`register_hlc`. `deleted_hlc` is `NULL` for a live row and holds a hybrid logical clock (HLC)
reading for a tombstoned one. `register_hlc` is the highest HLC reading ever written to either
column by a `delete` or a `restore`. [Clocks](/concepts/clocks/) covers how an HLC reading is built
and compared. A `delete` writes both columns when its own HLC exceeds the row's current
`register_hlc`; a `restore` does the same, except it clears `deleted_hlc` back to `NULL`. Neither
operation touches the field values stored for the row. The `RowRecord` type names the pair
`deletedHlc` and `registerHlc`:

```ts
import type { RowRecord } from "weftdb/server";

// deletedHlc: null for a live row, an HLC reading for a tombstoned one.
// registerHlc: the highest HLC ever written to either field, by a delete or a restore.
type LivenessRegister = Pick<RowRecord, "deletedHlc" | "registerHlc">;
```

Leaving field values in place is what lets a restore return a complete row rather than a partial
one. If a delete removed field values immediately, a device reconnecting after a restore and
pushing one changed field would recreate the row holding only that field. Every other field the row
once had would be gone. A restore also re-stamps the sequence number of every field the row still
holds, so a device catching up with an incremental pull receives the row whole rather than empty.
[Architecture](/concepts/architecture/) covers why current-state storage keeps no other historical
record, and why a tombstone is the one exception.

## Operation kinds

Every mutation a device sends reaches the relay as an operation tagged `create`, `set`, `delete`,
`restore`, or `append`, and there are no others. [The push and pull
exchange](/concepts/sync-protocol/) covers how an operation travels from device to relay; the
table below covers what the relay does with each kind once it arrives.

| Operation | Relay behaviour                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`  | Rejected as `row_exists` if the row is already known, live or tombstoned; otherwise inserts the row and records its first-seen time                        |
| `set`     | Rejected as `row_absent` if the relay holds no row record at all; otherwise applies field by field, by HLC comparison, never touching `deleted_hlc`        |
| `delete`  | Applies to the register only if its HLC exceeds `register_hlc`, setting `deleted_hlc` and `register_hlc`; leaves fields untouched                          |
| `restore` | Applies to the register only if its HLC exceeds `register_hlc`, clearing `deleted_hlc`, stamping `register_hlc`, and re-stamping the row's retained fields |
| `append`  | Creates a row of the append-only class; rejected as `row_exists` if the row already exists                                                                 |

## The append-only exception

A row created by `append` still needs field values, which the ordinary rule for `set` would
forbid, since that rule requires the row to already exist. The relay resolves this by scoping the
exception to one transaction: a `set` targeting an append-only row is accepted only when it carries
the same transaction id as the row's own `append` operation. Every later operation against that
row, `set`, `delete`, or `restore` alike, is rejected as `append_class_violation`, whichever device
sends it. A row created this way is written once, atomically, and immutable from the next
transaction on, matching what `S.eventLog()` promises to a schema that declares one.

## Consequences of independence

The register and the field values are tracked separately, which shapes the relay's behaviour:

- A late field write does not resurrect a deleted row. Applying `set` never reads or compares
  `deleted_hlc`, so a device that pushes an edit after missing a delete updates the field; the
  row's register, and therefore its visibility, does not move.
- A late write is not silently lost either. On a pull, a device that still holds unsent edits for a
  row it finds tombstoned moves those edits to [quarantine](/guides/handling-conflicts/) instead of
  dropping them. An interface then decides whether to restore or discard them.
- Concurrent `delete` and `restore` converge on one outcome regardless of the order the two
  operations arrive in, because both compare against the same `register_hlc` and the higher HLC
  always wins.

## Purge and the `row_absent` rejection

A tombstoned row is not kept forever. [Retention and deletion](/guides/retention-and-deletion/)
covers pruning as an operation an application schedules. On the relay itself, pruning a row deletes
its row record and every field row stored for it, together, and advances the scope's tombstone
floor to cover the sequence number the row last held. After that point the relay holds no record
that the row id was ever used.

That is exactly why a `set` against an absent row has to be rejected rather than treated as an
implicit create. Without the rejection, two kinds of device could recreate a purged row from a
single field write. One is a device whose cursor sits below the tombstone floor: its next handshake
forces a snapshot resync, where the row's absence is authoritative rather than inferred. The other
is a device whose cursor sits above the floor but has not pulled since the row was deleted and
purged. It would otherwise push a `set` with no row record left for the relay to check it against.
`row_absent` closes both paths at once. The push is rejected outright, and the operation moves into
quarantine like any other rejection, instead of creating a new row under an id the relay holds no
record of.
