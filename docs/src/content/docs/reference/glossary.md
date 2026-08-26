---
title: Glossary
description: Every term the documentation uses, defined once, with the page that covers it in full.
sidebar:
  order: 1
---

Each term is defined in one line here and covered in full on the page named beside it. Where a
definition and a page disagree, the page is correct.

| Term             | Meaning                                                                                                                                      | Covered by                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Artifact         | A file `weft generate` writes from a schema, such as the client SQL or the typed mutators.                                                   | [Generating artifacts](/guides/generating-artifacts/)     |
| Base fields      | `id`, `scope_id`, and `created`, added to every collection by the framework and refused to later writes by the relay.                        | [Defining a schema](/guides/defining-a-schema/)           |
| Cursor           | The sequence number a device last pulled, sent on every sync to ask for what came after it.                                                  | [The sync protocol](/concepts/sync-protocol/)             |
| Device           | One participant in sync, with its own outbox, clock, and cursor. Every tab of one browser profile is the same device.                        | [Architecture](/concepts/architecture/)                   |
| `diff3`          | A merge annotation that combines edits to different lines of one text field, leaving marker syntax where two devices changed the same lines. | [Merge model](/concepts/merge-model/)                     |
| Dirty            | A row with an unsent operation in the outbox or an entry in quarantine.                                                                      | [Handling conflicts](/guides/handling-conflicts/)         |
| Event log        | A collection declared with `S.eventLog()`, whose rows are written once and never edited, deleted, or restored.                               | [Defining a schema](/guides/defining-a-schema/)           |
| Field store      | The relay's single generic table, holding one row per scope, table, row id, and field.                                                       | [Architecture](/concepts/architecture/)                   |
| `fracIndex`      | A merge annotation that lets any device reorder rows by writing one rank, without renumbering the rows around it.                            | [Merge model](/concepts/merge-model/)                     |
| HLC              | Hybrid logical clock. A reading combining wall-clock time, a counter, and a device id, which every device compares the same way.             | [Clocks](/concepts/clocks/)                               |
| Merge annotation | The `merge` option on a field, deciding how two devices' edits to it combine.                                                                | [Merge model](/concepts/merge-model/)                     |
| Mirror           | The page's copy of the rows the storage worker last pushed, read by every generated hook.                                                    | [Storage on the device](/guides/device-storage/)          |
| Outbox           | The queue of writes a device has made and not yet pushed. It survives reload, and a write reaches it before anything reaches the network.    | [Writing data](/guides/writing-data/)                     |
| Quarantine       | Where a device puts work the relay refused, held with its reason instead of being discarded.                                                 | [Handling conflicts](/guides/handling-conflicts/)         |
| Rebase           | Reapplying a rejected `diff3` write against the value the relay now holds, then pushing the result.                                          | [The sync protocol](/concepts/sync-protocol/)             |
| Relay            | The server devices sync through. It stores their data and never learns their schema.                                                         | [Architecture](/concepts/architecture/)                   |
| Retention anchor | The field an expiry date is measured from, marked with `retentionAnchor` and read on the device.                                             | [Retention and deletion](/guides/retention-and-deletion/) |
| Row class        | Whether a row is ordinary or append-only, taken by the relay from the operation that created it.                                             | [Row lifecycle](/concepts/row-lifecycle/)                 |
| Schema hash      | A hash of the whole schema, exchanged on every sync so a device on a different schema is caught.                                             | [Schema changes](/guides/schema-changes/)                 |
| Scope            | The unit of sync and of authorization. Every row carries one, and access is scope equality and nothing finer.                                | [Scopes](/concepts/scopes/)                               |
| Snapshot resync  | Pulling a full copy of a scope, rather than what changed since a cursor.                                                                     | [Architecture](/concepts/architecture/)                   |
| Storage worker   | The one `SharedWorker` per origin holding every database that origin has open, and the sync session beside it.                               | [Storage on the device](/guides/device-storage/)          |
| Tombstone        | The record that a row was deleted, kept because absence alone cannot distinguish a deleted row from one that never existed.                  | [Row lifecycle](/concepts/row-lifecycle/)                 |
| Tombstone floor  | The sequence number below which tombstones have been pruned away, past which a device must take a snapshot.                                  | [Retention and deletion](/guides/retention-and-deletion/) |
| Transaction      | A group of operations carrying one `txn_id`, applied together or not at all.                                                                 | [The sync protocol](/concepts/sync-protocol/)             |
