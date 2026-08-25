---
title: The sync protocol
description: Session shape, push transactions and partial success, the rebase path, acknowledgment, idempotent redelivery, and wire types.
sidebar:
  order: 2
---

A sync session is driven by `WeftClient.sync()` or its asynchronous counterpart `syncWith()`. The
two run the same sequence of steps against a `WeftServer`, differing only in whether the relay is
called in-process or over a transport.

## Session shape

A call to `sync` or `syncWith` moves through a fixed order:

1. The device sends a handshake carrying its schema hash, schema version, and last known
   sequence number. [Schema changes](/guides/schema-changes/) covers the three outcomes the relay
   can return and what each means for a device on the wrong build.
2. If the handshake answers `resync`, the device applies a full snapshot before doing anything
   else.
3. The device flushes its outbox: `flush` or `flushWith` pushes whatever is queued and applies the
   result, repeating until the outbox is empty or it has tried four times. The fourth attempt
   exists only to notice that a rebase or a clock restamp failed to converge, not to make a fifth
   attempt.
4. The device pulls everything the relay has recorded since its last known sequence number. If the
   batch's tombstone floor has moved past that sequence number, nothing in it is applied and the
   device applies a full snapshot instead; otherwise the batch merges into local storage.
   [Architecture](/concepts/architecture/) covers what a snapshot contains and why deletion is the
   one thing an incremental pull cannot recover.

## Transactions

Every operation carries a `txnId`, and the relay applies every operation sharing one `txnId`
atomically: either all of them land or none do. `WeftClient.create()` uses this directly, stamping
one row operation of kind `create` and one `set` operation per initial field under the same
`txnId`, so a row is never observed holding some of its starting fields but not others. Within a
transaction the relay applies every row operation before any `set` operation, regardless of arrival
order, so a batch reordered in transit applies the same as one delivered in emission order.

## Partial success on push

A single push can carry several transactions at once, queued from however much accumulated while
the device was offline. The relay groups the incoming operations by `txnId` and validates each
transaction in turn, stopping at the first one it rejects. Every transaction validated before that
point is applied and returned in the outcome's `acks`, alongside the rejection, rather than
discarded along with it.

This is what stops a device from re-sending work the relay already holds. Reporting only the
rejection would leave the applied transactions in the outbox for the next attempt to resend: a
repeated `create` comes back `row_exists`, and a repeated `diff3` write competes with the value it
already produced. `WeftClient` drains the acknowledged transactions from its outbox before
retrying, so only the rejected transaction, and whatever follows it, goes out again.

## Op kinds and their wire shape

`OpKind` is `create | set | delete | restore | append`. The four kinds other than `set` share one
shape, a row operation: a scope, table, row id, HLC, and `txnId`, mutating only whether and how a
row exists. `set` is the one field operation, adding a required `field` and `value`, and an
optional `baseHash` used by the rebase path below. A row operation's type has no `field` or `value`
property, so a row-level write can never carry a value; a `set` operation's `field` and `value` are
required, not optional, so it can never omit one:

```ts
import { deviceId, encodeHlc, fieldName, rowId, scopeId, tableName, txnId, type SetOp, type WeftOp } from "weftdb/core";

const hlc = encodeHlc({ wallMs: Date.now(), counter: 0, deviceId: deviceId("tab-1") });
const txn = txnId("create-task-1");

// a row op: no field, no value
const createsRow: WeftOp = {
  scopeId: scopeId("user-1"),
  tableName: tableName("tasks"),
  rowId: rowId("task-1"),
  kind: "create",
  hlc,
  txnId: txn,
};

// a field op: field and value are required
const setsTitle: SetOp = {
  scopeId: scopeId("user-1"),
  tableName: tableName("tasks"),
  rowId: rowId("task-1"),
  kind: "set",
  field: fieldName("title"),
  value: "Write the quick start",
  hlc,
  txnId: txn,
};
```

## The rebase path

A `set` operation on a field with the [`diff3`](/concepts/merge-model/) merge annotation carries a
`baseHash`: the hash of the value the device last synced for that field. The relay compares it to
the hash of whatever it currently holds. A match applies the write. A mismatch rejects the
transaction with `merge_required` and returns the value and HLC the relay actually holds.

The device answers by merging locally. If the row no longer exists locally, there is nothing to
rebase against, and the operation is quarantined as `rebase_exhausted` instead. Otherwise it merges
its own queued value against the relay's returned value, using its own base as the common ancestor,
folds the returned HLC into its clock so the retry is stamped strictly later than the write it
rebases against, records the relay's value as the new base, and re-stamps the matching outbox
operation with the merged value, a `baseHash` over the relay's value, and a fresh HLC. This repeats
up to three times; a rejection that survives all three is also quarantined as `rebase_exhausted`.
[Handling conflicts](/guides/handling-conflicts/) covers what a same-line merge looks like once it
reaches an interface.

## Acknowledgment and the outbox

A push outcome carries a `PushAck` per applied transaction: its `txnId`, the `server_seq` it was
assigned, and a `firstSeenAt` for every row it touched. Applying an ack clears the matching entries
from the outbox, writes each row's `firstSeenAt` locally, and folds the acknowledged operations'
HLCs into the device's clock, which a later clock-skew restamp must never drop back below.

Only the operations actually sent are drained. `WeftClient` snapshots the outbox before a push call
and clears only that snapshot's entries once acknowledged, so an edit queued while the push was in
flight stays in the outbox rather than being treated as sent.

## Idempotent redelivery

The relay applies a plain `set` operation, one without a `baseHash`, only if its HLC compares
strictly higher than the one already stored for that field; `delete` and `restore` apply only if
their HLC compares strictly higher than the row's current lifecycle register. A `set` carrying a
`baseHash` is checked earlier instead: a second delivery of one already applied fails that check
once the stored value has moved past what the `baseHash` names, and is rejected rather than
reapplied. Either way, re-delivering an operation the relay has already accepted leaves stored
state unchanged, which is what makes it safe for a device that cannot tell whether an earlier push
attempt's response reached it to send the same operations again.

## Wire types

Every identifier on the wire is a branded string: `ScopeId`, `DeviceId`, `TableName`, `FieldName`,
`RowId`, `TxnId`, `SchemaHash`, and `HlcString` are each a plain string at runtime, carrying a
type-level tag that a constructor such as `scopeId()` or `rowId()` attaches without validating the
string. The brand stops a `RowId` and a `TableName` from being passed to each other's position by
mistake; it does not check that either one is well-formed.

A `set` operation's `value` is a `WireValue`: a JSON scalar, or an array or object built out of
`WireValue`s recursively. This is the full range a field can hold on the wire, and it is exactly
what a row operation's absent `field` and `value` properties rule out for every kind other than
`set`.
