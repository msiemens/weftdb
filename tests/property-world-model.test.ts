// The model-based half of the DESIGN.md §9 suite. fast-check generates histories over the
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
import { inProcessTransport } from "weftdb/client";

test("generated histories uphold every continuously-checked §9 invariant", async () => {
  await fc.assert(
    fc.asyncProperty(worldCommands(120), async (commands) => {
      const world = await runWorld(commands);
      await quiesce(world);
      await assertSettledInvariants(world);
    }),
    { numRuns: WORLD_RUNS },
  );
});

test("generated histories converge with more devices than partitions", async () => {
  await fc.assert(
    fc.asyncProperty(worldCommands(80), async (commands) => {
      const world = await runWorld(commands, 5);
      await quiesce(world);
      await assertSettledInvariants(world);
    }),
    { numRuns: WORLD_RUNS },
  );
});

test("the invariant registry covers the world-checkable §9 invariants", async () => {
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
    // Continuously checkable properties outside the numbered §9 rules: an unsent write must
    // survive a pull, a revision must not run backwards, and quarantining must move work
    // instead of copying it.
    "§5.8.unsent",
    "§8.2.rev",
    "§5.5.move",
  ];
  for (const id of expected) {
    if (!covered.has(id)) throw new Error(`the world model no longer checks ${id}`);
  }
});

test("a restore competing with an independent create of the same id settles without a false alarm", async () => {
  // The arrangement three generated histories shrank to, written out so it does not depend on
  // a seed. Two devices make the same id independently; only the first push wins the id, and
  // the loser's create is quarantined as `row_exists` (§5.5). Its queued delete and restore are
  // separate transactions, so they go on to apply to the row that did win, and the restore's
  // opening title arrives concurrent with, and stamped below, the title the winning create
  // gave the row.
  //
  // The server keeps the higher-stamped value, which is §5.9: a restore moves the liveness
  // register and leaves field values in place, so the id's field history survives the round
  // trip instead of starting over. A §5.1.acked replay that treated every row op as a new life
  // of the row would read that as a write accepted and then lost. Only `create` and `append`
  // start a new life of a row; `restore` does not, and this history exists to keep the two apart.
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

  await loser.create(TASKS, row, values("loser-title", "a:loser"), txnId("create-loser"));
  // Enough for the two creates to be told apart by their stamps, and no more. The restore that
  // follows is emitted in this same millisecond, which is what puts it under the winning create.
  world.now += 1;
  await winner.create(TASKS, row, values("winner-title", "a:winner"), txnId("create-winner"));
  await loser.delete(TASKS, row, txnId("delete-loser"));
  await loser.restore(TASKS, row, { [TITLE]: "restored-title" }, txnId("restore-loser"));
  await winner.syncWith(inProcessTransport(world.server), propertySchemaHash);

  await quiesce(world);
  await assertSettledInvariants(world);
});

test("an edit written while the row's own create is set aside rebases against what the create carries", async () => {
  // The arrangement a generated history shrank to, written out so it does not depend on a seed.
  // One device, so `tasks.notes` is written by nothing else in the world.
  //
  // §5.4 has a push carry `hash(_weft_base_notes)` and the relay fast-forward on a match. The
  // ancestor of a diff3 field on a row made here is the value the create carries, which a create
  // waiting in quarantine is still holding, so an edit written while it waits claims that value.
  // An edit that claims an absent ancestor instead earns `merge_required` against prose the same
  // device wrote, and once the row has been deleted here there is nothing left to merge from, so
  // the edit is set aside for good and the relay keeps the text it was typed over.
  const world = createWorld(1);
  const row = rowId("row-0");
  const device = deviceAt(world, 0).client;
  const transport = inProcessTransport(world.server);
  const edited = "edited\nbravo\ncharlie\ndelta";

  await device.create(
    TASKS,
    row,
    {
      [TITLE]: "a task",
      [STATUS]: "open",
      [NOTES]: BASE_NOTES,
      [RANK]: "a:only",
      [CONSUMED_AT]: world.now,
      [AUTO_DELETE_DAYS]: 30,
    },
    txnId("create"),
  );
  // A snapshot taken before the create was pushed does not name the row, and everything queued
  // for it is dirty, so the whole transaction is set aside as `row_absent` (§5.5).
  await device.applySnapshot(world.server.snapshot(world.scopeId));
  await device.update(TASKS, row, { [NOTES]: edited }, txnId("edit"));
  // The edit is addressed to a row the relay has never been given, so it joins the create in
  // quarantine. Retrying the create is what puts the row, and the prose the edit was written
  // against, on the relay.
  await device.syncWith(transport, propertySchemaHash);
  await device.retryQuarantinedTxn(txnId("create"));
  await device.syncWith(transport, propertySchemaHash);

  await device.delete(TASKS, row, txnId("delete"));
  await device.retryQuarantinedTxn(txnId("edit"));

  await quiesce(world);
  await assertSettledInvariants(world);
  const notes = world.server
    .snapshot(world.scopeId)
    .fields.find((record) => record.rowId === row && record.field === NOTES)?.value;
  if (notes !== edited) throw new Error(`the scope holds ${JSON.stringify(notes)} for prose only one device wrote`);
});

test("a settled world reports no disagreements for a trivially empty history", async () => {
  const world = await runWorld([]);
  await quiesce(world);
  if (disagreements(world).length !== 0) throw new Error("an empty history disagreed with itself");
});
