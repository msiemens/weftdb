// The model-based half of the DESIGN.md §9 suite: fast-check generates histories over the
// world model in property-model.ts, and every invariant in property-invariants.ts is
// asserted after each command and again once the history has settled.
import { test } from "vitest";
import fc from "fast-check";
import { rowId, txnId } from "weftdb/core";
import {
  AUTO_DELETE_DAYS,
  BASE_NOTES,
  CONSUMED_AT,
  createWorld,
  deviceAt,
  disagreements,
  NOTES,
  propertySchemaHash,
  quiesce,
  RANK,
  runWorld,
  STATUS,
  TASKS,
  TITLE,
  WORLD_RUNS,
  worldCommands,
} from "./property-model.ts";
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
    // Not §9 rules, but continuously checkable: an unsent write must survive a pull, a revision
    // must not run backwards, and quarantining must move work rather than copy it.
    "§5.8.unsent",
    "§8.2.rev",
    "§5.5.move",
  ];
  for (const id of expected) {
    if (!covered.has(id)) throw new Error(`the world model no longer checks ${id}`);
  }
});

test("a restore competing with an independent create of the same id settles without a false alarm", () => {
  // The arrangement three generated histories shrank to, written out so it does not depend on
  // a seed. Two devices make the same id independently; only the first push wins the id, and
  // the loser's create is quarantined as `row_exists` (§5.5). Its queued delete and restore are
  // separate transactions, so they go on to apply to the row that did win — and the restore's
  // opening title arrives concurrent with, and stamped below, the title the winning create
  // gave the row.
  //
  // The server keeps the higher-stamped value, which is §5.9: a restore moves the liveness
  // register and leaves field values in place, so the id's field history survives the round
  // trip rather than starting over. A §5.1.acked replay that treated every row op as a new life
  // of the row would read that as a write accepted and then lost. Only `create` and `append` are,
  // and this history is here to keep the two apart.
  const world = createWorld(5);
  const row = rowId("row-0");
  const loser = deviceAt(world, 3).client;
  const winner = deviceAt(world, 0).client;
  const values = (title: string, rank: string) => ({
    [TITLE]: title,
    [STATUS]: "open",
    [NOTES]: BASE_NOTES,
    [RANK]: rank,
    [CONSUMED_AT]: world.now,
    [AUTO_DELETE_DAYS]: 30,
  });

  loser.create(TASKS, row, values("loser-title", "a:loser"), txnId("create-loser"));
  // Enough for the two creates to be told apart by their stamps, and no more: the restore that
  // follows is emitted in this same millisecond, which is what puts it under the winning create.
  world.now += 1;
  winner.create(TASKS, row, values("winner-title", "a:winner"), txnId("create-winner"));
  loser.delete(TASKS, row, txnId("delete-loser"));
  loser.restore(TASKS, row, { [TITLE]: "restored-title" }, txnId("restore-loser"));
  winner.sync(world.server, propertySchemaHash);

  quiesce(world);
  assertSettledInvariants(world);
});

test("a settled world reports no disagreements for a trivially empty history", () => {
  const world = runWorld([]);
  quiesce(world);
  if (disagreements(world).length !== 0) throw new Error("an empty history disagreed with itself");
});
