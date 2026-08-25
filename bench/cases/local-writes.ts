// What an edit costs with no network and no disk: the mutation path on its own.
import { txnId, type FieldName, type RowId, type WireValue } from "weftdb/core";
import { WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import {
  HASH,
  NOTES,
  OPS_PER_CREATE,
  TITLE,
  TODOS,
  benchClient,
  notesFor,
  rankFor,
  seedRows,
  syncedClient,
  todoId,
  todoValues,
  updateTxn,
} from "../fixtures.ts";
import { repeat, throughput, type BenchConfig, type BenchGroup, type CaseResult } from "../harness.ts";

const GROUP = "Local writes";

/** Fixed regardless of `--quick`, so the two modes produce comparable numbers. */
const CREATES_PER_SAMPLE = 500;
const UPDATES_PER_SAMPLE = 200;
const OFFLINE_UPDATES_PER_SAMPLE = 50;
/** The dataset an update is measured against: large enough to be a real list, small enough to seed. */
const UPDATE_DATASET_ROWS = 1_000;

interface NewRow {
  readonly id: RowId;
  readonly values: Record<FieldName, WireValue>;
}

export const localWrites: BenchGroup = {
  name: GROUP,
  run: async (config: BenchConfig): Promise<readonly CaseResult[]> => [
    createThroughput(config),
    updateThroughput(config, TITLE, "local.update.lww", "Local update, last-writer-wins field"),
    updateThroughput(config, NOTES, "local.update.diff3", "Local update, diff3 prose field"),
    ...config.backlogOps.map((backlog) => offlineUpdateThroughput(config, backlog)),
  ],
};

function createThroughput(config: BenchConfig): CaseResult {
  const rows: readonly NewRow[] = Array.from({ length: CREATES_PER_SAMPLE }, (_unused, index) => ({
    id: todoId(index),
    values: todoValues(`todo ${index}`, notesFor(index), rankFor(index)),
  }));
  const samples = repeat(() => {
    const client = benchClient("device-0");
    const start = performance.now();
    for (const row of rows) client.create(TODOS, row.id, row.values, txnId(`create-${row.id}`));
    return performance.now() - start;
  }, config.budget);
  return throughput(
    {
      id: "local.create",
      group: GROUP,
      label: "Local create (row with six fields)",
      note: `${CREATES_PER_SAMPLE} creates per sample into a fresh in-memory client; each create enqueues ${OPS_PER_CREATE} protocol ops`,
    },
    CREATES_PER_SAMPLE,
    samples,
  );
}

/**
 * Updates across distinct rows on a device that starts each sample with a drained outbox — a
 * burst of edits between two syncs.
 */
function updateThroughput(config: BenchConfig, field: FieldName, id: string, label: string): CaseResult {
  const server = new WeftServer();
  const client = benchClient("device-0");
  seedRows(client, UPDATE_DATASET_ROWS);
  client.sync(server, HASH);
  const rows = Array.from({ length: UPDATES_PER_SAMPLE }, (_unused, index) => todoId(index));
  let counter = 0;
  const samples = repeat(() => {
    // Draining is setup, not measurement: how much an unsent backlog costs is what the offline
    // series below is for, and here it would make each sample depend on the one before it.
    client.sync(server, HASH);
    counter += 1;
    const start = performance.now();
    for (const [index, row] of rows.entries()) {
      client.update(TODOS, row, { [field]: value(field, counter, index) }, updateTxn(row));
    }
    return performance.now() - start;
  }, config.budget);
  return throughput(
    {
      id,
      group: GROUP,
      label,
      note: `${UPDATES_PER_SAMPLE} updates per sample across distinct rows of a ${UPDATE_DATASET_ROWS}-row client with a drained outbox`,
    },
    UPDATES_PER_SAMPLE,
    samples,
  );
}

/**
 * The same edit made by a device that has been offline. Repeating the edit on one field keeps the
 * backlog constant — an unsent write is superseded rather than followed — so what varies between
 * these cases is only how much unsent work the mutator has to look through.
 */
function offlineUpdateThroughput(config: BenchConfig, backlogOps: number): CaseResult {
  const row = todoId(0);
  let counter = 0;
  const samples = repeat(() => {
    const client = offlineClient(backlogOps);
    counter += 1;
    const start = performance.now();
    for (let index = 0; index < OFFLINE_UPDATES_PER_SAMPLE; index += 1) {
      client.update(TODOS, row, { [TITLE]: `title ${counter}-${index}` }, updateTxn(row));
    }
    const elapsed = performance.now() - start;
    if (client.outbox.length !== backlogOps + 1) throw new Error("the offline backlog did not stay constant");
    return elapsed;
  }, config.budget);
  return throughput(
    {
      id: `local.update.offline.${backlogOps}ops`,
      group: GROUP,
      label: `Local update with ${backlogOps.toLocaleString("en-US")} unsent ops queued`,
      note: `${OFFLINE_UPDATES_PER_SAMPLE} updates per sample to one field of a synced row, behind ${backlogOps} unsent ops`,
    },
    OFFLINE_UPDATES_PER_SAMPLE,
    samples,
  );
}

/** One synced row to edit, with `backlogOps` worth of unsent creates queued behind it. */
function offlineClient(backlogOps: number): WeftClient {
  const client = syncedClient(1);
  seedRows(client, Math.floor(backlogOps / OPS_PER_CREATE), 1);
  return client;
}

function value(field: FieldName, counter: number, index: number): WireValue {
  return field === NOTES ? `${notesFor(index)}\nedit ${counter}` : `title ${counter}-${index}`;
}
