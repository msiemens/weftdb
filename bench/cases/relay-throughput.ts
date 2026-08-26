// Sustained throughput through the relay: a batch of queued ops pushed in one session, and a
// device reading the same work back. The relay here keeps its state in memory — the durable
// relay is measured separately, and the two differ by more than a constant factor.
import { connectSocketTransport, httpTransport, inProcessTransport, WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { HASH, OPS_PER_CREATE, SCOPE, benchClient, seedRows, startBenchRelay, waitForSocket } from "../fixtures.ts";
import { repeatAsync, throughput, type BenchConfig, type BenchGroup, type CaseResult } from "../harness.ts";

const GROUP = "Relay throughput";

export const relayThroughput: BenchGroup = {
  name: GROUP,
  run: async (config: BenchConfig): Promise<readonly CaseResult[]> => {
    const results: CaseResult[] = [];
    for (const ops of config.relayBatchOps) {
      results.push(await inProcessPush(config, ops));
      results.push(await httpPush(config, ops));
      results.push(await socketPush(config, ops));
      results.push(await httpPull(config, ops));
      results.push(await httpCatchUp(config, ops));
    }
    return results;
  },
};

/** A device with `ops` protocol ops queued and nothing sent, as one that has been offline looks. */
export async function queuedClient(ops: number, device = "device-0"): Promise<WeftClient> {
  const client = benchClient(device);
  await seedRows(client, ops / OPS_PER_CREATE);
  if (client.outbox.length !== ops) throw new Error(`expected ${ops} queued ops, found ${client.outbox.length}`);
  return client;
}

/** The protocol without a transport: validation, application and sequencing only. */
async function inProcessPush(config: BenchConfig, ops: number): Promise<CaseResult> {
  const samples = await repeatAsync(async () => {
    const client = await queuedClient(ops);
    const server = new WeftServer();
    const start = performance.now();
    await client.flushWith(inProcessTransport(server));
    const elapsed = performance.now() - start;
    if (client.outbox.length !== 0) throw new Error("the in-process push did not drain the outbox");
    return elapsed;
  }, config.relayBudget);
  return throughput(
    {
      id: `relay.push.inProcess.${ops}`,
      group: GROUP,
      label: `Push ${ops.toLocaleString("en-US")} ops in process`,
      note: "no serialization and no socket; the floor the two transports below are measured against",
    },
    ops,
    samples,
  );
}

function httpPush(config: BenchConfig, ops: number): Promise<CaseResult> {
  return pushOverTransport(
    config,
    ops,
    "http",
    `relay.push.http.${ops}`,
    `Push ${ops.toLocaleString("en-US")} ops over HTTP`,
  );
}

function socketPush(config: BenchConfig, ops: number): Promise<CaseResult> {
  return pushOverTransport(
    config,
    ops,
    "ws",
    `relay.push.ws.${ops}`,
    `Push ${ops.toLocaleString("en-US")} ops over a WebSocket`,
  );
}

/**
 * One push of the whole outbox. The relay is fresh for every sample: a scope that already holds
 * records would be answering a different question, which is what the durable-relay group asks.
 */
async function pushOverTransport(
  config: BenchConfig,
  ops: number,
  kind: "http" | "ws",
  id: string,
  label: string,
): Promise<CaseResult> {
  const samples = await repeatAsync(async () => {
    const relay = await startBenchRelay(1);
    const client = await queuedClient(ops);
    const socket = kind === "ws" ? connectSocketTransport({ url: relay.socketUrl, token: relay.token(0) }) : undefined;
    try {
      if (socket !== undefined) await waitForSocket(socket);
      const transport = socket ?? httpTransport({ baseUrl: relay.baseUrl, token: relay.token(0) });
      const start = performance.now();
      await client.flushWith(transport);
      const elapsed = performance.now() - start;
      if (client.outbox.length !== 0) throw new Error("the push did not drain the outbox");
      return elapsed;
    } finally {
      socket?.close();
      await relay.close();
    }
  }, config.relayBudget);
  return throughput(
    {
      id,
      group: GROUP,
      label,
      note: `one push of a ${ops}-op outbox into a fresh in-memory scope, over 127.0.0.1`,
    },
    ops,
    samples,
  );
}

/** The read side on its own: the relay's scan and the JSON it answers with, no client apply. */
async function httpPull(config: BenchConfig, ops: number): Promise<CaseResult> {
  const samples = await repeatAsync(async () => {
    const relay = await startBenchRelay(2);
    try {
      const writer = await queuedClient(ops);
      await writer.flushWith(httpTransport({ baseUrl: relay.baseUrl, token: relay.token(0) }));
      const reader = httpTransport({ baseUrl: relay.baseUrl, token: relay.token(1) });
      const start = performance.now();
      const batch = await reader.pull(SCOPE, 0);
      const elapsed = performance.now() - start;
      const records = batch.fields.length + batch.rows.length;
      if (records !== ops) throw new Error(`expected ${ops} records, pulled ${records}`);
      return elapsed;
    } finally {
      await relay.close();
    }
  }, config.relayBudget);
  return throughput(
    {
      id: `relay.pull.http.${ops}`,
      group: GROUP,
      label: `Pull ${ops.toLocaleString("en-US")} records over HTTP`,
      note: "one GET /pull from a cursor of zero; the records are decoded but not applied",
    },
    ops,
    samples,
    "records/s",
  );
}

/** What a device that has never seen this scope pays to become current: pull and apply. */
async function httpCatchUp(config: BenchConfig, ops: number): Promise<CaseResult> {
  const samples = await repeatAsync(async () => {
    const relay = await startBenchRelay(2);
    try {
      const writer = await queuedClient(ops);
      await writer.flushWith(httpTransport({ baseUrl: relay.baseUrl, token: relay.token(0) }));
      const reader = benchClient("device-1");
      const transport = httpTransport({ baseUrl: relay.baseUrl, token: relay.token(1) });
      const start = performance.now();
      await reader.syncWith(transport, HASH);
      const elapsed = performance.now() - start;
      if (reader.rows.size !== ops / OPS_PER_CREATE) throw new Error("the reader did not catch up");
      return elapsed;
    } finally {
      await relay.close();
    }
  }, config.relayBudget);
  return throughput(
    {
      id: `relay.catchUp.http.${ops}`,
      group: GROUP,
      label: `Catch a device up on ${ops.toLocaleString("en-US")} records over HTTP`,
      note: "a full session on an empty device: handshake, pull, and applying every record locally",
    },
    ops,
    samples,
    "records/s",
  );
}
