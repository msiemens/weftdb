---
title: Architecture
description: Two databases with different shapes, a schema-blind relay, and why snapshot resync is the primary recovery path.
sidebar:
  order: 1
---

A weftdb application runs two SQLite databases: one inside the device, one behind the relay. The
device's database holds typed tables generated from the schema. The relay's database holds a
single generic field store with no domain columns. Neither is a copy of the other. Sync between
the two compares field values only; it never compares table structure.

## Device and relay storage

The table below lists what each side stores, grouped by purpose:

| Storage                      | Device                                                                     | Relay                                               |
| ---------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| Typed columns per collection | `id`, `scope_id`, `created`, and the fields the schema declares            | none                                                |
| Field values                 | one column per field, one row per record                                   | one row per `(scope_id, table_name, row_id, field)` |
| Pending writes               | `outbox`, `outbox_quarantine`                                              | none                                                |
| Deletion record              | `tombstones` table                                                         | `deleted_hlc` and `register_hlc` columns on `rows`  |
| Per-field clock reading      | `_weft_hlc_<field>` column                                                 | `hlc` column on `fields`                            |
| diff3 ancestor value         | `_weft_base_<field>` column, only where a field is marked `merge: "diff3"` | none                                                |
| First-seen timestamp         | `_weft_first_synced_at`, copied from the relay                             | `first_seen_at`, source of truth                    |

The relay's `fields` table is keyed by `scope_id`, `table_name`, `row_id`, and `field`, so a value
is addressed the same way whatever schema, if any, produced it. Deletion and row-lifecycle state
live in a separate `rows` table, one row per record, keyed by `scope_id`, `table_name`, and
`row_id`.

## Device-only columns

Not all of what the device stores travels to the relay. Take a `notes` field on a `todos`
collection, declared `merge: "diff3"`. The device stores its value in an ordinary `notes` column,
its clock reading in `_weft_hlc_notes`, and the value it last synced with the relay in
`_weft_base_notes`. That base value belongs to one device: it is whichever version of `notes` this
device held at its own last sync. Another device's base can legitimately differ, because the two
devices did not necessarily sync at the same moment. Sending `_weft_base_notes` to the relay would
ask a store that holds no history to reconcile bases that only ever meant something on the device
that recorded them, so it stays there. Two further columns, `_weft_rev` and `_weft_dirty`, exist
for the same reason. They track when a row last changed and whether it still has unsent writes,
both facts about this device's own queue rather than about the record.

## Current field state

Neither database keeps a log of values. A device's `notes` column holds whatever `notes` currently
is. The relay's `fields` table holds one row per `(scope_id, table_name, row_id, field)`, and
writing a new value overwrites it in place rather than appending beside it. Each stored field row
is the field's current state.

Tombstones are the one historical record either database retains, and necessarily so: deleting a
record is a fact that current-state storage on its own cannot express. A row that is missing does
not say whether it was deleted or never existed. A device deletes by writing a row to
`tombstones`; the relay deletes by setting `deleted_hlc` on the row's entry in `rows`, without
removing the row record. The relay keeps a deleted row's field values in place after an ordinary
delete, so a restore can bring them back, until a separate prune step removes the row and its
fields together.

## Incremental pull and snapshot

Because storage only ever holds current state, the relay answers both kinds of pull request with
the same query, differing by one predicate. It answers an incremental pull with the field and row
records for a scope whose sequence number is higher than the device's last-known one. It answers a
snapshot with the field and row records for the scope, unfiltered by sequence number:

```sql
-- incremental pull
SELECT * FROM fields WHERE scope_id = ? AND server_seq > ?;

-- snapshot
SELECT * FROM fields WHERE scope_id = ?;
```

The `rows` table is filtered the same way. A device needs only one code path to apply either kind
of batch, because both arrive in the same shape.

## The schema-blind relay

None of what the relay does requires knowledge of an application's schema:

- authenticates the request
- checks that every operation's scope matches the scope the request is for
- checks that a write's clock reading is not further ahead of its own clock than a configured
  threshold
- applies the per-field merge rule between an incoming write and whatever value it already holds
- serves field and row ranges as shown above

Field values are opaque to the relay, compared only by clock reading and content hash.
[Merge model](/concepts/merge-model/) covers how that comparison resolves two edits to the same
field.

What looks like an exception to that is not one, and for a different reason in each case. The
relay refuses to let a write change `id`, `scope_id`, or `created` on a row that
already exists. Those three names are fixed by the framework itself, identical for every
application, so refusing to let them move requires no schema at all. The relay also tracks whether
a row belongs to an ordinary collection or an append-only one, rejecting further writes to the
second kind once it is set. It derives that distinction from the first operation it sees for that
row.

Because the relay never learns table or column shapes, adding a field to an application's schema
changes nothing it stores. Its tables are the same four, `fields`, `rows`, `scope_state`, and
`devices`, regardless of what any schema declares. There is no relay migration to write and none to
run, for any change to any collection.

## Snapshot resync

Because storage holds current state, a device that has been offline for any length of time can
still catch up incrementally and be correct about every value it pulls. Deletion is the one thing
incremental pull cannot recover from, which makes it the sole trigger for a full snapshot resync.
The relay purges a tombstoned row, together with its field records, 30 days after deletion by
default, raising the scope's tombstone floor to that row's sequence number. A device whose
last-known sequence number is below the floor cannot learn incrementally that the row is gone,
because the record that would have told it no longer exists. Handshake catches this before a pull
is attempted: a request below the floor receives `resync_required` instead of a sequence number to
pull from, and the device responds by applying a full snapshot. Below the floor, a row's absence
from that snapshot is the only signal left that it was deleted rather than never synced.
