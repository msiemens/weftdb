// Bounded exhaustive model checking, complementing the random search in the property suite.
//
// fast-check samples the space of histories; this walks *all* of it, breadth-first, for a
// deliberately tiny world — two devices, two rows, and a clock that only moves when an action
// says so. Every reachable state is checked, and states already seen are not re-explored, so
// the search terminates on the state space rather than on the number of sequences. Anything
// that needs only a handful of steps to go wrong is found here deterministically, on every
// run, with the shortest sequence that produces it.
import assert from "node:assert/strict";
import { test } from "vitest";
import { rowId, txnId, wireText, type DeviceId, type RowId } from "weftdb/core";
import { WeftClient } from "weftdb/client";
import { WeftServer, type Snapshot } from "weftdb/server";
import {
  localKey,
  localState,
  parseLocalKey,
  pendingOps,
  propertySchema,
  propertySchemaHash,
  propertyScope,
  TASKS,
  TITLE,
  TOMBSTONE_FLOOR_MS,
  type LocalRowState,
} from "./property-model.ts";

/** Fixed ids, so a fingerprint names the same row in every history it appears in. */
const ROWS: readonly RowId[] = ["row-a", "row-b"].map(rowId);
const DEVICES = 2;
const DEPTH = 7;
const MAX_STATES = 150_000;
// Rejections are quarantined one transaction per push, so a device that queued a transaction
// at every step of the history needs that many rounds before it stops moving.
const SETTLE_ROUNDS = DEPTH + 4;

type RowActionName = "create" | "update" | "delete" | "restore";
type DeviceActionName = "sync" | "pull" | "resync";
type WorldActionName = "tick" | "prune";

type Action =
  | { readonly kind: "row"; readonly name: RowActionName; readonly device: number; readonly row: RowId }
  | { readonly kind: "device"; readonly name: DeviceActionName; readonly device: number }
  | { readonly kind: "world"; readonly name: WorldActionName };

// The clock only moves when an action says so. Leaving it still is the point: HLCs then differ
// by counter alone, which is where ordering mistakes hide — a model that advanced time on
// every step would paper over them. `prune` is the exception, and has to be: the server only
// purges a tombstone once it is older than the floor, which a millisecond `tick` would take
// thirty days of steps to reach.
const ACTIONS: readonly Action[] = [
  ...Array.from({ length: DEVICES }, (_, device): readonly Action[] => [
    ...ROWS.flatMap((row) =>
      (["create", "update", "delete", "restore"] as const).map((name): Action => ({ kind: "row", name, device, row })),
    ),
    ...(["sync", "pull", "resync"] as const).map((name): Action => ({ kind: "device", name, device })),
  ]).flat(),
  { kind: "world", name: "tick" },
  { kind: "world", name: "prune" },
];

interface Universe {
  readonly server: WeftServer;
  readonly clients: readonly WeftClient[];
  now: number;
  steps: number;
}

test("every reachable state of a two-device, two-row world upholds the sync invariants", async (t) => {
  const start = replay([]);
  const seen = new Set([fingerprint(start)]);
  const queue: (readonly Action[])[] = [[]];
  let explored = 0;
  let deepest = 0;
  let stranded = 0;

  while (queue.length > 0) {
    const history = queue.shift();
    if (history === undefined) break;
    if (history.length >= DEPTH || seen.size >= MAX_STATES) continue;

    for (const action of ACTIONS) {
      const next = [...history, action];
      const universe = replay(next);
      explored += 1;

      // Fingerprint first: `check` settles and repairs the universe to make its assertions,
      // which would make every state look alike if it ran before the state was recorded.
      const state = fingerprint(universe);
      if (seen.has(state)) continue;
      seen.add(state);
      deepest = Math.max(deepest, next.length);
      if (universe.clients.some((client) => cursor(universe, client) === "purged")) stranded += 1;
      check(universe, next);
      queue.push(next);
    }
  }

  await t.annotate(`explored ${explored} transitions over ${seen.size} distinct states, to depth ${deepest}`);
  await t.annotate(`${stranded} of those states left a device below the tombstone floor`);
  // A guard against the search silently collapsing to nothing if the model changes, and
  // against the state cap quietly truncating it if the model grows.
  assert.equal(deepest, DEPTH, `the search stopped at depth ${deepest}`);
  assert.equal(seen.size < MAX_STATES, true, `the search hit the ${MAX_STATES} state cap`);
  // Pruning is only worth modelling if it actually strands a device below the floor, which is
  // what forces the snapshot path; without this the `prune` action could quietly become a no-op.
  assert.equal(stranded > 0, true, "no reachable state put a device below the tombstone floor");
  assert.equal(seen.size > 40_000, true, `only ${seen.size} distinct states were reachable`);
  assert.equal(explored > 250_000, true, `only ${explored} transitions were explored`);
});

/**
 * Invariants that must hold in every reachable state, plus convergence once the world is
 * allowed to settle from that state.
 */
function check(universe: Universe, history: readonly Action[]): void {
  const trail = () => history.map(describe).join(" -> ");

  for (const client of universe.clients) {
    for (const row of ROWS) {
      const key = localKey(TASKS, row);
      assert.equal(
        client.rows.has(key) && client.tombstones.has(key),
        false,
        `${trail()}: live row and tombstone coexist for ${row}`,
      );
    }
    for (const [key, row] of client.rows) {
      // Dirtiness is a question about one row: pending work on the other row must not mark it.
      const { tableName, rowId: id } = parseLocalKey(key);
      assert.equal(
        row.internals._weft_dirty === 1,
        pendingOps(client, tableName, id).length > 0,
        `${trail()}: dirty flag disagrees with the outbox for ${key}`,
      );
    }
  }

  settle(universe, trail);
  // Quarantined work is allowed to differ from the server until someone repairs it (§5.5),
  // so convergence is asserted after the repair the UI must offer: discard and re-pull.
  for (const client of universe.clients) {
    for (const transaction of new Set(client.quarantine.map((op) => op.txnId)))
      client.discardQuarantinedTxn(transaction);
  }
  settle(universe, trail);

  const snapshot = universe.server.snapshot(propertyScope);
  for (const [index, client] of universe.clients.entries()) {
    for (const row of ROWS) {
      const server = serverView(snapshot, row);
      assert.equal(
        view(client, row),
        server,
        `${trail()}: device ${index} settled ${row} at ${view(client, row)}, server at ${server}`,
      );
    }
    assert.deepEqual(client.quarantine, [], `${trail()}: device ${index} still holds quarantined work`);
  }
}

function settle(universe: Universe, trail: () => string): void {
  const rounds: string[] = [];
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    const before = syncState(universe);
    rounds.push(before);
    for (const client of universe.clients) {
      universe.now += 1;
      client.sync(universe.server, propertySchemaHash);
    }
    if (before === syncState(universe)) return;
  }
  throw new Error(`${trail()}: the universe never settled, rounds ${rounds.join(" -> ")} -> ${syncState(universe)}`);
}

function syncState(universe: Universe): string {
  return universe.clients
    .map(
      (client) =>
        `${client.lastServerSeq}:${client.outbox.length}:${client.quarantine.length}:${client.resyncRequired}`,
    )
    .join("|");
}

/** Replaying from scratch keeps every explored state independent and deterministic. */
function replay(history: readonly Action[]): Universe {
  const state = { now: 1_700_000_000_000 };
  const clock = () => state.now;
  const universe: Universe = {
    server: new WeftServer(clock),
    clients: Array.from(
      { length: DEVICES },
      (_, index) => new WeftClient(propertyScope, `device-${index}` as DeviceId, propertySchema, clock),
    ),
    steps: 0,
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
  };

  for (const action of history) {
    universe.steps += 1;
    apply(universe, action);
  }
  return universe;
}

function apply(universe: Universe, action: Action): void {
  switch (action.kind) {
    case "world":
      return applyWorld(universe, action.name);
    case "device":
      return applyDevice(universe, action.device, action.name);
    case "row":
      return applyRow(universe, action.device, action.row, action.name);
  }
}

function applyWorld(universe: Universe, name: WorldActionName): void {
  switch (name) {
    case "tick":
      universe.now += 1;
      return;
    case "prune":
      // Long enough that every delete so far is below the floor, so purge and cursor
      // interactions are reachable at all. The jump is relative to now, so a prune behaves
      // the same whichever era of the history it lands in.
      universe.now += TOMBSTONE_FLOOR_MS + 1;
      universe.server.pruneTombstones(propertyScope, TOMBSTONE_FLOOR_MS);
      return;
  }
}

function applyDevice(universe: Universe, device: number, name: DeviceActionName): void {
  const client = universe.clients[device];
  if (client === undefined) return;
  switch (name) {
    case "sync":
      client.sync(universe.server, propertySchemaHash);
      return;
    case "pull":
      client.applyPull(universe.server.pull(propertyScope, client.lastServerSeq));
      return;
    case "resync":
      client.applySnapshot(universe.server.snapshot(propertyScope));
      return;
  }
}

function applyRow(universe: Universe, device: number, row: RowId, name: RowActionName): void {
  const client = universe.clients[device];
  if (client === undefined) return;
  const state: LocalRowState = localState(client, TASKS, row);
  const transaction = txnId(`${name}-${device}-${universe.steps}`);
  const title = `t${universe.steps}`;

  switch (name) {
    case "create":
      if (state === "absent") client.create(TASKS, row, { [TITLE]: title }, transaction);
      return;
    case "update":
      if (state === "live") client.update(TASKS, row, { [TITLE]: title }, transaction);
      return;
    case "delete":
      if (state === "live") client.delete(TASKS, row, transaction);
      return;
    case "restore":
      if (state === "tombstoned") client.restore(TASKS, row, { [TITLE]: title }, transaction);
      return;
  }
}

function describe(action: Action): string {
  switch (action.kind) {
    case "row":
      return `${action.name}(d${action.device}, ${action.row})`;
    case "device":
      return `${action.name}(d${action.device})`;
    case "world":
      return `${action.name}()`;
  }
}

/**
 * How a row stands. Liveness is three-way rather than two because the three states admit
 * different moves: an absent row can be created, a tombstoned one can only be restored, and
 * on the server a purged row accepts a `create` that a tombstoned one rejects.
 */
type RowView = { readonly liveness: "absent" | "tomb" } | { readonly liveness: "live"; readonly title: string };

function clientRowView(client: WeftClient, row: RowId): RowView {
  const materialized = client.getRow(TASKS, row);
  if (materialized !== undefined) return { liveness: "live", title: wireText(materialized.fields.get(TITLE) ?? "") };
  return { liveness: client.tombstones.has(localKey(TASKS, row)) ? "tomb" : "absent" };
}

function serverRowView(snapshot: Snapshot, row: RowId): RowView {
  const record = snapshot.rows.find((candidate) => candidate.rowId === row);
  if (record === undefined) return { liveness: "absent" };
  if (record.deletedHlc !== null) return { liveness: "tomb" };
  return {
    liveness: "live",
    title: wireText(snapshot.fields.find((field) => field.rowId === row && field.field === TITLE)?.value ?? ""),
  };
}

/**
 * The state a device would show a user: liveness plus the visible value. Timestamps and
 * sequence numbers are deliberately excluded, or every path would look distinct and the
 * search would never collapse. A tombstone and a purge look identical from here, which is the
 * point — the user is shown "gone" either way, and the server must agree.
 */
function view(client: WeftClient, row: RowId): string {
  const local = clientRowView(client, row);
  return local.liveness === "live" ? `live:${local.title}` : "gone";
}

function serverView(snapshot: Snapshot, row: RowId): string {
  const record = serverRowView(snapshot, row);
  return record.liveness === "live" ? `live:${record.title}` : "gone";
}

/** Two histories reaching the same fingerprint continue identically, so one is enough. */
function fingerprint(universe: Universe): string {
  const snapshot = universe.server.snapshot(propertyScope);
  const rows = ROWS.map((row) =>
    relabel([serverRowView(snapshot, row), ...universe.clients.map((client) => clientRowView(client, row))]),
  );
  const clients = universe.clients.map((client) =>
    [
      // Op order across rows is kept: the server stops at the first rejected transaction, so
      // what sits behind it in the outbox decides what the next flush manages to deliver.
      client.outbox.map((op) => `${ROWS.indexOf(op.rowId)}${op.kind}`).join(","),
      client.quarantine.map((op) => `${ROWS.indexOf(op.rowId)}${op.reason}`).join(","),
      cursor(universe, client),
      client.resyncRequired ? "resync" : "incremental",
    ].join("/"),
  );
  return `${rows.join("||")}##${clients.join("||")}`;
}

/**
 * Titles are minted fresh at every step, so which strings a state holds carries no meaning —
 * only which of the holders agree. Relabelling them by first appearance collapses the
 * histories that differ in spelling alone; without it almost nothing would dedupe and two
 * rows would put the search far out of budget.
 */
function relabel(views: readonly RowView[]): string {
  const labels = new Map<string, string>();
  return views
    .map((row) => {
      if (row.liveness !== "live") return row.liveness;
      const label = labels.get(row.title) ?? String.fromCodePoint(97 + labels.size);
      labels.set(row.title, label);
      return `live:${label}`;
    })
    .join("/");
}

/**
 * Where a device's cursor sits relative to the scope. Below the floor is its own class rather
 * than more "behind": what the device missed has been hard-purged, so its next handshake is
 * answered with a resync instead of an incremental batch (§5.9).
 */
function cursor(universe: Universe, client: WeftClient): "current" | "behind" | "purged" {
  const scope = universe.server.scopes.get(propertyScope);
  if (client.lastServerSeq < (scope?.tombstoneFloorSeq ?? 0)) return "purged";
  return client.lastServerSeq === (scope?.serverSeq ?? 0) ? "current" : "behind";
}
