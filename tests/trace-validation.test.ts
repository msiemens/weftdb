// Trace validation: the link between the specification and the code.
//
// The TLA+ model in spec/ proves things about a protocol. On its own it says nothing about
// this implementation, because nothing connects the two. This does: it drives the real client
// and server through the actions the specification models, records the abstract state after
// every step, and hands the resulting behaviour to TLC — which checks that each recorded
// transition is one the specification permits, and that the invariants hold at every step.
//
// A failure here means one of two things, and both are worth knowing: the implementation does
// something the protocol does not allow, or the specification does not describe the protocol
// that was built.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { rowId, txnId, type RowId } from "weftdb/shared";
import { WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import {
  BASE_TIME,
  localState,
  propertySchema,
  propertyScope,
  TASKS,
  TITLE,
  TOMBSTONE_FLOOR_MS,
} from "./property-model.ts";

const TLC = process.env["WEFT_TLC"] ?? "tlc";
const SPEC_DIRECTORY = join(process.cwd(), "spec");

/** The specification's constants: two devices, two rows, named as the model names them. */
const DEVICES = ["d1", "d2"] as const;
const ROWS = ["r1", "r2"] as const;
const ROW_IDS: Readonly<Record<(typeof ROWS)[number], RowId>> = { r1: rowId("r1"), r2: rowId("r2") };

type SpecRowState = "absent" | "live" | "deleted";
type SpecOp = "none" | "create" | "write" | "delete" | "restore";

/** One row of the specification's state, as observed in the implementation. */
interface SpecState {
  readonly serverState: Readonly<Record<string, SpecRowState>>;
  readonly serverRowSeq: Readonly<Record<string, number>>;
  readonly serverSeq: number;
  readonly floor: number;
  readonly cursor: Readonly<Record<string, number>>;
  readonly view: Readonly<Record<string, Readonly<Record<string, SpecRowState>>>>;
  readonly outbox: Readonly<Record<string, Readonly<Record<string, SpecOp>>>>;
  readonly quarantined: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  /** The client's `resyncRequired`: discarded work waiting for a snapshot to re-derive it. */
  readonly resyncing: Readonly<Record<string, boolean>>;
}

type ActionName =
  "localCreate" | "localWrite" | "localDelete" | "localRestore" | "push" | "repair" | "pull" | "resync" | "prune";

interface Action {
  readonly name: ActionName;
  readonly device: number;
  readonly row: number;
}

const actionArb: fc.Arbitrary<Action> = fc.record({
  name: fc.constantFrom<ActionName[]>(
    "localCreate",
    "localCreate",
    "localWrite",
    "localWrite",
    "localDelete",
    "localRestore",
    "push",
    "push",
    "push",
    "repair",
    "pull",
    "pull",
    "resync",
    "prune",
  ),
  device: fc.integer({ min: 0, max: DEVICES.length - 1 }),
  row: fc.integer({ min: 0, max: ROWS.length - 1 }),
});

test("recorded implementation behaviour is behaviour the specification allows", { timeout: 600_000 }, (t) => {
  let checked = 0;
  if (!hasTlc()) {
    t.skip("TLC is not on PATH; set WEFT_TLC to its path to run trace validation");
    return;
  }

  // Generated modules live beside WeftSync.tla: TLA+ resolves an INSTANCE from the module
  // search path, and TLC's is the directory it runs in.
  const traceDirectory = SPEC_DIRECTORY;
  mkdirSync(traceDirectory, { recursive: true });
  // WEFT_KEEP_TRACES=1 leaves the generated modules behind, which is the only practical way
  // to re-run TLC by hand on a failing trace.
  t.after(() => {
    if (process.env["WEFT_KEEP_TRACES"] === "1") return;
    for (const file of readdirSync(traceDirectory)) {
      if (/^WeftTrace\d/u.test(file)) rmSync(join(traceDirectory, file), { force: true });
    }
  });

  // A handful of independent histories rather than one long one: each is checked end to end,
  // and a short counterexample is worth more than a long one.
  const histories = fc.sample(fc.array(actionArb, { minLength: 16, maxLength: 40 }), { numRuns: 12, seed: 20_260_824 });

  for (const [index, history] of histories.entries()) {
    const trace = record(history);
    // A history whose steps were all preconditions the implementation declined records a
    // single state and has nothing to check. The total-states guard below keeps the test
    // from quietly becoming all such histories.
    if (trace.length < 2) continue;

    const module = `WeftTrace${index}`;
    writeFileSync(join(traceDirectory, `${module}.tla`), traceModule(module, trace));
    writeFileSync(join(traceDirectory, `${module}.cfg`), checkConfig());

    const output = runTlc(traceDirectory, module);
    const context = `history ${index} (${trace.length} recorded states)\nactions: ${history.map(describe).join(" -> ")}`;
    assert.equal(
      /Model checking completed\. No error has been found/u.test(output),
      true,
      `${context} is not a behaviour of the specification:\n${summarise(output)}`,
    );
    // Every recorded transition must have been taken. A trace TLC abandoned early would
    // otherwise pass silently, having checked only the part it could follow.
    assert.equal(depthOf(output), trace.length, `${context}: TLC followed only part of the trace`);
    checked += trace.length;
  }

  t.diagnostic(`checked ${checked} recorded states across ${histories.length} histories against the specification`);
  assert.equal(checked > 40, true, `only ${checked} states were checked; the histories are too thin to be meaningful`);
});

/** Drives the real client and server, recording the abstract state after every step. */
function record(history: readonly Action[]): readonly SpecState[] {
  const clock = { now: BASE_TIME };
  const server = new WeftServer(() => clock.now);
  const clients = DEVICES.map(
    (device) => new WeftClient(propertyScope, device as never, propertySchema, () => clock.now),
  );

  // Raw first, abstract second: sequence numbers are ranked against the set of transaction
  // boundaries the whole history went through, which is not known until it has run.
  const raw: RawState[] = [observe(server, clients)];
  for (const [step, action] of history.entries()) {
    apply(server, clients, clock, action, step);
    raw.push(observe(server, clients));
  }

  const rank = rankingOver(raw.map((state) => state.serverSeq));
  const trace: SpecState[] = [];
  for (const state of raw) {
    const next = abstract(state, rank);
    // Steps the implementation turned into no-ops (a precondition it did not meet) are
    // stuttering, which the specification allows and TLC would otherwise have to be told
    // about; dropping them keeps the trace to real transitions.
    if (trace.length === 0 || JSON.stringify(next) !== JSON.stringify(trace.at(-1))) trace.push(next);
  }
  return trace;
}

function apply(
  server: WeftServer,
  clients: readonly WeftClient[],
  clock: { now: number },
  action: Action,
  step: number,
): void {
  const client = clients[action.device];
  const row = ROW_IDS[ROWS[action.row] ?? "r1"];
  if (client === undefined) return;
  const transaction = txnId(`${action.name}-${action.device}-${step}`);
  const state = localState(client, TASKS, row);
  // The specification carries one pending operation per row where the client carries a
  // queue, so a row with something already queued takes no further local operation here.
  // Queued sequences are left to the model-checking configurations.
  const queued = client.outbox.some((op) => op.rowId === row);

  switch (action.name) {
    case "localCreate":
      if (state === "absent" && !queued) client.create(TASKS, row, { [TITLE]: `v${step}` }, transaction);
      return;
    case "localWrite":
      if (state === "live" && !queued) client.update(TASKS, row, { [TITLE]: `v${step}` }, transaction);
      return;
    case "localDelete":
      if (state === "live" && !queued) client.delete(TASKS, row, transaction);
      return;
    case "localRestore":
      if (state === "tombstoned" && !queued) client.restore(TASKS, row, { [TITLE]: `v${step}` }, transaction);
      return;
    case "push": {
      // The specification models a push as one row's one pending operation, while `flush`
      // sends the whole outbox — potentially several transactions across several rows in a
      // single step, which matches no single specification step. Those pushes are skipped
      // rather than recorded, so these traces cover single-transaction batches only. That is
      // a real gap in what trace validation says, and the reason the model-checking
      // configurations exist beside it: they explore batching the traces cannot reach.
      const rows = new Set(client.outbox.map((op) => op.rowId));
      const transactions = new Set(client.outbox.map((op) => op.txnId));
      if (rows.size > 1 || transactions.size > 1) return;
      client.flush(server);
      return;
    }
    case "repair":
      for (const quarantined of new Set(client.quarantine.map((op) => op.txnId)))
        client.discardQuarantinedTxn(quarantined);
      return;
    case "pull":
      client.applyPull(server.pull(propertyScope, client.lastServerSeq));
      if (client.resyncRequired) client.applySnapshot(server.snapshot(propertyScope));
      return;
    case "resync":
      client.applySnapshot(server.snapshot(propertyScope));
      return;
    case "prune":
      clock.now += TOMBSTONE_FLOOR_MS + 1;
      server.pruneTombstones(propertyScope, TOMBSTONE_FLOOR_MS);
      return;
  }
}

/** What the implementation shows, before any of it is abstracted. */
interface RawState {
  readonly serverSeq: number;
  readonly floor: number;
  readonly rows: Readonly<Record<string, { readonly state: SpecRowState; readonly seq: number } | undefined>>;
  readonly cursor: Readonly<Record<string, number>>;
  readonly view: Readonly<Record<string, Readonly<Record<string, SpecRowState>>>>;
  readonly outbox: Readonly<Record<string, Readonly<Record<string, SpecOp>>>>;
  readonly quarantined: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  readonly resyncing: Readonly<Record<string, boolean>>;
}

function observe(server: WeftServer, clients: readonly WeftClient[]): RawState {
  const snapshot = server.snapshot(propertyScope);
  const scope = server.scopes.get(propertyScope);
  return {
    serverSeq: scope?.serverSeq ?? 0,
    floor: scope?.tombstoneFloorSeq ?? 0,
    rows: Object.fromEntries(
      ROWS.map((name) => {
        const record = snapshot.rows.find((candidate) => candidate.rowId === ROW_IDS[name]);
        return [
          name,
          record === undefined
            ? undefined
            : { state: record.deletedHlc === null ? "live" : "deleted", seq: record.serverSeq },
        ];
      }),
    ),
    cursor: Object.fromEntries(clients.map((client, index) => [DEVICES[index] ?? "d1", client.lastServerSeq])),
    view: Object.fromEntries(
      clients.map((client, index) => [
        DEVICES[index] ?? "d1",
        Object.fromEntries(ROWS.map((name) => [name, viewOf(client, ROW_IDS[name])])),
      ]),
    ),
    outbox: Object.fromEntries(
      clients.map((client, index) => [
        DEVICES[index] ?? "d1",
        Object.fromEntries(ROWS.map((name) => [name, pendingOp(client, ROW_IDS[name])])),
      ]),
    ),
    quarantined: Object.fromEntries(
      clients.map((client, index) => [
        DEVICES[index] ?? "d1",
        Object.fromEntries(ROWS.map((name) => [name, client.quarantine.some((op) => op.rowId === ROW_IDS[name])])),
      ]),
    ),
    resyncing: Object.fromEntries(clients.map((client, index) => [DEVICES[index] ?? "d1", client.resyncRequired])),
  };
}

/**
 * Sequence numbers are ranked by transaction boundary, not copied. The implementation hands
 * out one number per field written, so a row's record sits *below* the head its transaction
 * ended on, while the specification counts one per accepted operation and has them equal.
 * Ranking each number to the first observed head at or above it collapses a transaction's
 * numbers onto that transaction — which is exactly the distinction the protocol relies on,
 * because a device's cursor is only ever a head.
 */
function abstract(raw: RawState, rank: (value: number) => number): SpecState {
  return {
    serverSeq: rank(raw.serverSeq),
    floor: rank(raw.floor),
    serverState: Object.fromEntries(ROWS.map((name) => [name, raw.rows[name]?.state ?? "absent"])),
    serverRowSeq: Object.fromEntries(
      ROWS.map((name) => {
        const record = raw.rows[name];
        return [name, record === undefined ? 0 : rank(record.seq)];
      }),
    ),
    cursor: Object.fromEntries(Object.entries(raw.cursor).map(([device, value]) => [device, rank(value)])),
    view: raw.view,
    outbox: raw.outbox,
    quarantined: raw.quarantined,
    resyncing: raw.resyncing,
  };
}

function viewOf(client: WeftClient, row: RowId): SpecRowState {
  const state = localState(client, TASKS, row);
  return state === "live" ? "live" : state === "tombstoned" ? "deleted" : "absent";
}

/**
 * The specification carries one pending op per row; the client carries a queue. The op that
 * matters is the one that decides what the push will do to the liveness register, which is
 * the last row-level op queued, or a plain write if only fields are pending.
 */
function pendingOp(client: WeftClient, row: RowId): SpecOp {
  const queued = client.outbox.filter((op) => op.rowId === row);
  if (queued.length === 0) return "none";
  const lifecycle = queued.filter((op) => op.kind !== "set").at(-1);
  if (lifecycle === undefined) return "write";
  return lifecycle.kind === "append" ? "create" : lifecycle.kind;
}

/**
 * Ranks a sequence number as the position of the first transaction boundary at or above it.
 * Heads are the boundaries: a cursor is always a head, so this preserves every comparison the
 * specification makes while collapsing a transaction's several numbers into one.
 */
function rankingOver(heads: readonly number[]): (value: number) => number {
  const boundaries = [...new Set([0, ...heads])].sort((left, right) => left - right);
  return (value) => {
    const index = boundaries.findIndex((boundary) => boundary >= value);
    return index === -1 ? boundaries.length - 1 : index;
  };
}

function traceModule(name: string, trace: readonly SpecState[]): string {
  const states = trace
    .map((state) =>
      [
        "        [",
        `          serverState |-> ${record_(state.serverState, quoted)},`,
        `          serverRowSeq |-> ${record_(state.serverRowSeq, String)},`,
        `          serverSeq |-> ${state.serverSeq},`,
        `          floor |-> ${state.floor},`,
        `          cursor |-> ${record_(state.cursor, String)},`,
        `          view |-> ${record_(state.view, (rows) => record_(rows, quoted))},`,
        `          outbox |-> ${record_(state.outbox, (rows) => record_(rows, quoted))},`,
        `          quarantined |-> ${record_(state.quarantined, (rows) => record_(rows, (value) => (value ? "TRUE" : "FALSE")))},`,
        `          resyncing |-> ${record_(state.resyncing, (value) => (value ? "TRUE" : "FALSE"))}`,
        "        ]",
      ].join("\n"),
    )
    .join(",\n");

  return `---- MODULE ${name} ----
\\* Generated by tests/trace-validation.test.ts: one record per observed state of the
\\* implementation, in order, plus the definitions that ask TLC whether the specification
\\* allows that behaviour. It is one module because the recorded states name model values
\\* (d1, r1, …), which only exist where they are declared as constants.
EXTENDS Naturals, Sequences, TLC

\\* The individual model values are constants so the trace can name them; the sets below are
\\* what the specification is instantiated with.
CONSTANTS Devices, Rows, MaxSeq, PullChecksFloor, FloorRisesFirst, d1, d2, r1, r2

VARIABLES serverState, serverRowSeq, serverSeq, floor, purging, purgeSeq,
          cursor, view, outbox, quarantined, resyncing, index

Sync == INSTANCE WeftSync

Trace ==
    <<
${states}
    >>

\\* Pruning is two steps in the specification so its window is reachable; the implementation
\\* takes both in one synchronous pass. The purge bookkeeping is therefore not recorded — it
\\* is internal to the specification's model of prune.
Matches(state) ==
    /\\ serverState = [r \\in Rows |-> state.serverState[r]]
    /\\ serverRowSeq = [r \\in Rows |-> state.serverRowSeq[r]]
    /\\ serverSeq = state.serverSeq
    /\\ floor = state.floor
    /\\ cursor = [d \\in Devices |-> state.cursor[d]]
    /\\ view = [d \\in Devices |-> [r \\in Rows |-> state.view[d][r]]]
    /\\ outbox = [d \\in Devices |-> [r \\in Rows |-> state.outbox[d][r]]]
    /\\ quarantined = [d \\in Devices |-> [r \\in Rows |-> state.quarantined[d][r]]]
    /\\ resyncing = [d \\in Devices |-> state.resyncing[d]]

\\* The next state is constrained variable by variable rather than by priming Matches: TLC
\\* cannot push a prime inside an operator application.
MatchesNext(state) ==
    /\\ serverState' = [r \\in Rows |-> state.serverState[r]]
    /\\ serverRowSeq' = [r \\in Rows |-> state.serverRowSeq[r]]
    /\\ serverSeq' = state.serverSeq
    /\\ floor' = state.floor
    /\\ cursor' = [d \\in Devices |-> state.cursor[d]]
    /\\ view' = [d \\in Devices |-> [r \\in Rows |-> state.view[d][r]]]
    /\\ outbox' = [d \\in Devices |-> [r \\in Rows |-> state.outbox[d][r]]]
    /\\ quarantined' = [d \\in Devices |-> [r \\in Rows |-> state.quarantined[d][r]]]
    /\\ resyncing' = [d \\in Devices |-> state.resyncing[d]]

TraceInit ==
    /\\ index = 1
    /\\ purging = {}
    /\\ purgeSeq = [r \\in Rows |-> 0]
    /\\ Matches(Trace[1])

TraceNext ==
    /\\ index < Len(Trace)
    /\\ index' = index + 1
    /\\ MatchesNext(Trace[index + 1])
    /\\ Sync!Next

TraceSpec == TraceInit /\\ [][TraceNext]_<<serverState, serverRowSeq, serverSeq, floor,
    purging, purgeSeq, cursor, view, outbox, quarantined, resyncing, index>>

\\* Every recorded state must satisfy the specification's own invariants.
TraceTypeOK == Sync!TypeOK
TraceConsistent == Sync!Consistent
====
`;
}

function checkConfig(): string {
  // The bounds are irrelevant here: TLC follows one recorded behaviour rather than exploring,
  // so MaxSeq only has to be large enough to type-check the ranked sequence numbers.
  return `SPECIFICATION TraceSpec

CONSTANTS
    d1 = d1
    d2 = d2
    r1 = r1
    r2 = r2
    Devices = {d1, d2}
    Rows = {r1, r2}
    MaxSeq = 60
    PullChecksFloor = TRUE
    FloorRisesFirst = TRUE

INVARIANT TraceTypeOK
INVARIANT TraceConsistent

\\* A finite trace runs out of steps at its end, which is not a deadlock. That the whole trace
\\* was consumed is checked by comparing TLC's search depth against its length instead.
CHECK_DEADLOCK FALSE
`;
}

/**
 * A TLA+ *function* keyed by model values, written with `:>` and `@@` from the TLC module —
 * not a record. The specification indexes by the model values `d1`, `r1` and so on, and a
 * record's fields are strings, which those are not.
 */
function record_<Value>(entries: Readonly<Record<string, Value>>, format: (value: Value) => string): string {
  const pairs = Object.entries(entries).map(([key, value]) => `${key} :> ${format(value)}`);
  return `(${pairs.join(" @@ ")})`;
}

function quoted(value: string): string {
  return `"${value}"`;
}

function runTlc(directory: string, module: string): string {
  try {
    return execFileSync(TLC, ["-config", `${module}.cfg`, `${module}.tla`], {
      cwd: directory,
      encoding: "utf8",
      timeout: 120_000,
    });
  } catch (error) {
    const failure = error as { readonly stdout?: string; readonly stderr?: string; readonly message: string };
    return failure.stdout ?? failure.stderr ?? failure.message;
  }
}

function depthOf(output: string): number {
  const depth = /The depth of the complete state graph search is (\d+)/u.exec(output);
  return depth === null ? 0 : Number(depth[1]);
}

function summarise(output: string): string {
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-25)
    .join("\n");
}

function hasTlc(): boolean {
  if (existsSync(TLC)) return true;
  try {
    execFileSync(TLC, ["-help"], { encoding: "utf8", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

function describe(action: Action): string {
  return `${action.name}(d${action.device}, r${action.row})`;
}
