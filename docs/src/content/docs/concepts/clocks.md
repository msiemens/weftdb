---
title: Clocks
description: Hybrid logical clocks, their total ordering, how they advance, and the skew threshold that rejects a write from a device whose clock is wrong.
sidebar:
  order: 5
---

[Introduction](/introduction/) describes the effect of comparing clock readings without naming
them: "the later edit wins, and which one is later is decided by a clock reading that every
device compares the same way." That reading is a hybrid logical clock, HLC for short, and every
device compares it the same way because it is a plain string ordered by ordinary comparison.

## The parts of a reading

An HLC reading is a triple: a wall-clock time in milliseconds, a counter, and the id of the
device that produced it. `HlcClock`, in `weftdb/core`, holds this triple as its internal state
and produces a fresh `HlcString` reading on every call to `next()`.

Wall-clock time alone is insufficient: two writes on different devices can share the same
millisecond, and a system clock reset backward would rank an earlier write above one that
actually came after it. A counter alone is insufficient: with no tie to real time, two counters
say nothing about how far a device's clock has drifted, which is what the skew check below
measures.

## Total ordering

`compareHlc` compares two `HlcString` values, and every device gets the same answer, because the
comparison reads only the two strings and nothing from the comparing device's own clock. It is a
total order: a reading compares equal to itself, the comparison is antisymmetric, it is transitive
across three arbitrary readings, and a reading always compares in the same order as the plain text
it is written in. This total order is what every `lww` field rests its decision
on: between two conflicting writes to a field, the one with the higher HLC is kept.

## String form

`encodeHlc` writes the triple down as one `HlcString`: the wall-clock milliseconds in base36,
zero-padded to 15 digits, a hyphen, the counter in base36, zero-padded to 6 digits, a hyphen, and
the device id. Fixed-width padding is what makes plain string comparison equivalent to comparing
the three parts in order: wall-clock time first, the counter next when wall-clock time ties, and
the device id last when both tie. `HlcString` is a branded string, distinct at the type level
from a `RowId` or a `TableName` even though all three are plain strings at runtime.

```ts
import { compareHlc, deviceId, encodeHlc } from "weftdb/core";

const laptop = encodeHlc({ wallMs: Date.now(), counter: 0, deviceId: deviceId("laptop") });
const phone = encodeHlc({ wallMs: Date.now(), counter: 0, deviceId: deviceId("phone") });
compareHlc(laptop, phone);
```

`parseHlc` reverses the encoding, splitting on the first two hyphens and treating everything
after the second as the device id, since a device id may itself contain one. A reading survives
being parsed and re-encoded, and a string given to the parser either round-trips this way or is
rejected outright.

## Clock advancement

A device's `HlcClock` advances on two occasions. On a local write, `next()` takes the higher of
the wall-clock time the device's own clock reports and the wall-clock time already recorded in
the clock's state. When the two tie, the counter increments instead of the wall-clock time, which
is what keeps two writes made in the same millisecond distinct and ordered. A clock's readings
never repeat or move backward, even when the underlying wall clock jumps by an arbitrary amount.

On receiving a remote reading, `WeftClient` calls `clock.observe()` with the incoming `HlcString`
before applying the value it is attached to. That happens for a field pulled from the relay, and
for the reading returned with a `merge_required` rejection, part of the rebase path [the sync
protocol](/concepts/sync-protocol/) covers. `observe()` folds the remote reading into the
clock's state and advances past it, so the device's next write compares later than everything it
has just received: after observing a reading, the clock's next write always compares greater
than it.

## Clock skew

The relay checks every operation's HLC against its own wall-clock time. An operation whose
wall-clock component is more than 5 minutes ahead of the relay's clock is rejected with reason
`clock_skew`. A device retries automatically: it re-stamps the operation against the wall-clock
time the relay reported and tries again, up to 3 times. The correction never lands at or below a
reading the device has already had accepted, so a corrected write cannot be reordered behind one
of the device's own earlier writes.

If the 3 retries do not converge, the operation reaches quarantine under the same `clock_skew`
reason. [Handling conflicts](/guides/handling-conflicts/) covers how an interface should present
that quarantine entry to a person. The device's own system clock is wrong enough that resending
will not fix it; the only way forward is to correct the clock and retry.

## What the ordering does not give you

Comparing two HLCs gives the same answer on every device. That answer says nothing about when
either write actually happened in real time. A device whose clock runs a few seconds fast still
produces readings that other devices treat as later, as long as the gap stays inside the skew
threshold above. Two edits made without either device having seen the other's write are still
totally ordered by their HLCs. Which one wins is decided arbitrarily, and every device applies
the same arbitrary answer.

That is enough for an `lww` field, where keeping one of two writes is the whole rule. It is not
enough for prose: an edit that only happens to compare later should not overwrite one it never
saw. That is why a `diff3` field is merged three ways instead of decided by clock order alone.
The [merge model](/concepts/merge-model/) covers how the ordering is used, and where it stops
being enough.
