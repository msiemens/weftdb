// What it costs to put the client behind a boundary rather than in the page's own heap: one
// request/response hop across a port, the structured clone of the rows that come back over it, and
// the commit the durable path pays per mutation. The transport cases here are a *control*, not a
// prediction — Node's structured clone and its worker scheduling are a different implementation
// from a browser's, and the browser harness is what says what a tab actually pays.
import { MessageChannel, Worker, BroadcastChannel, type MessagePort } from "node:worker_threads";
import { SqliteClientStore } from "weftdb/client/sqlite";
import type { ProxyRequest, ProxyResponse, QueryDelta, WorkerRequest, WorkerResponse } from "weftdb/client";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import {
  TITLE,
  TODOS,
  schema,
  syncedClient,
  tempDirectory,
  todoId,
  updateTxn,
  type TempDirectory,
} from "../fixtures.ts";
import {
  consume,
  duration,
  repeat,
  repeatAsync,
  type BenchConfig,
  type BenchGroup,
  type CaseResult,
} from "../harness.ts";

const GROUP = "Worker boundary";

/**
 * Fixed regardless of `--quick`, so the two modes produce comparable numbers: one row is the
 * keystroke case, a hundred is a list re-render.
 */
const DELTA_ROWS: readonly number[] = [1, 100];

/** How many commits a freshly opened database gets before it is timed; see `sqliteCommitCase`. */
const COMMITS_BEFORE_MEASURING = 5;

/** The caveat that belongs beside every number taken over a port in this group. */
const NOT_A_BROWSER =
  "Node's structured clone and worker scheduling are not a browser's, so this is a control for the browser harness rather than a prediction of what a tab pays";

/** A request with nothing in it: `close` is the one message in the protocol that carries no payload. */
const EMPTY_REQUEST = (id: number): WorkerRequest => ({ id, type: "close" });

export const workerBoundary: BenchGroup = {
  name: GROUP,
  run: async (config: BenchConfig): Promise<readonly CaseResult[]> => {
    using directory = tempDirectory();
    return [
      ...(await messageChannelCases(config)),
      await realWorkerCase(config),
      await broadcastCase(config),
      ...sqliteCommitCases(config, directory),
    ];
  },
};

/**
 * The boundary with nothing behind it: both ends are this thread, so what is left is the port hop
 * and the clone of whatever the answer carries.
 */
async function messageChannelCases(config: BenchConfig): Promise<readonly CaseResult[]> {
  const results: CaseResult[] = [
    duration(
      {
        id: "boundary.messagechannel.empty",
        group: GROUP,
        label: "Request/response over a MessageChannel, empty answer",
        note: `one WorkerRequest out and one WorkerResponse back with a null value, both ports on this thread; ${NOT_A_BROWSER}`,
      },
      await roundTripOverChannel(config, null),
    ),
  ];
  // One channel at a time. Two of these in flight together share a thread, so each would be
  // measuring the other's clone as well as its own — and both would report the larger one.
  for (const rows of DELTA_ROWS) {
    results.push(
      duration(
        {
          id: `boundary.messagechannel.delta.${rows}`,
          group: GROUP,
          label: `Request/response over a MessageChannel, ${rows.toLocaleString("en-US")}-row delta`,
          note: `the same hop, answered with a QueryDelta carrying ${rows} materialized six-field todo ${rows === 1 ? "row" : "rows"} — the difference from the empty case is the structured clone; ${NOT_A_BROWSER}`,
        },
        await roundTripOverChannel(config, deltaOf(rows)),
      ),
    );
  }
  return results;
}

/** A port pair whose far end answers every request with `value`, torn down when the case ends. */
async function roundTripOverChannel(config: BenchConfig, value: QueryDelta | null): Promise<readonly number[]> {
  const channel = new MessageChannel();
  try {
    answerOn(channel.port2, value);
    return await askRepeatedly(config, channel.port1);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}

/**
 * A real thread rather than a port pair. It is the closer analogue to a browser Worker: the answer
 * is produced somewhere else and has to be scheduled back, which a same-thread channel never shows.
 */
async function realWorkerCase(config: BenchConfig): Promise<CaseResult> {
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  try {
    return duration(
      {
        id: "boundary.worker.empty",
        group: GROUP,
        label: "Request/response to a real worker thread, empty answer",
        note: `a node:worker_threads Worker echoes an empty WorkerResponse, so the number is the thread hop rather than the query; ${NOT_A_BROWSER}`,
      },
      await askRepeatedly(config, worker),
    );
  } finally {
    await worker.terminate();
  }
}

/** The worker end of the protocol: answer every request, do nothing else. */
const WORKER_SOURCE = [
  'const { parentPort } = require("node:worker_threads");',
  'parentPort.on("message", (request) => parentPort.postMessage({ id: request.id, ok: true, value: null }));',
].join("\n");

/**
 * What a follower tab pays to reach the leader's database: the request and its answer both go
 * through a BroadcastChannel, addressed by client id because every tab on the channel hears both.
 */
async function broadcastCase(config: BenchConfig): Promise<CaseResult> {
  const name = `weftdb-bench-${crypto.randomUUID()}`;
  const follower = new BroadcastChannel(name);
  const leader = new BroadcastChannel(name);
  try {
    const client = crypto.randomUUID();
    leader.onmessage = (event): void => {
      const asked = event.data as ProxyRequest;
      const envelope: ProxyResponse = {
        client: asked.client,
        response: { id: asked.request.id, ok: true, value: null },
      };
      leader.postMessage(envelope);
    };

    let id = 0;
    let settle: ((response: WorkerResponse) => void) | undefined;
    follower.onmessage = (event): void => {
      const answer = event.data as ProxyResponse;
      if (answer.client !== client) return;
      const resolve = settle;
      settle = undefined;
      resolve?.(answer.response);
    };

    const samples = await repeatAsync(async () => {
      id += 1;
      const answered = new Promise<WorkerResponse>((resolve) => {
        settle = resolve;
      });
      const request: ProxyRequest = { client, request: EMPTY_REQUEST(id) };
      const start = performance.now();
      follower.postMessage(request);
      const response = await answered;
      const elapsed = performance.now() - start;
      assertAnswered(response, id);
      return elapsed;
    }, config.latencyBudget);

    return duration(
      {
        id: "boundary.broadcast.roundtrip",
        group: GROUP,
        label: "Request/response through a BroadcastChannel proxy",
        note: `what a follower tab pays to reach the leader's database: two BroadcastChannel deliveries per query, both ends on this thread; ${NOT_A_BROWSER}`,
      },
      samples,
    );
  } finally {
    follower.close();
    leader.close();
  }
}

/**
 * The durability window on the other side of the boundary: one `update` on a client whose store is
 * attached, so the timed region contains the mutation and the SQLite transaction it commits.
 */
function sqliteCommitCases(config: BenchConfig, directory: TempDirectory): readonly CaseResult[] {
  return config.persistenceSizes.map((rows, index) =>
    sqliteCommitCase(config, rows, directory.file(`commit-${index}.sqlite`)),
  );
}

function sqliteCommitCase(config: BenchConfig, rows: number, path: string): CaseResult {
  using executor = openSqliteExecutor(path);
  const store = new SqliteClientStore(executor, schema);
  const client = syncedClient(rows);
  store.installSchema();
  store.attach(client);
  const row = todoId(0);
  let counter = 0;
  const commit = (): void => {
    counter += 1;
    client.update(TODOS, row, { [TITLE]: `title ${counter}` }, updateTxn(row));
  };
  // The database is opened once here rather than per sample, so the first few commits against it
  // pay for creating the write-ahead log and preparing each statement — a cost a running
  // application pays once at startup, not per keystroke. Those commits happen off the clock.
  for (let index = 0; index < COMMITS_BEFORE_MEASURING; index += 1) commit();
  const samples = repeat(() => {
    const start = performance.now();
    commit();
    return performance.now() - start;
  }, config.heavyBudget);
  return duration(
    {
      id: `boundary.sqlite.commit.${rows}`,
      group: GROUP,
      label: `One mutation committed to SQLite, ${rows.toLocaleString("en-US")}-row store`,
      note: "the database is opened once and the store stays attached across samples, so this is the steady-state per-mutation commit — one transaction at synchronous=FULL — rather than the cold open that persist.edit measures",
    },
    samples,
  );
}

/** The far end of the boundary: answer every request with the same value. */
function answerOn(port: MessagePort, value: QueryDelta | null): void {
  port.on("message", (request: WorkerRequest) => {
    const response: WorkerResponse = { id: request.id, ok: true, value };
    port.postMessage(response);
  });
}

interface MessageEndpoint {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: WorkerResponse) => void): unknown;
}

/**
 * One request in flight at a time, which is what a transport with a pending map does when a query
 * is awaited. The clock covers the post and the answer; building the request does not.
 */
async function askRepeatedly(config: BenchConfig, endpoint: MessageEndpoint): Promise<readonly number[]> {
  let id = 0;
  let settle: ((response: WorkerResponse) => void) | undefined;
  endpoint.on("message", (response: WorkerResponse) => {
    const resolve = settle;
    settle = undefined;
    resolve?.(response);
  });
  return repeatAsync(async () => {
    id += 1;
    const answered = new Promise<WorkerResponse>((resolve) => {
      settle = resolve;
    });
    const start = performance.now();
    endpoint.postMessage(EMPTY_REQUEST(id));
    const response = await answered;
    const elapsed = performance.now() - start;
    assertAnswered(response, id);
    return elapsed;
  }, config.latencyBudget);
}

/** Reads the answer, so neither the clone that produced it nor the hop that carried it is dead code. */
function assertAnswered(response: WorkerResponse, id: number): void {
  if (response.id !== id) throw new Error("the boundary answered a request that was not the one asked");
  if (!response.ok) throw new Error(`the boundary rejected the request: ${response.error}`);
  consume(changedRows(response.value));
}

function changedRows(value: unknown): number {
  const delta = value as QueryDelta | null;
  return delta === null ? 0 : delta.changed.length;
}

/** A delta shaped the way a subscription hands one out: every row of a synced client, changed. */
function deltaOf(rows: number): QueryDelta {
  return { added: [], removed: [], changed: syncedClient(rows).listRows(TODOS) };
}
