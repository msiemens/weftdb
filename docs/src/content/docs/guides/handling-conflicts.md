---
title: Handling conflicts
description: The rejection taxonomy, quarantine, and the questions an interface must ask when a write cannot be applied.
sidebar:
  order: 10
---

A push can fail one transaction at a time, without the sync call itself throwing. The relay
accepts what it can and returns a rejection for the first transaction it cannot apply, together
with acknowledgements for whatever transactions succeeded before it. [Writing
data](/guides/writing-data/) covers how a write reaches the outbox.

## Rejecting a write

A rejection names its reason, carried on the operation the relay would not apply. Some reasons are
retried automatically. Every other rejection, and a retry that does not converge, moves the
operation into quarantine instead: dirty work the relay would not accept, kept aside for a person
to act on rather than dropped or retried without asking:

| Reason                   | The relay produces it when                                                                           | Automatic retry                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `clock_skew`             | An operation's clock reading is more than 5 minutes ahead of the relay's own clock                   | Restamped against the relay's clock, up to 3 times       |
| `merge_required`         | A [`diff3`](/concepts/merge-model/) field's write no longer matches the value the relay holds        | Rebased against the relay's current value, up to 3 times |
| `row_absent`             | A delete, restore, or set operation targets a row the relay has no record of                         | None                                                     |
| `row_exists`             | A create or append operation targets a row id the relay already holds                                | None                                                     |
| `scope_mismatch`         | An operation's [scope](/concepts/scopes/) does not match the scope the push was sent under           | None                                                     |
| `base_field_violation`   | A set operation targets `id`, `scope_id`, or `created` on a row the relay already holds              | None                                                     |
| `append_class_violation` | An operation other than the row's opening transaction targets an append-only row                     | None                                                     |
| `rebase_exhausted`       | A `diff3` rebase found nothing local to rebase against, or `merge_required` recurred past 3 attempts | None                                                     |
| `malformed_op`           | An operation's clock reading is not a stamp this protocol writes                                     | None                                                     |
| `schema_mismatch`        | The device's schema does not match the one the relay has accepted for the scope                      | Sync stops before any operation is pushed                |

`schema_mismatch` is decided during the handshake that opens a sync, before anything is pushed. It
stops the sync outright, so it never reaches quarantine.

A `merge_required` rejection that survives 3 rebase attempts, and a rebase that finds no local
base to work from, both reach quarantine recorded as `rebase_exhausted`. `merge_required` itself
is never the reason a device records there.

`row_absent` and `row_exists` both mean a device's view of whether a row exists has diverged from
the relay's. Each can arise two ways: as a rejection returned by the relay on push, or as
something a device notices on its own while applying a pull or a snapshot. In the second case, the
device finds a row missing from what the relay sent, or reported as deleted by the relay, while it
still holds unsent edits to that row. It quarantines that row's outbox entries the same way a
rejection would.

## Reading quarantine

`WeftClient.listQuarantine()` returns every quarantined operation, each carrying the reason it was
set aside for, the table and row it targets, and the value the relay held if the rejection
reported one.

A row counts as dirty if it has an unsent operation in the outbox, an entry in quarantine, or
both. `WeftClient.isRowDirty(tableName, rowId)` answers that question directly, and the generated
row type exposes the same answer as `_weft_dirty`, so a list of rows can mark each one without a
lookup per render:

```ts
import { rowId, tableName } from "weftdb/core";

const dirty = client.isRowDirty(tableName("tasks"), rowId("task-1"));
const reasons = client.listQuarantine().map((op) => op.reason);
```

Once whatever caused a rejection is believed fixed, `WeftClient.retryQuarantinedTxn(txnId)`
returns that transaction's operations to the outbox for the next sync to try again, and resolves
once the move has been stored. A field the device has written again since the rejection keeps the
later value, and the retried write for it is dropped. The outbox holds one write per field, and a
row shows the value that write carries. Nothing in quarantine retries on its own.

## Deciding a deleted row

The clearest case a person has to resolve is a `row_exists` rejection caused by a pull: a row was
deleted on another device while this one held unsent edits to it. A strict delete-wins rule would
drop those edits without asking, which on a device that opens rarely can mean months of unsynced
work disappearing the moment it reconnects. weftdb moves those edits to quarantine rather than
dropping them, and takes the deletion locally: the row is tombstoned and stops appearing in
queries, because the scope says it is gone and a row left visible would be visible on this device
alone. The edits remain in quarantine for the interface to act on. The question to ask is direct:
this entry was deleted on another device, and unsent edits to it are still here; keep them, or
take the deletion?

Keeping the edits calls `WeftClient.restore()`, which stamps a fresh `restore` operation with the
device's current [clock](/concepts/clocks/) reading. That reading is later than the deletion's,
because the device folded the deletion's clock reading into its own clock on the pull that
quarantined the row. A later reading wins a row's [delete-or-live
state](/concepts/row-lifecycle/) on the relay. Taking the deletion calls
`WeftClient.discardQuarantinedTxn()` for each quarantined transaction against the row, which drops
the outbox entries and requires a snapshot on the next sync, where the row will be absent:

```ts title="src/resolve-deletion.ts"
import { fieldName, rowId, tableName } from "weftdb/core";
import type { WeftClient } from "weftdb/client";

// keepEdits is the answer to the question the interface asked the person.
async function resolveDeletedWhileEditing(client: WeftClient, keepEdits: boolean): Promise<void> {
  const task = tableName("tasks");
  const id = rowId("task-1");
  if (keepEdits) {
    await client.restore(task, id, {
      [fieldName("title")]: "Write the quick start",
      [fieldName("notes")]: "",
      [fieldName("rank")]: "a0",
    });
    return;
  }
  for (const op of client.listQuarantine()) {
    if (op.rowId === id) await client.discardQuarantinedTxn(op.txnId);
  }
}
```

## Rendering merge markers

A `diff3` field's `merge_required` rejection resolves through the automatic rebase described
above: the device merges its edit with the value the relay held and resends it. Edits to different
lines merge cleanly, and reach the relay with nothing for an interface to show. Edits that touched
the same lines merge into marker syntax inside the text itself: `<<<<<<< WEFT_LOCAL`, a
`=======` separator, and `>>>>>>> WEFT_REMOTE` around the two versions. There is no stored record
of which rows are in that state. `hasConflictMarkers(value)` finds one by scanning a field's
current value. A device checks for markers when it opens a row rather than reading them from a
table of pending conflicts, because the text is already the one place the conflict is recorded.

An interface showing a marked field should display the text as it stands, both halves of the
marker included, rather than hiding one side or resolving it automatically. A person resolves a
marker by editing it out of the text, the same way as any other change to the field, and there is
nothing left to update once the markers are gone:

```ts
import { fieldName, hasConflictMarkers, rowId, tableName } from "weftdb/core";

const row = client.getRow(tableName("tasks"), rowId("task-1"));
const notes = row?.fields.get(fieldName("notes"));
const conflicted = typeof notes === "string" && hasConflictMarkers(notes);
```

## Handling clock skew

A `clock_skew` rejection means an operation's clock reading is more than 5 minutes ahead of the
relay's own clock. That gap is a property of the device's system clock. A device retries
automatically, re-stamping the operation against the relay's clock up to 3 times, so a brief,
small skew resolves before it reaches an interface at all.

A `clock_skew` entry that still reaches quarantine means those 3 retries did not converge, which
means the device's clock is not close to correct. There is nothing for the application to correct
in software: the interface can report which rows are affected and tell the person to check the
device's system clock, then call `retryQuarantinedTxn` once it is.
