// The algebra underneath the protocol. Everything above these holds only if they do: an
// ordering that is not a total order, a rank that is not strictly between its neighbours, or a
// merge that is not idempotent, all show up far from here as a convergence failure nobody can
// explain. The property suite exercises them constantly as machinery — this is the file that
// says what they are supposed to be.
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import {
  compareHlc,
  deviceId,
  diff3,
  encodeHlc,
  fieldName,
  hasConflictMarkers,
  HlcClock,
  isHlcString,
  parseHlc,
  rankBetween,
  rowId,
  scopeId,
  stableHash,
  tableName,
  wireText,
  type HlcString,
  type RankString,
  type WireValue,
} from "weftdb/core";
import { decodeWireValue, encodeWireValue } from "weftdb/shared";
import { SubscriptionEngine, type LocalRow } from "weftdb/client";

const RUNS = Number(process.env["WEFT_PROPERTY_RUNS"] ?? 1_000);

const deviceArb = fc.constantFrom("device-a", "device-b", "zz-last").map((id) => deviceId(id));
const hlcArb = fc
  .tuple(fc.integer({ min: 0, max: 2_000_000_000_000 }), fc.integer({ min: 0, max: 999_999 }), deviceArb)
  .map(([wallMs, counter, device]) => encodeHlc({ wallMs, counter, deviceId: device }));
const candidateHlcArb = fc.oneof(
  fc.string({ maxLength: 30 }),
  fc
    .tuple(fc.string({ maxLength: 20 }), fc.string({ maxLength: 10 }), fc.string({ minLength: 1, maxLength: 12 }))
    .map((parts) => parts.join("-")),
);

const wireArb: fc.Arbitrary<WireValue> = fc.letrec<{ value: WireValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    // Negative zero is excluded here and pinned in its own test below: JSON has no such value,
    // so it is the one thing storage legitimately gives back as something else.
    fc.double({ noNaN: true, noDefaultInfinity: true }).map((value) => (Object.is(value, -0) ? 0 : value)),
    fc.string(),
    fc.array(tie("value"), { maxLength: 4 }),
    // Ordinary objects: a value with a null prototype is not something storage round-trips or
    // an application produces, and comparing prototypes would be testing the generator.
    fc.dictionary(fc.string({ maxLength: 6 }), tie("value"), { maxKeys: 4, noNullPrototype: true }),
  ),
})).value;

// --- hybrid logical clocks ------------------------------------------------------------------

test("an HLC survives being written down and read back", () => {
  fc.assert(
    fc.property(hlcArb, (hlc) => {
      const parsed = parseHlc(hlc);
      assert.equal(encodeHlc(parsed), hlc, "re-encoding a parsed stamp changed it");
    }),
    { numRuns: RUNS },
  );
});

test("an HLC parser only accepts canonical stamps", () => {
  fc.assert(
    fc.property(candidateHlcArb, (candidate) => {
      let parsed: ReturnType<typeof parseHlc>;
      try {
        parsed = parseHlc(candidate as HlcString);
      } catch (error) {
        assert.match((error as Error).message, /invalid HLC/u);
        return;
      }
      assert.equal(Number.isFinite(parsed.wallMs), true, "the parsed wall clock is not finite");
      assert.equal(Number.isInteger(parsed.counter), true, "the parsed counter is not an integer");
      assert.equal(encodeHlc(parsed), candidate, "a non-canonical stamp was accepted");
    }),
    { numRuns: RUNS },
  );
});

test("stamps compare in the order they are written, whatever their size", () => {
  // The encoding is fixed-width so that lexicographic order is chronological order; a stamp
  // that lost a digit of padding would sort before stamps it happened after.
  fc.assert(
    fc.property(hlcArb, hlcArb, (left, right) => {
      const byValue = compareHlc(left, right);
      const lexicographic = left < right ? -1 : left > right ? 1 : 0;
      assert.equal(Math.sign(byValue), lexicographic, `${left} and ${right} compare differently as text`);
    }),
    { numRuns: RUNS },
  );
});

test("comparison is a total order", () => {
  fc.assert(
    fc.property(hlcArb, hlcArb, hlcArb, (a, b, c) => {
      assert.equal(compareHlc(a, a), 0, "a stamp did not equal itself");
      assert.equal(Math.sign(compareHlc(a, b)), -Math.sign(compareHlc(b, a)), "comparison is not antisymmetric");
      // Transitivity is what a sort depends on, and what a merge order depends on after that.
      if (compareHlc(a, b) <= 0 && compareHlc(b, c) <= 0) {
        assert.ok(compareHlc(a, c) <= 0, "comparison is not transitive");
      }
    }),
    { numRuns: RUNS },
  );
});

test("a clock never repeats or rewinds a stamp, however time behaves", () => {
  fc.assert(
    fc.property(
      // A clock that jumps backwards is the case the counter exists for.
      fc.array(fc.integer({ min: -5_000, max: 5_000 }), { minLength: 1, maxLength: 30 }),
      (jumps) => {
        let now = 1_700_000_000_000;
        const clock = new HlcClock(deviceId("device-a"), () => now);
        let previous: HlcString | undefined;
        for (const jump of jumps) {
          now = Math.max(0, now + jump);
          const stamp = clock.next();
          if (previous !== undefined) {
            assert.equal(compareHlc(stamp, previous) > 0, true, `${stamp} did not come after ${previous}`);
          }
          previous = stamp;
        }
      },
    ),
    { numRuns: RUNS },
  );
});

test("observing a stamp puts this device's next write after it", () => {
  fc.assert(
    fc.property(hlcArb, (observed) => {
      // Frozen wall clock: the counter is all the clock has to work with, which is exactly the
      // situation where a device that has just heard from another must still write later.
      const clock = new HlcClock(deviceId("device-a"), () => 1_700_000_000_000);
      clock.observe(observed);
      assert.equal(compareHlc(clock.next(), observed) > 0, true, "a write did not come after what was observed");
    }),
    { numRuns: RUNS },
  );
});

test("a skew correction lands after everything the device has had accepted", () => {
  fc.assert(
    // Only a device far enough ahead of the server is ever asked to re-stamp: below the
    // threshold nothing is rejected, so there is no correction to make.
    fc.property(
      fc.integer({ min: 300_001, max: 5_000_000 }),
      fc.integer({ min: 0, max: 600_000 }),
      (drift, serverOffset) => {
        const wall = 1_700_000_000_000;
        const clock = new HlcClock(deviceId("device-a"), () => wall + drift);
        const emitted = clock.next();
        // Observing its own stamp is what "this write was accepted" looks like to the clock; a
        // stamp that was only ever emitted and then rejected is precisely what a correction is
        // allowed to drop.
        clock.observe(emitted);
        const restamped = clock.restampAfterSkew(wall - serverOffset);
        // The rejected stamp is dropped, but nothing the device already emitted may be reused
        // or overtaken — that is what keeps its own history in order (§5.5).
        assert.equal(compareHlc(restamped, emitted) > 0, true, "a re-stamp did not come after the device's own write");
      },
    ),
    { numRuns: RUNS },
  );
});

// --- fractional indexing --------------------------------------------------------------------

function ordered(left: RankString, right: RankString): boolean {
  return left < right;
}

/** A list built the way an application builds one: rows inserted at generated positions. */
const listArb = fc.array(fc.tuple(fc.nat(), deviceArb), { minLength: 1, maxLength: 12 }).map((inserts) => {
  const ranks: RankString[] = [];
  for (const [position, device] of inserts) {
    const index = position % (ranks.length + 1);
    ranks.splice(index, 0, rankBetween(ranks[index - 1] ?? null, ranks[index] ?? null, device));
  }
  return ranks;
});

test("a list built by inserting at any position stays sorted", () => {
  fc.assert(
    fc.property(listArb, (ranks) => {
      // The list is held in insertion order; sorting it by rank has to give the same order back,
      // because the rank is the only thing every device agrees to sort by.
      assert.deepEqual([...ranks].sort(), ranks, "the ranks do not sort into the order they were inserted in");
      assert.equal(new Set(ranks).size, ranks.length, "two rows ended up with the same rank");
    }),
    { numRuns: RUNS },
  );
});

test("a new rank sits strictly between the two it was given", () => {
  fc.assert(
    fc.property(listArb, fc.nat(), deviceArb, (ranks, position, device) => {
      fc.pre(ranks.length >= 2);
      const index = 1 + (position % (ranks.length - 1));
      const left = ranks[index - 1];
      const right = ranks[index];
      if (left === undefined || right === undefined) return;
      const between = rankBetween(left, right, device);
      assert.equal(ordered(left, between), true, `${between} did not sort after ${left}`);
      assert.equal(ordered(between, right), true, `${between} did not sort before ${right}`);
    }),
    { numRuns: RUNS },
  );
});

test("an open end puts the row before or after everything", () => {
  fc.assert(
    fc.property(listArb, deviceArb, (ranks, device) => {
      const first = ranks[0];
      const last = ranks.at(-1);
      if (first === undefined || last === undefined) return;
      assert.equal(
        ordered(rankBetween(null, first, device), first),
        true,
        "a rank before everything did not sort first",
      );
      assert.equal(ordered(last, rankBetween(last, null, device)), true, "a rank after everything did not sort last");
    }),
    { numRuns: RUNS },
  );
});

test("two devices inserting into the same gap keep both rows, in an order everyone agrees on", () => {
  fc.assert(
    fc.property(listArb, fc.nat(), (ranks, position) => {
      fc.pre(ranks.length >= 2);
      const index = 1 + (position % (ranks.length - 1));
      const left = ranks[index - 1];
      const right = ranks[index];
      if (left === undefined || right === undefined) return;

      // Both devices pick the same midpoint while apart; the suffix is what keeps the two rows
      // distinct and gives every device the same answer about which comes first.
      const a = rankBetween(left, right, deviceId("device-a"));
      const b = rankBetween(left, right, deviceId("device-b"));
      assert.notEqual(a, b, "two devices produced the same rank for the same gap");
      assert.equal(ordered(a, b), true, "the tie between two devices is not broken consistently");
      for (const rank of [a, b]) {
        assert.equal(ordered(left, rank) && ordered(rank, right), true, `${rank} left the gap it was inserted into`);
      }

      // And a third row can still go between them afterwards, which is the case that used to
      // throw: their cores are equal, so there is no core between them to find.
      const third = rankBetween(a, b, deviceId("device-c"));
      assert.equal(ordered(a, third) && ordered(third, b), true, `${third} did not land between ${a} and ${b}`);
    }),
    { numRuns: RUNS },
  );
});

test("the query engine orders ranks the way the ranks were built", () => {
  fc.assert(
    fc.property(listArb, (ranks) => {
      // A rank is only "between" its neighbours under plain comparison. Sorting the same rows
      // by locale — which weighs punctuation and case differently — puts them in an order the
      // fractional index never promised, so a reorder writes a new rank and the list does not
      // move. It also means two devices in different locales would disagree about the order of
      // the same list, which is the one thing a shared list cannot do.
      const engine = new SubscriptionEngine();
      const rows = new Map<string, LocalRow>(
        ranks.map((rank, index) => [
          `todos row-${index}`,
          {
            id: rowId(`row-${index}`),
            scopeId: scopeId("s"),
            tableName: tableName("todos"),
            created: "",
            fields: new Map([[fieldName("rank"), rank as WireValue]]),
            internals: {
              _weft_first_synced_at: null,
              _weft_rev: 1,
              _weft_dirty: 0,
              hlc: new Map(),
              diff3Base: new Map(),
            },
          } satisfies LocalRow,
        ]),
      );

      const ordered = engine
        .getSnapshot(
          { tableName: tableName("todos"), fields: [fieldName("rank")], orderBy: fieldName("rank") },
          rows.values(),
        )
        .rows.map((row) => wireText(row.fields.get(fieldName("rank")) ?? ""));
      assert.deepEqual(ordered, [...ranks], "the query put the rows in an order the ranks do not describe");
    }),
    { numRuns: RUNS },
  );
});

test("repeatedly inserting into the same gap grows the rank slowly", () => {
  // Every insert at the same spot has to fit between the last two, so the string grows. What
  // must not happen is growth per insert that makes the index unusable after a few dozen moves.
  const left = rankBetween(null, null, deviceId("device-a"));
  let right = rankBetween(left, null, deviceId("device-a"));
  for (let index = 0; index < 60; index += 1) {
    const next = rankBetween(left, right, deviceId("device-a"));
    assert.equal(ordered(left, next) && ordered(next, right), true, `insert ${index} was not between its neighbours`);
    right = next;
  }
  assert.ok(right.length < 120, `a rank grew to ${right.length} characters after 60 inserts in one gap`);
});

// --- prose merge ----------------------------------------------------------------------------

const textArb = fc.array(fc.string({ maxLength: 8 }), { maxLength: 6 }).map((lines) => lines.join("\n"));

test("merging a side against itself changes nothing", () => {
  fc.assert(
    fc.property(textArb, textArb, (base, both) => {
      const merged = diff3(base, both, both);
      assert.equal(merged.value, both, "two identical edits did not merge to themselves");
      assert.equal(merged.conflicted, false, "two identical edits reported a conflict");
    }),
    { numRuns: RUNS },
  );
});

test("a side that did not move keeps out of the way", () => {
  fc.assert(
    fc.property(textArb, textArb, (base, mine) => {
      assert.equal(diff3(base, mine, base).value, mine, "an unchanged remote overrode a local edit");
      assert.equal(diff3(base, base, mine).value, mine, "an unchanged local overrode a remote edit");
    }),
    { numRuns: RUNS },
  );
});

test("a clean merge is stable: merging it again does nothing", () => {
  fc.assert(
    fc.property(textArb, textArb, textArb, (base, mine, theirs) => {
      const merged = diff3(base, mine, theirs);
      fc.pre(!merged.conflicted);
      // The merged text is what both devices now hold, so merging it with itself against its
      // own base has to be a no-op — otherwise a second sync would keep changing the value.
      assert.equal(diff3(merged.value, merged.value, merged.value).value, merged.value);
    }),
    { numRuns: RUNS },
  );
});

test("markers appear only when a merge actually conflicted", () => {
  fc.assert(
    fc.property(textArb, textArb, textArb, (base, mine, theirs) => {
      const merged = diff3(base, mine, theirs);
      fc.pre(![base, mine, theirs].some((text) => hasConflictMarkers(text)));
      assert.equal(
        hasConflictMarkers(merged.value),
        merged.conflicted,
        "the text and the reported outcome disagree about whether there was a conflict",
      );
    }),
    { numRuns: RUNS },
  );
});

test("a conflicted merge keeps what each side wrote", () => {
  fc.assert(
    fc.property(textArb, textArb, textArb, (base, mine, theirs) => {
      const merged = diff3(base, mine, theirs);
      fc.pre(merged.conflicted);
      // Not every line of each side: a line one side deleted and the other left alone is
      // legitimately gone, and that can happen in one hunk while another hunk conflicts. What
      // a conflict must never do is drop something a side actually wrote, because the whole
      // point of surfacing it rather than picking a winner is that nobody's work is discarded.
      for (const [name, side] of [
        ["local", mine],
        ["remote", theirs],
      ] as const) {
        const written = side.split("\n").filter((line) => line.trim().length > 0 && !base.split("\n").includes(line));
        for (const line of written) {
          assert.ok(
            merged.value.includes(line),
            `the ${name} side wrote ${JSON.stringify(line)} and the merge lost it`,
          );
        }
      }
    }),
    { numRuns: RUNS },
  );
});

// --- values on the wire ---------------------------------------------------------------------

test("a value survives the trip to storage and back", () => {
  fc.assert(
    fc.property(wireArb, (value) => {
      const returned = decodeWireValue(encodeWireValue(value));
      // Compared as they are written down, which is the only sense in which two values are the
      // same to everything downstream: the hash a diff3 base check compares, the bytes a
      // snapshot is addressed by, and what another device will read.
      assert.equal(encodeWireValue(returned), encodeWireValue(value), "a value changed on the way to storage");
      assert.deepEqual(returned, value, "a value changed on the way to storage");
    }),
    { numRuns: RUNS },
  );
});

test("negative zero is the one value storage does not give back unchanged", () => {
  // JSON has no negative zero, so `-0` is stored and read back as `0`. Everything that
  // compares values — hashes, snapshot digests, what other devices see — already agrees with
  // that, so the only difference is in the writing device's memory until it reloads. Pinned
  // here so it is a known property of the wire format rather than a surprise in a field.
  assert.equal(Object.is(decodeWireValue(encodeWireValue(-0)), 0), true);
  assert.equal(stableHash(-0), stableHash(0), "the two zeroes hash differently, which would fail a base check");
});

test("a non-finite number is refused rather than stored as null", () => {
  // `JSON.stringify` renders NaN and both infinities as `null`. Left alone, three distinct numbers
  // and an actual null all collapse to one stored value and one hash, and a diff3 base check
  // comparing a field that held NaN against one that held null sees no change and lets a merge
  // through as a fast-forward. Neither the wire nor the hash accepts one.
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => encodeWireValue(value), /not representable/u, `${String(value)} reached the wire`);
    assert.throws(() => stableHash(value), /not representable/u, `${String(value)} was hashed`);
    assert.throws(
      () => encodeWireValue({ nested: [value] }),
      /not representable/u,
      `${String(value)} reached the wire inside a collection`,
    );
  }
  assert.equal(decodeWireValue(encodeWireValue(0)), 0, "a finite number no longer round-trips");
});

test("an HLC counter that runs out of digits carries into the wall clock", () => {
  // A reading is compared as a fixed-width string, so the counter has exactly six base-36 digits
  // to sit in. A seventh digit shifts every column after it and sorts below six-digit counters a
  // tenth its size, and `compareHlc` is what every last-write-wins decision rests on. The counter
  // carries instead, the way a decimal column does.
  const overflowed = 36 ** 6;
  assert.throws(
    () => encodeHlc({ wallMs: 1, counter: overflowed, deviceId: deviceId("d") }),
    /counter out of range/u,
    "an over-wide counter was still encoded",
  );

  // Reached from a peer rather than only from local traffic: `observe` folds a remote counter in
  // with `Math.max(...) + 1`, so a reading at the top of the range pushes this device over.
  const clock = new HlcClock(deviceId("device-a"), () => 1_000);
  const atTheTop = encodeHlc({ wallMs: 1_000, counter: 36 ** 6 - 1, deviceId: deviceId("device-b") });
  clock.observe(atTheTop);
  const next = clock.next();

  assert.equal(next.split("-")[1]?.length, 6, "the counter segment overflowed its width");
  assert.equal(compareHlc(next, atTheTop) > 0, true, "the carried stamp did not come after what it observed");
  assert.equal(parseHlc(next).wallMs, 1_001, "the counter did not carry into the wall clock");
});

test("a stamp that is not canonical is refused rather than parsed to NaN", () => {
  // A reading that parses to NaN is folded into a clock with `Math.max`, which makes every later
  // stamp on that device NaN too. No valid write afterwards recovers from it, so the boundary is
  // the parser.
  for (const candidate of [
    "",
    "1-2-d",
    "!!!-000000-d",
    `${"0".repeat(15)}-000000`,
    `${"0".repeat(16)}-000000-d`,
    `${"0".repeat(15)}-00000-d`,
  ]) {
    assert.equal(isHlcString(candidate), false, `${JSON.stringify(candidate)} was accepted as canonical`);
    assert.throws(() => parseHlc(candidate as HlcString), /invalid HLC/u, `${JSON.stringify(candidate)} parsed`);
  }
  assert.equal(
    isHlcString(encodeHlc({ wallMs: 1, counter: 2, deviceId: deviceId("tab-2-a3f1") })),
    true,
    "a device id with separators was refused",
  );
});

test("hashing sees through key order and nothing else", () => {
  fc.assert(
    fc.property(wireArb, wireArb, (left, right) => {
      // Two values that encode the same must hash the same, or a diff3 base check would ask a
      // client to merge with a value it already has.
      if (encodeWireValue(left) === encodeWireValue(right)) {
        assert.equal(stableHash(left), stableHash(right));
      }
      assert.equal(stableHash(left), stableHash(structuredClone(left)), "hashing is not a function of the value");
    }),
    { numRuns: RUNS },
  );
});
