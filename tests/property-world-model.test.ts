// The model-based half of the DESIGN.md §9 suite: fast-check generates histories over the
// world model in property-model.ts, and every invariant in property-invariants.ts is
// asserted after each command and again once the history has settled.
import { test } from "vitest";
import fc from "fast-check";
import { disagreements, quiesce, runWorld, WORLD_RUNS, worldCommands } from "./property-model.ts";
import { assertSettledInvariants, STEP_INVARIANTS, SETTLED_INVARIANTS } from "./property-invariants.ts";

test("generated histories uphold every continuously-checked §9 invariant", () => {
  fc.assert(
    fc.property(worldCommands(120), (commands) => {
      const world = runWorld(commands);
      quiesce(world);
      assertSettledInvariants(world);
    }),
    { numRuns: WORLD_RUNS },
  );
});

test("generated histories converge with more devices than partitions", () => {
  fc.assert(
    fc.property(worldCommands(80), (commands) => {
      const world = runWorld(commands, 5);
      quiesce(world);
      assertSettledInvariants(world);
    }),
    { numRuns: WORLD_RUNS },
  );
});

test("the invariant registry covers the world-checkable §9 invariants", () => {
  const covered = new Set([...STEP_INVARIANTS, ...SETTLED_INVARIANTS].map((invariant) => invariant.id));
  const expected = [
    "§9.3",
    "§9.4",
    "§9.5",
    "§9.8",
    "§9.8a",
    "§9.8b",
    "§9.15",
    "§9.18",
    "§9.20",
    "§9.21",
    "§9.23f",
    "§9.24",
    "§9.25",
    "§9.30",
    "§9.31",
    // Not §9 rules, but continuously checkable: an unsent write must survive a pull, and a
    // revision must not run backwards.
    "§5.8.unsent",
    "§8.2.rev",
  ];
  for (const id of expected) {
    if (!covered.has(id)) throw new Error(`the world model no longer checks ${id}`);
  }
});

test("a settled world reports no disagreements for a trivially empty history", () => {
  const world = runWorld([]);
  quiesce(world);
  if (disagreements(world).length !== 0) throw new Error("an empty history disagreed with itself");
});
