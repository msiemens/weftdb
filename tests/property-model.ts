// The world model the §9 property suite runs against. N simulated devices and one server in
// one scope, plus a neighbouring scope reusing the same row ids, so cross-scope isolation is
// exercised by every generated history.
//
// Commands are fast-check `Command`s, so histories are generated, replayed and shrunk by
// fast-check instead of by a hand-rolled seed loop. Every command asserts the world
// invariants in `property-invariants.ts` after it runs.
import fc from "fast-check";
import {
  deviceId,
  encodeHlc,
  fieldName,
  rankBetween,
  rowId,
  scopeId,
  tableName,
  txnId,
  wireText,
  type FieldName,
  type HlcString,
  type RankString,
  type RowId,
  type SchemaHash,
  type ScopeId,
  type TableName,
  type TxnId,
  type WeftOp,
  type WireValue,
} from "weftdb/core";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { inProcessTransport, type MaterializedRow, planRetentionDeletes, WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { assertWorldInvariants } from "./property-invariants.ts";

export const propertySchema = defineSchema({
  tasks: S.collection({
    title: S.string(),
    status: S.string(),
    notes: S.string({ merge: "diff3" }),
    rank: S.string({ merge: "fracIndex" }),
    consumed_at: S.number({ nullable: true, retentionAnchor: true }),
    auto_delete_days: S.number({ nullable: true }),
  }),
  invoices: S.collection(
    {
      total_override: S.number({ nullable: true }),
    },
    {
      line_items: S.hasMany("line_items", "id", "invoice_id"),
    },
  ),
  line_items: S.collection({
    invoice_id: S.string(),
    amount: S.number(),
  }),
  task_status_history: S.eventLog({
    task_id: S.string(),
    status: S.string(),
  }),
});

export const propertySchemaHash = schemaHash(propertySchema);

/**
 * The next release of the same application, one more nullable field, one higher version.
 * A device running it rolls the scope forward and locks out the ones that have not updated
 * (§5.10), which is what the upgrade command models.
 */
export const upgradedSchema = defineSchema(
  {
    ...propertySchema.collections,
    tasks: S.collection({
      title: S.string(),
      status: S.string(),
      notes: S.string({ merge: "diff3" }),
      rank: S.string({ merge: "fracIndex" }),
      consumed_at: S.number({ nullable: true, retentionAnchor: true }),
      auto_delete_days: S.number({ nullable: true }),
      priority: S.number({ nullable: true }),
    }),
  },
  2,
);

export const upgradedSchemaHash = schemaHash(upgradedSchema);
export const propertyScope = scopeId("property-scope");
export const neighbourScope = scopeId("neighbour-scope");

export const TASKS = tableName("tasks");
export const EVENTS = tableName("task_status_history");
export const INVOICES = tableName("invoices");
export const LINE_ITEMS = tableName("line_items");

export const TITLE = fieldName("title");
export const STATUS = fieldName("status");
export const NOTES = fieldName("notes");
export const RANK = fieldName("rank");
export const CONSUMED_AT = fieldName("consumed_at");
export const AUTO_DELETE_DAYS = fieldName("auto_delete_days");
export const INVOICE_ID = fieldName("invoice_id");
export const AMOUNT = fieldName("amount");
export const OVERRIDE = fieldName("total_override");

/**
 * Run counts. Cheap properties run far more cases than ones that build and settle a whole
 * world; both are env-tunable for a longer soak, and `WEFT_PROPERTY_SEED` pins the seed so
 * a reported counterexample can be replayed.
 */
export const PROPERTY_RUNS = positiveInteger(process.env["WEFT_PROPERTY_RUNS"]) ?? 1_000;
export const SCENARIO_RUNS = positiveInteger(process.env["WEFT_SCENARIO_RUNS"]) ?? 200;
export const WORLD_RUNS = positiveInteger(process.env["WEFT_WORLD_RUNS"]) ?? 300;

const configuredSeed = anyInteger(process.env["WEFT_PROPERTY_SEED"]);
if (configuredSeed !== undefined) fc.configureGlobal({ seed: configuredSeed });

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Any integer, because fast-check reports about half its seeds negative. */
function anyInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return value !== undefined && value !== "" && Number.isInteger(parsed) ? parsed : undefined;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const TOMBSTONE_FLOOR_MS = 30 * DAY_MS;
export const BASE_TIME = 1_700_000_000_000;
export const BASE_NOTES = "alpha\nbravo\ncharlie\ndelta";

export interface PropertyDevice {
  readonly client: WeftClient;
  /** Every HLC this device's clock handed out, in emission order. */
  readonly emittedHlcs: HlcString[];
  /** Indices in `emittedHlcs` where a skew correction re-stamped the clock (§5.5). */
  readonly restampedAt: Set<number>;
  online: boolean;
  /** This device's clock offset from the server's, which skew rejection reacts to. */
  skewMs: number;
  /** The schema hash this device's build presents at handshake (§5.10). */
  schemaHash: SchemaHash;
}

/** Everything that reached the server, recorded so invariants can inspect the wire. */
export interface WorldTrace {
  readonly pushed: WeftOp[];
  /** Ops the server accepted, in acceptance order. */
  readonly accepted: WeftOp[];
  readonly acked: Set<TxnId>;
  /** `table\0row\0field` for every field the application explicitly wrote. */
  readonly written: Set<string>;
  /**
   * The value each device's application last put in a field, keyed `device\0table\0row\0field`.
   * The client's own queues cannot answer this once a write has been set aside, because
   * quarantined ops are never superseded by a later edit (§5.5 makes them the person's to decide
   * about); the op just sits there holding the value it captured, regardless of what the field
   * goes on to hold.
   */
  readonly lastWrites: Map<string, WireValue>;
  /** Base-field values as first observed, for the immutability invariant. */
  readonly baseFields: Map<string, WireValue>;
  /** Highest schema version the scope has reached, for the monotonicity invariant. */
  highestSchemaVersion: number;
  /**
   * Highest `_weft_rev` seen per device and row, for the monotonicity invariant. Dropped when
   * the row leaves a device, because the next life of a row starts its revisions again.
   */
  readonly revHighWater: Map<string, number>;
}

export interface PropertyWorld {
  readonly scopeId: ScopeId;
  readonly server: WeftServer;
  readonly devices: readonly PropertyDevice[];
  readonly neighbour: PropertyDevice;
  readonly trace: WorldTrace;
  now: number;
  txnCounter: number;
}

/** Lets a property run a generated history against a persistent server instead of memory. */
export type ServerFactory = (now: () => number) => WeftServer;

export function createWorld(deviceCount = 3, makeServer: ServerFactory = (now) => new WeftServer(now)): PropertyWorld {
  const state = { now: BASE_TIME };
  const clock = () => state.now;
  const trace: WorldTrace = {
    pushed: [],
    accepted: [],
    acked: new Set(),
    written: new Set(),
    lastWrites: new Map(),
    baseFields: new Map(),
    highestSchemaVersion: 0,
    revHighWater: new Map(),
  };
  const server = recordPushes(makeServer(clock), trace);
  const devices = Array.from({ length: deviceCount }, (_, index) =>
    makeDevice(`device-${index}`, propertyScope, clock, trace),
  );
  return {
    scopeId: propertyScope,
    server,
    devices,
    neighbour: makeDevice("neighbour", neighbourScope, clock, trace),
    trace,
    txnCounter: 0,
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
  };
}

function recordPushes(server: WeftServer, trace: WorldTrace): WeftServer {
  const target = server as unknown as { push: WeftServer["push"] };
  const original = target.push.bind(server);
  target.push = (scope, ops) => {
    trace.pushed.push(...ops.map((op) => ({ ...op })));
    const result = original(scope, ops);
    // A failed push can still have applied the transactions before the rejected one, and those
    // are as accepted as any other, since the client is told about them and drains them.
    const applied = new Set(result.acks?.map((ack) => ack.txnId) ?? []);
    const landed = result.ok ? ops : ops.filter((op) => applied.has(op.txnId));
    trace.accepted.push(...landed.map((op) => ({ ...op })));
    for (const txn of applied) trace.acked.add(txn);
    assertCertifiedWritesLanded(server, scope, landed);
    return result;
  };
  return server;
}

/**
 * §5.4: a `set` carrying a base hash was checked against the value it claims to follow, so a
 * push that accepts it has to be holding it afterwards. Accepting a write and then discarding
 * it by some other rule is the one failure a client cannot detect, since it is told the push
 * succeeded, and convergence cannot see it either, since every device happily agrees on the
 * value that replaced the one they were promised.
 */
function assertCertifiedWritesLanded(server: WeftServer, scope: ScopeId, ops: readonly WeftOp[]): void {
  const certified = new Map<string, WireValue>();
  for (const op of ops) {
    // Last write wins within the batch, so an earlier one being overwritten here is ordinary.
    if (op.kind === "set" && op.baseHash !== undefined)
      certified.set(writeKey(op.tableName, op.rowId, op.field), op.value);
  }
  if (certified.size === 0) return;
  for (const record of server.snapshot(scope).fields) {
    const expected = certified.get(writeKey(record.tableName, record.rowId, record.field));
    if (expected === undefined) continue;
    if (JSON.stringify(record.value) !== JSON.stringify(expected)) {
      throw new Error(
        `§5.4: ${record.tableName}.${record.field} was accepted as a fast-forward and then dropped: ` +
          `server holds ${JSON.stringify(record.value)}, accepted ${JSON.stringify(expected)}`,
      );
    }
  }
}

/** A device whose clock can drift from the server's, so skew rejection is reachable. */
function makeDevice(id: string, scope: ScopeId, now: () => number, trace: WorldTrace): PropertyDevice {
  const drift = { skewMs: 0 };
  const device: PropertyDevice = {
    // Each device gets its own schema object, so an upgrade bumps the version this build
    // presents without touching what the other devices are running.
    client: new WeftClient(scope, deviceId(id), { ...propertySchema }, () => now() + drift.skewMs),
    emittedHlcs: [],
    restampedAt: new Set<number>(),
    online: true,
    schemaHash: propertySchemaHash,
    get skewMs() {
      return drift.skewMs;
    },
    set skewMs(value: number) {
      drift.skewMs = value;
    },
  };
  return instrument(device, trace);
}

/** Moves one device onto the next release, as a rolling update would. */
export function upgradeDevice(device: PropertyDevice): void {
  (device.client.schema as { schemaVersion: number }).schemaVersion = upgradedSchema.schemaVersion;
  device.schemaHash = upgradedSchemaHash;
}

type MutationCall = (table: TableName, row: RowId, values: Record<FieldName, WireValue>, txn?: TxnId) => Promise<void>;

function instrument(device: PropertyDevice, trace: WorldTrace): PropertyDevice {
  const clock = device.client.clock as unknown as {
    next(observed?: HlcString): HlcString;
    restampAfterSkew(serverWallMs: number): HlcString;
  };
  const emit = clock.next.bind(clock);
  clock.next = (observed?: HlcString): HlcString => {
    const hlc = observed === undefined ? emit() : emit(observed);
    device.emittedHlcs.push(hlc);
    return hlc;
  };
  const restamp = clock.restampAfterSkew.bind(clock);
  clock.restampAfterSkew = (serverWallMs: number): HlcString => {
    const hlc = restamp(serverWallMs);
    device.restampedAt.add(device.emittedHlcs.length);
    device.emittedHlcs.push(hlc);
    return hlc;
  };

  const client = device.client as unknown as { create: MutationCall; update: MutationCall; restore: MutationCall };
  for (const name of ["create", "update", "restore"] as const) {
    const original = client[name].bind(device.client);
    // The wrapper hands back the mutator's own promise, so a caller that awaits a write is
    // waiting on the write and a refusal reaches the caller as its own rejection.
    client[name] = async (table, row, values, txn) => {
      const fields = name === "update" ? Object.keys(values) : [...Object.keys(values), "id", "scope_id", "created"];
      for (const field of fields) trace.written.add(writeKey(table, row, fieldName(field)));
      await original(table, row, values, txn);
      // Read back from the row after the call, because `create` fills in `created` itself, and
      // what the row ends up holding is what the application asked for either way.
      const written = device.client.getRow(table, row)?.fields;
      for (const field of fields) {
        const value = written?.get(fieldName(field));
        if (value !== undefined) {
          trace.lastWrites.set(`${device.client.deviceId}\0${writeKey(table, row, fieldName(field))}`, value);
        }
      }
    };
  }
  return device;
}

export function writeKey(table: TableName, row: RowId, field: FieldName): string {
  return `${localKey(table, row)}\0${field}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Row ids in play. The abstract model stays small, because every command's precondition is a
 * question about one device's real local state, which the model cannot mirror without
 * reimplementing merge, so commands re-read it and no-op when they do not apply.
 */
export interface WorldModel {
  readonly rows: readonly RowId[];
  readonly invoices: readonly RowId[];
}

export const MODEL_ROWS = ["row-0", "row-1", "row-2", "row-3", "row-4"].map(rowId);
export const MODEL_INVOICES = ["invoice-0", "invoice-1", "invoice-2"].map(rowId);

export function initialModel(): WorldModel {
  return { rows: MODEL_ROWS, invoices: MODEL_INVOICES };
}

export type WorldCommand = fc.AsyncCommand<WorldModel, PropertyWorld, true>;

/**
 * Wraps an action so every command checks the world invariants after it runs.
 *
 * Asynchronous, because a command writes through the client and a write settles when it has
 * committed. A history driven synchronously would leave each command's write in flight while the
 * next one ran, so the invariants would be checked against a world half of whose history had not
 * happened yet.
 */
function command(
  label: string,
  execute: (model: WorldModel, world: PropertyWorld) => void | Promise<void>,
): WorldCommand {
  return {
    check: async () => true,
    run: async (model, world) => {
      await execute(model, world);
      await assertWorldInvariants(world, label);
    },
    toString: () => label,
  };
}

function createTask(device: number, row: number, title: string, days: number): WorldCommand {
  return command(`create(d${device}, r${row})`, async (model, world) => {
    const target = deviceAt(world, device);
    const id = rowAt(model.rows, row);
    if (localState(target.client, TASKS, id) !== "absent") return;
    await target.client.create(
      TASKS,
      id,
      {
        [TITLE]: title,
        [STATUS]: "open",
        [NOTES]: BASE_NOTES,
        [RANK]: nextRank(target),
        [CONSUMED_AT]: world.now,
        [AUTO_DELETE_DAYS]: days,
      },
      nextTxn(world, "create"),
    );
  });
}

function updateTask(device: number, row: number, onTitle: boolean, value: string): WorldCommand {
  return command(`update(d${device}, r${row}, ${onTitle ? "title" : "status"})`, async (model, world) => {
    const target = deviceAt(world, device);
    const id = rowAt(model.rows, row);
    if (localState(target.client, TASKS, id) !== "live") return;
    await target.client.update(TASKS, id, { [onTitle ? TITLE : STATUS]: value }, nextTxn(world, "update"));
  });
}

function editNotes(device: number, row: number, line: number, text: string): WorldCommand {
  return command(`editNotes(d${device}, r${row}, line ${line})`, async (model, world) => {
    const target = deviceAt(world, device);
    const id = rowAt(model.rows, row);
    if (localState(target.client, TASKS, id) !== "live") return;
    const current = wireText(target.client.getRow(TASKS, id)?.fields.get(NOTES) ?? BASE_NOTES);
    await target.client.update(TASKS, id, { [NOTES]: replaceLine(current, line, text) }, nextTxn(world, "notes"));
  });
}

/**
 * Both devices edit the same prose field before either pushes, which is the only way to reach
 * the server's fast-forward check and the client's rebase behind it. Left to chance, the
 * generator reached that path only a handful of times per run, since two devices holding unsent
 * edits to the same field at the same moment is a coincidence, and the interesting behaviour is
 * all on the other side of it.
 */
function contendNotes(device: number, row: number, line: number, mine: string, theirs: string): WorldCommand {
  return command(`contendNotes(d${device}, r${row}, line ${line})`, async (model, world) => {
    const id = rowAt(model.rows, row);
    const first = deviceAt(world, device);
    const second = deviceAt(world, device + 1);
    if (first === second) return;
    for (const [target, text] of [
      [first, mine],
      [second, theirs],
    ] as const) {
      if (localState(target.client, TASKS, id) !== "live") return;
      const current = wireText(target.client.getRow(TASKS, id)?.fields.get(NOTES) ?? BASE_NOTES);
      await target.client.update(TASKS, id, { [NOTES]: replaceLine(current, line, text) }, nextTxn(world, "contend"));
    }
  });
}

function deleteTask(device: number, row: number): WorldCommand {
  return command(`delete(d${device}, r${row})`, async (model, world) => {
    const target = deviceAt(world, device);
    const id = rowAt(model.rows, row);
    if (localState(target.client, TASKS, id) !== "live") return;
    await target.client.delete(TASKS, id, nextTxn(world, "delete"));
  });
}

function restoreTask(device: number, row: number, title: string): WorldCommand {
  return command(`restore(d${device}, r${row})`, async (model, world) => {
    const target = deviceAt(world, device);
    const id = rowAt(model.rows, row);
    if (localState(target.client, TASKS, id) !== "tombstoned") return;
    await target.client.restore(TASKS, id, { [TITLE]: title }, nextTxn(world, "restore"));
  });
}

function appendEvent(device: number, row: number, status: string): WorldCommand {
  return command(`append(d${device}, r${row})`, async (model, world) => {
    const target = deviceAt(world, device);
    await target.client.append(
      EVENTS,
      rowId(`event-${world.txnCounter}`),
      {
        [fieldName("task_id")]: rowAt(model.rows, row),
        [fieldName("status")]: status,
      },
      nextTxn(world, "append"),
    );
  });
}

function createInvoiceWithLines(
  device: number,
  invoice: number,
  children: number,
  override: number | null,
): WorldCommand {
  return command(`createInvoice(d${device}, i${invoice}, ${children} children)`, async (model, world) => {
    const target = deviceAt(world, device);
    const id = rowAt(model.invoices, invoice);
    if (localState(target.client, INVOICES, id) !== "absent") return;
    await target.client.create(INVOICES, id, { [OVERRIDE]: override }, nextTxn(world, "invoice"));
    for (let index = 0; index < children; index += 1) {
      await target.client.create(
        LINE_ITEMS,
        rowId(`${id}-line-${world.txnCounter}`),
        {
          [INVOICE_ID]: id,
          [AMOUNT]: 50 * (index + 1),
        },
        nextTxn(world, "line"),
      );
    }
  });
}

function deleteInvoice(device: number, invoice: number): WorldCommand {
  return command(`deleteInvoice(d${device}, i${invoice})`, async (model, world) => {
    const target = deviceAt(world, device);
    const id = rowAt(model.invoices, invoice);
    if (localState(target.client, INVOICES, id) !== "live") return;
    await target.client.delete(INVOICES, id, nextTxn(world, "invoice-delete"));
  });
}

function togglePartition(device: number): WorldCommand {
  return command(`partition(d${device})`, (_model, world) => {
    const target = deviceAt(world, device);
    target.online = !target.online;
  });
}

function sync(device: number): WorldCommand {
  return command(`sync(d${device})`, async (_model, world) => {
    const target = deviceAt(world, device);
    if (!target.online) return;
    await target.client.syncWith(inProcessTransport(world.server), target.schemaHash);
  });
}

function pull(device: number): WorldCommand {
  return command(`pull(d${device})`, async (_model, world) => {
    const target = deviceAt(world, device);
    if (!target.online) return;
    await target.client.applyPull(world.server.pull(world.scopeId, target.client.lastServerSeq));
  });
}

function snapshotResync(device: number): WorldCommand {
  return command(`snapshotResync(d${device})`, async (_model, world) => {
    const target = deviceAt(world, device);
    if (!target.online) return;
    await target.client.applySnapshot(world.server.snapshot(world.scopeId));
  });
}

function duplicateDelivery(device: number): WorldCommand {
  return command(`duplicateDelivery(d${device})`, async (_model, world) => {
    const target = deviceAt(world, device);
    if (!target.online) return;
    // A transport that delivers the same batch twice. What is replayed is what the wire
    // actually carried, taken from the recording the push wrapper makes as each batch goes
    // out. Reading the outbox beforehand would replay stamps a rebase or a skew correction
    // changed during the sync, traffic no transport ever saw.
    const alreadySent = world.trace.pushed.length;
    await target.client.syncWith(inProcessTransport(world.server), target.schemaHash);
    const stillPending = new Set(target.client.outbox.map(opIdentity));
    const delivered = world.trace.pushed
      .slice(alreadySent)
      .filter((op) => op.kind === "set" && !stillPending.has(opIdentity(op)))
      .map((op) => ({ ...op }));
    if (delivered.length === 0) return;

    // Idempotence requires re-delivering an accepted op to leave the record *and* its sequence
    // number alone. Bumping the sequence number would make every other device re-pull a value
    // it already has.
    const before = JSON.stringify(world.server.snapshot(world.scopeId));
    world.server.push(world.scopeId, delivered);
    world.server.push(
      world.scopeId,
      delivered.map((op) => ({ ...op })),
    );
    if (JSON.stringify(world.server.snapshot(world.scopeId)) !== before) {
      throw new Error("re-delivering an accepted op changed server state");
    }
  });
}

function opIdentity(op: WeftOp): string {
  return [op.txnId, op.tableName, op.rowId, op.kind, op.kind === "set" ? op.field : ""].join("\0");
}

export type InjectedRejectionKind = "foreign-scope" | "clock-skew" | "absent-row" | "half-valid";

function injectRejection(device: number, kind: InjectedRejectionKind, row: number): WorldCommand {
  return command(`injectRejection(${kind}, r${row})`, (model, world) => {
    const target = deviceAt(world, device);
    const before = serverRowFingerprints(world);
    const result = world.server.push(world.scopeId, [
      ...injectedRejection(world, target, kind, rowAt(model.rows, row)),
    ]);
    if (result.ok) throw new Error(`an invalid ${kind} transaction was accepted`);
    if (JSON.stringify(serverRowFingerprints(world)) !== JSON.stringify(before)) {
      throw new Error(`a rejected ${kind} transaction changed server state`);
    }
  });
}

export type RepairMode = "retry" | "discard";

function repairQuarantine(device: number, mode: RepairMode, pick: number): WorldCommand {
  return command(`repairQuarantine(d${device}, ${mode})`, async (_model, world) => {
    // The UI must offer repair for quarantined work (§5.5), so histories exercise it. The
    // user retries a transaction or discards it.
    const target = deviceAt(world, device);
    const transactions = [...new Set(target.client.quarantine.map((op) => op.txnId))];
    if (transactions.length === 0) return;
    const transaction = at(transactions, pick % transactions.length);
    const exported = target.client.exportQuarantinedTxn(transaction);
    if (exported.length === 0) throw new Error(`quarantine export lost ${transaction}`);
    // Retrying answers with the writes it could not send, which are the ones addressed to a row
    // the id no longer names. Those stay set aside for the person to decide about again, and
    // everything else the repair took has to be gone from quarantine.
    const undeliverable = mode === "retry" ? await target.client.retryQuarantinedTxn(transaction) : [];
    if (mode === "discard") await target.client.discardQuarantinedTxn(transaction);
    const kept = new Set<WeftOp>(undeliverable);
    const left = target.client.quarantine.filter((op) => op.txnId === transaction);
    if (left.some((op) => !kept.has(op))) {
      throw new Error(`repairing ${transaction} left it in quarantine`);
    }
    for (const op of undeliverable) {
      if (op.kind !== "set") throw new Error(`repairing ${transaction} withheld a ${op.kind}`);
    }
  });
}

function upgradeSchema(device: number): WorldCommand {
  return command(`upgradeSchema(d${device})`, (_model, world) => {
    // A rolling update. This device now runs the next release. It rolls the scope forward on
    // its next handshake, and every device still on the old build is locked out until it
    // updates too (§5.10), though its outbox is left untouched.
    upgradeDevice(deviceAt(world, device));
  });
}

function skewDeviceClock(device: number, offsetMs: number): WorldCommand {
  return command(`skewClock(d${device}, ${offsetMs}ms)`, (_model, world) => {
    deviceAt(world, device).skewMs = offsetMs;
  });
}

function runRetention(device: number, days: number): WorldCommand {
  return command(`runRetention(d${device}, ${days}d default)`, async (_model, world) => {
    // Retention is client-driven, so expired rows become ordinary delete ops (§7).
    const target = deviceAt(world, device);
    const expired = planRetentionDeletes(target.client, propertySchema, { defaultAutoDeleteDays: days }, world.now);
    for (const candidate of expired) {
      if (localState(target.client, candidate.tableName, candidate.rowId) !== "live") continue;
      await target.client.delete(candidate.tableName, candidate.rowId, nextTxn(world, "retention"));
    }
  });
}

function advanceTime(ms: number): WorldCommand {
  return command(`advanceTime(${ms}ms)`, (_model, world) => {
    world.now += ms;
  });
}

function offlineGap(device: number, days: number): WorldCommand {
  return command(`offlineGap(d${device}, +${days}d)`, (_model, world) => {
    // An offline stretch long enough to fall below the tombstone floor.
    const target = deviceAt(world, device);
    target.online = false;
    world.now += TOMBSTONE_FLOOR_MS + days * DAY_MS;
    world.server.pruneTombstones(world.scopeId, TOMBSTONE_FLOOR_MS);
  });
}

function prune(): WorldCommand {
  return command("prune()", (_model, world) => {
    world.server.pruneTombstones(world.scopeId, TOMBSTONE_FLOOR_MS);
  });
}

function neighbourScopeWrite(row: number, title: string): WorldCommand {
  return command(`neighbourWrite(r${row})`, async (model, world) => {
    // The neighbouring scope reuses the same row ids on the same server.
    const id = rowAt(model.rows, row);
    const client = world.neighbour.client;
    if (localState(client, TASKS, id) === "absent") {
      await client.create(
        TASKS,
        id,
        {
          [TITLE]: title,
          [STATUS]: "open",
          [NOTES]: BASE_NOTES,
          [RANK]: nextRank(world.neighbour),
          [CONSUMED_AT]: world.now,
          [AUTO_DELETE_DAYS]: 30,
        },
        nextTxn(world, "neighbour-create"),
      );
    } else {
      await client.update(TASKS, id, { [TITLE]: title }, nextTxn(world, "neighbour-update"));
    }
    await client.syncWith(inProcessTransport(world.server), world.neighbour.schemaHash);
  });
}

const deviceArb = fc.integer({ min: 0, max: 4 });
const rowArb = fc.integer({ min: 0, max: MODEL_ROWS.length - 1 });
const invoiceArb = fc.integer({ min: 0, max: MODEL_INVOICES.length - 1 });
const textArb = fc.string({ minLength: 1, maxLength: 12 });

/**
 * The generated command space, weighted so sync traffic keeps up with mutations.
 *
 * fast-check prints a `replayPath` in the comment beside a reported counterexample, and a history
 * replays only when that path is handed back to the generator that drew it. A seed and a `path`
 * alone reach a different history, because shrinking a command list depends on what running it did.
 */
export function worldCommands(maxCommands = 100, replayPath?: string): fc.Arbitrary<Iterable<WorldCommand>> {
  return fc.commands<WorldModel, PropertyWorld, true>(
    [
      fc
        .tuple(deviceArb, rowArb, textArb, fc.constantFrom(1, 7, 30))
        .map(([device, row, title, days]) => createTask(device, row, title, days)),
      fc
        .tuple(deviceArb, rowArb, fc.boolean(), textArb)
        .map(([device, row, onTitle, value]) => updateTask(device, row, onTitle, value)),
      fc
        .tuple(deviceArb, rowArb, fc.integer({ min: 0, max: 3 }), textArb)
        .map(([device, row, line, text]) => editNotes(device, row, line, text)),
      fc
        .tuple(deviceArb, rowArb, fc.integer({ min: 0, max: 3 }), textArb, textArb)
        .map(([device, row, line, mine, theirs]) => contendNotes(device, row, line, mine, theirs)),
      fc.tuple(deviceArb, rowArb).map(([device, row]) => deleteTask(device, row)),
      fc.tuple(deviceArb, rowArb, textArb).map(([device, row, title]) => restoreTask(device, row, title)),
      fc.tuple(deviceArb, rowArb, textArb).map(([device, row, status]) => appendEvent(device, row, status)),
      fc
        .tuple(deviceArb, invoiceArb, fc.integer({ min: 0, max: 2 }), fc.option(fc.integer({ min: 0, max: 900 })))
        .map(([device, invoice, children, override]) => createInvoiceWithLines(device, invoice, children, override)),
      fc.tuple(deviceArb, invoiceArb).map(([device, invoice]) => deleteInvoice(device, invoice)),
      fc.tuple(deviceArb).map(([device]) => togglePartition(device)),
      fc.tuple(deviceArb).map(([device]) => sync(device)),
      fc.tuple(deviceArb).map(([device]) => sync(device)),
      fc.tuple(deviceArb).map(([device]) => pull(device)),
      fc.tuple(deviceArb).map(([device]) => snapshotResync(device)),
      fc.tuple(deviceArb).map(([device]) => duplicateDelivery(device)),
      fc
        .tuple(
          deviceArb,
          fc.constantFrom<InjectedRejectionKind[]>("foreign-scope", "clock-skew", "absent-row", "half-valid"),
          rowArb,
        )
        .map(([device, kind, row]) => injectRejection(device, kind, row)),
      fc
        .tuple(deviceArb, fc.constantFrom<RepairMode[]>("retry", "discard"), fc.nat())
        .map(([device, mode, pick]) => repairQuarantine(device, mode, pick)),
      // Offsets straddle the server's skew threshold, so corrections and plain drift both occur.
      fc
        .tuple(deviceArb, fc.integer({ min: -20 * 60 * 1000, max: 20 * 60 * 1000 }))
        .map(([device, offset]) => skewDeviceClock(device, offset)),
      fc.tuple(deviceArb, fc.constantFrom(1, 7, 30)).map(([device, days]) => runRetention(device, days)),
      fc.tuple(deviceArb).map(([device]) => upgradeSchema(device)),
      fc.integer({ min: 1, max: 90 * 60 * 1000 }).map((ms) => advanceTime(ms)),
      fc.tuple(deviceArb, fc.integer({ min: 0, max: 30 })).map(([device, days]) => offlineGap(device, days)),
      fc.constant(prune()),
      fc.tuple(rowArb, textArb).map(([row, title]) => neighbourScopeWrite(row, title)),
    ],
    { maxCommands, size: "medium", ...(replayPath === undefined ? {} : { replayPath }) },
  );
}

/** Runs a generated history and hands back the world it produced. */
export async function runWorld(
  commands: Iterable<WorldCommand>,
  deviceCount = 3,
  makeServer?: ServerFactory,
): Promise<PropertyWorld> {
  let created: PropertyWorld | undefined;
  await fc.asyncModelRun(() => {
    created = makeServer === undefined ? createWorld(deviceCount) : createWorld(deviceCount, makeServer);
    return { model: initialModel(), real: created };
  }, commands);
  if (created === undefined) throw new Error("the world was never set up");
  return created;
}

// ---------------------------------------------------------------------------
// Helpers shared by the invariant registry and the targeted properties
// ---------------------------------------------------------------------------

export function injectedRejection(
  world: PropertyWorld,
  device: PropertyDevice,
  kind: InjectedRejectionKind,
  row: RowId,
): readonly WeftOp[] {
  const transaction = txnId(`injected-${world.txnCounter}`);
  world.txnCounter += 1;
  const stamp = (wallMs: number): HlcString => encodeHlc({ wallMs, counter: 0, deviceId: device.client.deviceId });
  const ghost = rowId(`ghost-${world.txnCounter}`);
  switch (kind) {
    case "foreign-scope":
      return [
        {
          scopeId: scopeId("elsewhere"),
          tableName: TASKS,
          rowId: row,
          kind: "set",
          field: TITLE,
          value: "foreign",
          hlc: stamp(world.now),
          txnId: transaction,
        },
      ];
    case "clock-skew":
      return [
        {
          scopeId: world.scopeId,
          tableName: TASKS,
          rowId: row,
          kind: "set",
          field: TITLE,
          value: "skewed",
          hlc: stamp(world.now + 60 * 60 * 1000),
          txnId: transaction,
        },
      ];
    case "absent-row":
      return [
        {
          scopeId: world.scopeId,
          tableName: TASKS,
          rowId: ghost,
          kind: "set",
          field: TITLE,
          value: "ghost",
          hlc: stamp(world.now),
          txnId: transaction,
        },
      ];
    case "half-valid":
      return [
        {
          scopeId: world.scopeId,
          tableName: TASKS,
          rowId: ghost,
          kind: "create",
          hlc: stamp(world.now),
          txnId: transaction,
        },
        {
          scopeId: world.scopeId,
          tableName: TASKS,
          rowId: ghost,
          kind: "set",
          field: TITLE,
          value: "half",
          hlc: stamp(world.now),
          txnId: transaction,
        },
        {
          scopeId: scopeId("elsewhere"),
          tableName: TASKS,
          rowId: ghost,
          kind: "set",
          field: STATUS,
          value: "half",
          hlc: stamp(world.now),
          txnId: transaction,
        },
      ];
  }
}

export function nextTxn(world: PropertyWorld, label: string): TxnId {
  world.txnCounter += 1;
  return txnId(`${label}-${world.txnCounter}`);
}

export function deviceAt(world: PropertyWorld, index: number): PropertyDevice {
  return at(world.devices, index % world.devices.length);
}

function rowAt(rows: readonly RowId[], index: number): RowId {
  return at(rows, index % rows.length);
}

function nextRank(device: PropertyDevice): RankString {
  const ranks = device.client
    .listRows(TASKS)
    .map((row) => wireText(row.fields.get(RANK) ?? ""))
    .filter((rank) => rank.length > 0)
    .sort();
  return rankBetween(ranks.at(-1) as RankString | undefined, null, device.client.deviceId);
}

export function replaceLine(text: string, index: number, replacement: string): string {
  const lines = text.split("\n");
  lines[index % lines.length] = replacement;
  return lines.join("\n");
}

/**
 * Brings every device online and syncs until nothing moves, so a device that pushed after
 * the last device pulled still gets its work delivered before state is compared.
 */
export async function quiesce(world: PropertyWorld, maxRounds = 200): Promise<void> {
  // Settling is what happens once the fleet has caught up. Clocks are corrected, and any
  // rolling update finishes, because a device left on the old build is locked out of the
  // scope by design (§5.10) and could never converge.
  const upgraded = world.devices.some((device) => device.schemaHash === upgradedSchemaHash);
  for (const device of world.devices) {
    device.online = true;
    device.skewMs = 0;
    if (upgraded) upgradeDevice(device);
  }
  for (let round = 0; round < maxRounds; round += 1) {
    const before = syncFingerprint(world);
    for (const device of world.devices)
      await device.client.syncWith(inProcessTransport(world.server), device.schemaHash);
    if (syncFingerprint(world) === before) return;
  }
  throw new Error("the world never settled");
}

function syncFingerprint(world: PropertyWorld): string {
  return world.devices
    .map((device) => `${device.client.lastServerSeq}:${device.client.outbox.length}:${device.client.quarantine.length}`)
    .join("|");
}

export type LocalRowState = "live" | "tombstoned" | "absent";

export function localState(client: WeftClient, table: TableName, row: RowId): LocalRowState {
  const key = localKey(table, row);
  if (client.rows.has(key)) return "live";
  if (client.tombstones.has(key)) return "tombstoned";
  return "absent";
}

export function localKey(table: TableName, row: RowId): string {
  return `${table}\0${row}`;
}

export function parseLocalKey(key: string): { readonly tableName: TableName; readonly rowId: RowId } {
  const [table, row] = key.split("\0");
  return { tableName: (table ?? "") as TableName, rowId: (row ?? "") as RowId };
}

export function pendingOps(client: WeftClient, table: TableName, row: RowId): readonly WeftOp[] {
  return [
    ...client.outbox.filter((op) => op.tableName === table && op.rowId === row),
    ...client.quarantine.filter((op) => op.tableName === table && op.rowId === row),
  ];
}

/** Rows with no pending work anywhere, so every device must agree with the server on them. */
export function settledRowKeys(world: PropertyWorld): readonly string[] {
  const keys = new Set<string>();
  for (const device of world.devices) {
    for (const key of device.client.rows.keys()) keys.add(key);
    for (const key of device.client.tombstones.keys()) keys.add(key);
  }
  return [...keys]
    .filter((key) => {
      const { tableName: table, rowId: row } = parseLocalKey(key);
      return world.devices.every((device) => pendingOps(device.client, table, row).length === 0);
    })
    .sort();
}

export function rowFingerprint(device: PropertyDevice, key: string): string {
  const local = device.client.rows.get(key);
  if (local === undefined) return "gone";
  return JSON.stringify([...local.fields.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function serverRowFingerprintsByKey(
  world: PropertyWorld,
  scope: ScopeId = world.scopeId,
): ReadonlyMap<string, string> {
  const snapshot = world.server.snapshot(scope);
  const live = new Map<string, Map<FieldName, WireValue>>();
  for (const row of snapshot.rows) {
    if (row.deletedHlc === null) live.set(localKey(row.tableName, row.rowId), new Map());
  }
  for (const field of snapshot.fields) {
    live.get(localKey(field.tableName, field.rowId))?.set(field.field, field.value);
  }
  return new Map(
    [...live.entries()].map(([key, fields]) => [
      key,
      JSON.stringify([...fields.entries()].sort(([left], [right]) => left.localeCompare(right))),
    ]),
  );
}

/** One entry per settled row the devices and the server do not agree on. */
export function disagreements(world: PropertyWorld): readonly string[] {
  const serverRows = serverRowFingerprintsByKey(world);
  const problems: string[] = [];
  for (const key of settledRowKeys(world)) {
    const server = serverRows.get(key) ?? "gone";
    if (world.devices.some((device) => rowFingerprint(device, key) !== server)) {
      const views = world.devices.map((device) => `${device.client.deviceId}=${rowFingerprint(device, key)}`);
      problems.push(`${key}: server=${server} ${views.join(" ")}`);
    }
  }
  return problems;
}

export function serverRowFingerprints(world: PropertyWorld, scope: ScopeId = world.scopeId): readonly string[] {
  const snapshot = world.server.snapshot(scope);
  return [
    ...snapshot.fields.map(
      (field) => `f:${field.tableName}:${field.rowId}:${field.field}:${JSON.stringify(field.value)}:${field.hlc}`,
    ),
    ...snapshot.rows.map((row) => `r:${row.tableName}:${row.rowId}:${row.class}:${row.deletedHlc ?? "live"}`),
  ].sort();
}

export function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`no item at index ${index}`);
  return value;
}

/** The model schema's aggregate arithmetic, fixture logic that the client itself does not provide. */
export function isOverridden(row: MaterializedRow, overrideField: FieldName): boolean {
  return row.fields.get(overrideField) !== null && row.fields.get(overrideField) !== undefined;
}

export function derivedTotal(
  parent: MaterializedRow,
  children: readonly MaterializedRow[],
  overrideField: FieldName,
  amountField: FieldName,
): number {
  const override = parent.fields.get(overrideField);
  if (typeof override === "number") return override;
  return children.reduce((total, child) => {
    const amount = child.fields.get(amountField);
    return total + (typeof amount === "number" ? amount : 0);
  }, 0);
}
