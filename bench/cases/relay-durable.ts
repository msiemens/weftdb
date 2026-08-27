// The same relay with a SQLite file under it. A push is acknowledged only once it is committed,
// so this is what a deployment that must survive a power cut actually costs. The adapter also
// rewrites the whole scope per push, which the incremental cases below are here to show.
import { httpTransport } from "weftdb/client";
import { OPS_PER_CREATE, benchClient, seedRows, startBenchRelay, tempDirectory } from "../fixtures.ts";
import { queuedClient } from "./relay-throughput.ts";
import { duration, repeatAsync, throughput, type BenchConfig, type BenchGroup, type CaseResult } from "../harness.ts";

const GROUP = "Durable relay";

/** Scope sizes, in records already committed, that a small edit is pushed into. */
const RESIDENT_RECORDS = [1_000, 10_000] as const;

export const relayDurable: BenchGroup = {
  name: GROUP,
  run: async (config: BenchConfig): Promise<readonly CaseResult[]> => {
    using directory = tempDirectory();
    const results: CaseResult[] = [];
    let file = 0;
    const nextPath = (): string => {
      file += 1;
      return directory.file(`relay-${file}.sqlite`);
    };
    for (const ops of config.relayBatchOps) results.push(await bulkPush(config, ops, nextPath));
    const sizes = config.mode === "quick" ? RESIDENT_RECORDS.slice(0, 1) : RESIDENT_RECORDS;
    for (const resident of sizes) results.push(await incrementalPush(config, resident, nextPath));
    return results;
  },
};

/** A backlog pushed into an empty durable scope, committed before it is acknowledged. */
async function bulkPush(config: BenchConfig, ops: number, nextPath: () => string): Promise<CaseResult> {
  const samples = await repeatAsync(async () => {
    const relay = await startBenchRelay(1, nextPath());
    try {
      const client = await queuedClient(ops);
      const transport = httpTransport({ baseUrl: relay.baseUrl, token: relay.token(0) });
      const start = performance.now();
      await client.flushWith(transport);
      const elapsed = performance.now() - start;
      if (client.outbox.length !== 0) throw new Error("the durable push did not drain the outbox");
      return elapsed;
    } finally {
      await relay.close();
    }
  }, config.heavyBudget);
  return throughput(
    {
      id: `relay.sqlite.push.${ops}`,
      group: GROUP,
      label: `Push ${ops.toLocaleString("en-US")} ops to a SQLite-backed relay`,
      note: "one push into an empty scope, committed with synchronous=FULL before it is acknowledged",
    },
    ops,
    samples,
  );
}

/**
 * One new row pushed into a scope that already holds `resident` records. The work the push itself
 * describes is the same at every size, so whatever these two numbers do not have in common is the
 * cost of rewriting the scope around it.
 */
async function incrementalPush(config: BenchConfig, resident: number, nextPath: () => string): Promise<CaseResult> {
  const samples = await repeatAsync(async () => {
    const relay = await startBenchRelay(1, nextPath());
    try {
      const transport = httpTransport({ baseUrl: relay.baseUrl, token: relay.token(0) });
      const seeder = await queuedClient(resident);
      await seeder.flushWith(transport);
      const writer = benchClient("device-0");
      await seedRows(writer, 1, resident / OPS_PER_CREATE + 1);
      const start = performance.now();
      await writer.flushWith(transport);
      const elapsed = performance.now() - start;
      if (writer.outbox.length !== 0) throw new Error("the incremental push did not drain the outbox");
      return elapsed;
    } finally {
      await relay.close();
    }
  }, config.heavyBudget);
  return duration(
    {
      id: `relay.sqlite.push.oneRow.scope${resident}`,
      group: GROUP,
      label: `Push one new row into a durable scope holding ${resident.toLocaleString("en-US")} records`,
      note: `${OPS_PER_CREATE} ops on the wire either way; only the size of the scope around them differs`,
    },
    samples,
  );
}
