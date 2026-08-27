// The portable digest has to agree with everyone else's SHA-256, because schema hashes and
// diff3 base hashes are compared across devices that may be running anything.
import assert from "node:assert/strict";
import { test } from "vitest";
import { createHash } from "node:crypto";
import fc from "fast-check";
import { stableHash } from "weftdb/core";
import { sha256Hex } from "weftdb/shared";
import { PROPERTY_RUNS } from "./property-model.ts";

test("the portable digest matches the platform's SHA-256", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 400 }), (input) => {
      assert.equal(sha256Hex(input), createHash("sha256").update(input).digest("hex"));
    }),
    { numRuns: 500 },
  );
});

test("it agrees with the platform over any string, of any length, in any alphabet", () => {
  // `fc.string()` above draws printable ASCII, which exercises the compression function and almost
  // none of the encoding, because a digest is taken over bytes, and where the bytes come from is
  // half of what there is to get wrong.
  //
  // `binary` units are arbitrary UTF-16 code units, so this reaches lone surrogates, which are not
  // text and which `TextEncoder` and `Buffer` both replace with U+FFFD. Anything swapped in here
  // has to agree about that as well as about the arithmetic.
  //
  // Lengths run past 64 code units so a string crosses block boundaries on its own, and a
  // multi-byte unit means the byte length is not the code-unit length, which is where an
  // implementation that padded by the wrong count would show.
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string({ unit: "binary", maxLength: 300 }),
        fc.string({ unit: "grapheme", maxLength: 300 }),
        fc.string({ unit: "binary-ascii", maxLength: 300 }),
      ),
      (input) => {
        assert.equal(
          sha256Hex(input),
          createHash("sha256").update(input, "utf8").digest("hex"),
          `disagreed on ${JSON.stringify(input)}`,
        );
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});

test("it hashes the bytes the platform encodes, not the code units", () => {
  // This assertion pins the digest against `Buffer.from(input, "utf8")`, so a change that broke
  // both the hash and the encoding the same way still fails here.
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 200 }), (input) => {
      const bytes = Buffer.from(new TextEncoder().encode(input));
      assert.equal(sha256Hex(input), createHash("sha256").update(bytes).digest("hex"));
      assert.deepEqual(bytes, Buffer.from(input, "utf8"), "the platform and TextEncoder encoded differently");
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("it matches across the block boundaries where padding decides the answer", () => {
  // 55/56 and 63/64 bytes are where the length field stops fitting in the final block.
  for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1_000]) {
    const input = "a".repeat(length);
    assert.equal(sha256Hex(input), createHash("sha256").update(input).digest("hex"), `length ${length}`);
  }
});

test("multi-byte characters hash by their bytes, not their code units", () => {
  for (const input of ["ünïcode", "日本語のノート", "🧵 weft", "\0"]) {
    assert.equal(sha256Hex(input), createHash("sha256").update(input, "utf8").digest("hex"), input);
  }
});

test("stable hashing ignores key order but not values", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 20 }), fc.integer(), (text, number) => {
      assert.equal(stableHash({ a: text, b: number }), stableHash({ b: number, a: text }));
      assert.notEqual(stableHash({ a: text, b: number }), stableHash({ a: text, b: number + 1 }));
    }),
    { numRuns: 300 },
  );
});
