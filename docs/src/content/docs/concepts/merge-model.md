---
title: Merge model
description: The five merge annotations, why each exists, and what happens when two devices disagree.
sidebar:
  order: 3
---

## Merge as a schema annotation

A field's `merge` option lives in the schema, not in the value a device reads or writes at
runtime. A `diff3` field is a plain `string`. A `fracIndex` field is a plain `string` holding a
rank. An `lww` field is whatever scalar the schema gives it: `string`, `number`, `boolean`, or a
date as ISO-8601 text. Neither the generated row type nor the wire value encodes an annotation into
a value's shape, so code reading or writing a field never has to know how it converges. Encoding
the annotation into the value's type instead would force every call site touching that field to
unwrap a merge-specific wrapper first.

```ts title="src/schema.ts"
import { defineSchema, S } from "weftdb/schema";

export const schema = defineSchema({
  tasks: S.collection({
    title: S.string(),
    notes: S.string({ merge: "diff3" }),
    rank: S.string({ merge: "fracIndex" }),
    external_ref: S.string({ merge: "immutable", nullable: true }),
  }),
  task_status_history: S.eventLog({
    status: S.string(),
    changed_at: S.date(),
  }),
});
```

## Last-writer-wins

`lww` is the default for a field with no `merge` option written. Each field carries a hybrid
logical clock (HLC) reading of when it was last written; the higher HLC wins.
[Clocks](/concepts/clocks/) covers how that reading is built and compared.

The comparison happens once per field, not once per row: the relay keeps a value and a stamp per
row-and-field pair, so two devices editing different fields of one record each keep their edit.
Only two writes to the same field compete, and only then does the later stamp decide. Choose `lww`
for a value where the later edit should replace the earlier one outright.

## Prose merge with diff3

A `diff3` field carries a base hash: the value's hash as this device last saw it, checked against
what the relay currently holds. A match is a certified successor, stored outright; a mismatch
returns `merge_required` with the relay's current value, and the device merges its own edit, the
field's ancestor, and that value locally. Same-length versions merge line by line, keeping
whichever side changed a line, or either side's version where both changed it alike. A line the two
sides changed differently is wrapped as `<<<<<<< WEFT_LOCAL`, the local line, `=======`, the remote
line, `>>>>>>> WEFT_REMOTE`. A line-count mismatch wraps the whole field the same way. The merge is
re-pushed with a fresh base hash, retried up to three times; a fourth `merge_required`, or no local
ancestor to merge against, quarantines the write as `rebase_exhausted`. [Handling
conflicts](/guides/handling-conflicts/) covers presenting markers to a person.

`diff3` is chosen over `lww` for prose because `lww` discards one entire edit outright: two devices
editing the same note while apart end up, after sync, with only the later device's version. Edits
touching different lines merge without producing markers, the common outcome for one author on two
devices; edits touching the same lines produce markers instead of a loss. `diff3` merges on sync,
not on every keystroke, so two people typing into the same field at once falls outside it.

A device finds a conflicted field by scanning its text for marker syntax with
`hasConflictMarkers`, rather than reading a stored record of which fields are in conflict; neither
the relay nor the device keeps one. The merged text is already the one place a conflict is
recorded, and a second record of it could fall out of step with the text once the field is edited
again.

## Fractional index ordering

A `fracIndex` field holds a rank string such as `aU:d7f2`: a core built from an ordered alphabet, a
`:` separator, and the id of the device that generated it. `rankBetween` builds a new rank strictly
between two existing ones, or before the first or after the last when a bound is left out. Two
devices inserting into the same gap can independently compute the same core. The device id after
the separator keeps the two ranks apart, orders them the same way everywhere, and still leaves room
for a later insert to land between them.

Ordering by a `fracIndex` field is a plain ascending sort on that column, and reordering a list
means writing one rank rather than renumbering the rows around it. That holds only because of two
constraints on the alphabet. Every character in it sorts above the `:` separator, because a rank
whose core prefixes another's has to compare correctly once the device suffix is appended.
Otherwise, a short core with a low suffix character could sort after the longer core it should
precede. No core ends in the alphabet's first character, guaranteeing room below a core's last
character, so a new rank can always be inserted immediately before an existing one.

The device suffix sits inside the rank's value, not a second column, so rewriting a rank can never
touch it: the old tiebreak stays intact as the core around it changes.

## Append-only collections

A collection declared with `S.eventLog()` rather than `S.collection()` is append-only:
`client.append()` creates a row, and the relay accepts no `set`, `delete`, or `restore` against it
outside the creating transaction, rejecting a later attempt as `append_class_violation`. There is
no tombstone register for these rows, since nothing ever removes one, and retention never reaps
them.

Insert-only enforcement is what makes convergence free here. An ordinary row can receive edits from
more than one device, so applying it means comparing HLCs, or running a rebase, for every field a
write touches. An append-only row is written exactly once, so there is never a second write to
reconcile, and two devices creating different rows never collide, since each chooses its own row
id. Choose `S.eventLog()` for events that stand alone once created, such as a task's status
history.

Insert-only applies to a whole collection rather than to one field, because the relay enforces it
from the row's class and takes that class from the operation that created the row. A per-field
version would need the relay to combine two values instead of choosing between them, which means
knowing that a value is a list, and a schema-blind relay cannot know that.

## Immutable fields

Every collection carries three fields the relay treats as immutable: `id`, `scope_id`, and
`created`. A `set` against any of them is accepted within the transaction that creates the row, and
rejected as `base_field_violation` after that. The relay knows these three names as protocol-level
knowledge, independent of any schema.

A field marked `merge: "immutable"` in an application's own schema is enforced differently, since
the relay never reads that schema and has no way to know the field exists. `weft generate` leaves
it out of the generated mutator's update input instead, so the generated type cannot pass it to
`update`. That is a compile-time guarantee inside generated code, not a relay check. A write built
by hand, bypassing the generated mutators, can still set the field, and the relay accepts it like
any ordinary `lww` write. Choose `immutable` for a value that must never change once a row exists,
where the generated mutators are the only way an application writes to it.
