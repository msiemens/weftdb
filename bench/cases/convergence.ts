// How long a set of devices takes to agree. Every device edits while the others are editing, and
// the clock stops only once all of them hold byte-identical state and have nothing left to send.
import { httpTransport, WeftClient, type AsyncSyncTransport } from "weftdb/client";
import {
  HASH,
  TITLE,
  TODOS,
  benchClient,
  seedRows,
  startBenchRelay,
  todoId,
  updateTxn,
  type BenchRelay,
} from "../fixtures.ts";
import { duration, repeatAsync, type BenchConfig, type BenchGroup, type CaseResult } from "../harness.ts";

const GROUP = "Convergence";

/** Enough passes for anything that is going to settle to have settled. */
const MAX_ROUNDS = 16;

export const convergence: BenchGroup = {
  name: GROUP,
  run: async (config: BenchConfig): Promise<readonly CaseResult[]> => {
    const results: CaseResult[] = [];
    for (const devices of config.deviceCounts) {
      results.push(await disjointConvergence(config, devices));
      results.push(await contendedConvergence(config, devices));
    }
    return results;
  },
};

/** Every device writes its own rows, so nothing is contended and every edit has to survive. */
async function disjointConvergence(config: BenchConfig, devices: number): Promise<CaseResult> {
  const edits = config.editsPerDevice;
  const samples = await repeatAsync(async () => {
    const relay = await startBenchRelay(devices);
    try {
      const world = openWorld(relay, devices);
      const start = performance.now();
      for (const [index, client] of world.clients.entries()) seedRows(client, edits, index * edits);
      const rounds = await settle(world);
      const elapsed = performance.now() - start;
      const expected = devices * edits;
      for (const client of world.clients) {
        if (client.rows.size !== expected)
          throw new Error(`a device holds ${client.rows.size} rows, expected ${expected}`);
      }
      if (rounds > MAX_ROUNDS) throw new Error("the devices never converged");
      return elapsed;
    } finally {
      await relay.close();
    }
  }, config.heavyBudget);
  return duration(
    {
      id: `converge.disjoint.${devices}devices`,
      group: GROUP,
      label: `${devices} devices, ${edits} new rows each, converge`,
      note: "each device creates its own rows offline, then all of them sync through one relay until every device holds the same state",
    },
    samples,
  );
}

/** Every device writes the same field of the same row, so all but one edit has to lose. */
async function contendedConvergence(config: BenchConfig, devices: number): Promise<CaseResult> {
  const row = todoId(0);
  const samples = await repeatAsync(async () => {
    const relay = await startBenchRelay(devices);
    try {
      const world = openWorld(relay, devices);
      const [first] = world.clients;
      if (first === undefined) throw new Error("a convergence world needs at least one device");
      seedRows(first, 1);
      await settle(world);
      const start = performance.now();
      for (const [index, client] of world.clients.entries()) {
        client.update(TODOS, row, { [TITLE]: `title from device ${index}` }, updateTxn(row));
      }
      const rounds = await settle(world);
      const elapsed = performance.now() - start;
      if (rounds > MAX_ROUNDS) throw new Error("the devices never agreed on a winner");
      return elapsed;
    } finally {
      await relay.close();
    }
  }, config.heavyBudget);
  return duration(
    {
      id: `converge.contended.${devices}devices`,
      group: GROUP,
      label: `${devices} devices editing one field, converge`,
      note: "every device writes the same field of the same row while offline; the highest stamp wins and the rest learn it",
    },
    samples,
  );
}

interface World {
  readonly clients: readonly WeftClient[];
  readonly transports: readonly AsyncSyncTransport[];
}

function openWorld(relay: BenchRelay, devices: number): World {
  return {
    clients: Array.from({ length: devices }, (_unused, index) => benchClient(`device-${index}`)),
    transports: Array.from({ length: devices }, (_unused, index) =>
      httpTransport({ baseUrl: relay.baseUrl, token: relay.token(index) }),
    ),
  };
}

/**
 * Sync rounds until every device holds the same state and none has anything left to send. One
 * pass is never enough: a device syncs before the devices after it have pushed anything.
 */
async function settle(world: World): Promise<number> {
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    for (const [index, client] of world.clients.entries()) {
      const transport = world.transports[index];
      if (transport === undefined) continue;
      await client.syncWith(transport, HASH);
    }
    if (converged(world.clients)) return round;
  }
  return MAX_ROUNDS + 1;
}

function converged(clients: readonly WeftClient[]): boolean {
  if (clients.some((client) => client.outbox.length > 0)) return false;
  const [first, ...rest] = clients;
  if (first === undefined) return true;
  const reference = fingerprint(first);
  return rest.every((client) => fingerprint(client) === reference);
}

/** The state a device would show, with nothing local in it: every row's fields, in a fixed order. */
function fingerprint(client: WeftClient): string {
  return [...client.rows.entries()]
    .map(([key, row]) => {
      const fields = [...row.fields.entries()]
        .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
        .sort()
        .join(",");
      return `${key}|${fields}`;
    })
    .sort()
    .join("\n");
}
