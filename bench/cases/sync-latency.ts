// How long one edit takes to become visible on a second device. Every path here is the real
// relay over the loopback interface, so what separates them is the protocol and the transport
// rather than the network — see the caveats in RESULTS.md before quoting any of it.
import type { WireValue } from "weftdb/shared";
import { connectSocketTransport, httpTransport, WeftClient, type SocketTransport } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import {
  HASH,
  TITLE,
  TODOS,
  benchClient,
  seedRows,
  startBenchRelay,
  todoId,
  updateTxn,
  waitForSocket,
} from "../fixtures.ts";
import { duration, repeatAsync, type BenchConfig, type BenchGroup, type CaseResult } from "../harness.ts";

const GROUP = "Sync round trip";

export const syncLatency: BenchGroup = {
  name: GROUP,
  run: async (config: BenchConfig): Promise<readonly CaseResult[]> => [
    inProcessRoundTrip(config),
    ...(await httpCases(config)),
    ...(await socketCases(config)),
  ],
};

/** The floor: the same session with no transport under it at all. */
function inProcessRoundTrip(config: BenchConfig): CaseResult {
  const server = new WeftServer();
  const alpha = benchClient("device-0");
  const beta = benchClient("device-1");
  const row = todoId(0);
  seedRows(alpha, 1);
  alpha.sync(server, HASH);
  beta.sync(server, HASH);
  let counter = 0;
  const samples = [] as number[];
  for (let index = 0; index < config.latencyBudget.warmup + config.latencyBudget.iterations; index += 1) {
    counter += 1;
    const expected = `title ${counter}`;
    const start = performance.now();
    alpha.update(TODOS, row, { [TITLE]: expected }, updateTxn(row));
    alpha.sync(server, HASH);
    beta.sync(server, HASH);
    const elapsed = performance.now() - start;
    assertLanded(beta, expected);
    if (index >= config.latencyBudget.warmup) samples.push(elapsed);
  }
  return duration(
    {
      id: "sync.roundtrip.inProcess",
      group: GROUP,
      label: "Edit visible on a second device, in process",
      note: "both devices share a heap and call the server directly; no serialization, no socket",
    },
    samples,
  );
}

async function httpCases(config: BenchConfig): Promise<readonly CaseResult[]> {
  const relay = await startBenchRelay(2);
  try {
    const alpha = benchClient("device-0");
    const beta = benchClient("device-1");
    const alphaTransport = httpTransport({ baseUrl: relay.baseUrl, token: relay.token(0) });
    const betaTransport = httpTransport({ baseUrl: relay.baseUrl, token: relay.token(1) });
    seedRows(alpha, 1);
    await alpha.syncWith(alphaTransport, HASH);
    await beta.syncWith(betaTransport, HASH);

    const handshake = duration(
      {
        id: "sync.request.http",
        group: GROUP,
        label: "One HTTP request to the relay (handshake)",
        note: "a single POST /handshake over 127.0.0.1, answered by the in-memory relay",
      },
      await repeatAsync(async () => {
        const start = performance.now();
        await alphaTransport.handshake(alpha.handshakeRequest(HASH));
        return performance.now() - start;
      }, config.latencyBudget),
    );

    const roundTrip = duration(
      {
        id: "sync.roundtrip.http",
        group: GROUP,
        label: "Edit visible on a second device over HTTP",
        note: "device A runs a full session (handshake, push, pull) and then device B does; five requests in all",
      },
      await measureRoundTrip(config, alpha, beta, async (expected) => {
        alpha.update(TODOS, todoId(0), { [TITLE]: expected }, updateTxn(todoId(0)));
        await alpha.syncWith(alphaTransport, HASH);
        await beta.syncWith(betaTransport, HASH);
      }),
    );

    return [handshake, roundTrip];
  } finally {
    await relay.close();
  }
}

async function socketCases(config: BenchConfig): Promise<readonly CaseResult[]> {
  const results: CaseResult[] = [];
  results.push(...(await sessionOverSocket(config)));
  results.push(await pushedBatch(config));
  return results;
}

async function sessionOverSocket(config: BenchConfig): Promise<readonly CaseResult[]> {
  const relay = await startBenchRelay(2);
  const sockets: SocketTransport[] = [];
  try {
    const alpha = benchClient("device-0");
    const beta = benchClient("device-1");
    const alphaSocket = connectSocketTransport({ url: relay.socketUrl, token: relay.token(0) });
    const betaSocket = connectSocketTransport({ url: relay.socketUrl, token: relay.token(1) });
    sockets.push(alphaSocket, betaSocket);
    await waitForSocket(alphaSocket);
    await waitForSocket(betaSocket);
    seedRows(alpha, 1);
    await alpha.syncWith(alphaSocket, HASH);
    await beta.syncWith(betaSocket, HASH);

    const handshake = duration(
      {
        id: "sync.request.ws",
        group: GROUP,
        label: "One WebSocket request to the relay (handshake)",
        note: "the same handshake over an already-open socket, so no connection is set up per request",
      },
      await repeatAsync(async () => {
        const start = performance.now();
        await alphaSocket.handshake(alpha.handshakeRequest(HASH));
        return performance.now() - start;
      }, config.latencyBudget),
    );

    const roundTrip = duration(
      {
        id: "sync.roundtrip.ws",
        group: GROUP,
        label: "Edit visible on a second device over a WebSocket session",
        note: "device B asks for the change rather than being sent it — what a poller does when its timer fires",
      },
      await measureRoundTrip(config, alpha, beta, async (expected) => {
        alpha.update(TODOS, todoId(0), { [TITLE]: expected }, updateTxn(todoId(0)));
        await alpha.syncWith(alphaSocket, HASH);
        await beta.syncWith(betaSocket, HASH);
      }),
    );

    return [handshake, roundTrip];
  } finally {
    for (const socket of sockets) socket.close();
    await relay.close();
  }
}

/**
 * The subscribed path: device B never asks. The relay sends it the batch its cursor is missing
 * the moment the scope moves, so the measurement ends when B has applied the edit rather than
 * when A's session finishes.
 */
async function pushedBatch(config: BenchConfig): Promise<CaseResult> {
  const relay = await startBenchRelay(2);
  const sockets: SocketTransport[] = [];
  try {
    const alpha = benchClient("device-0");
    const beta = benchClient("device-1");
    const row = todoId(0);
    let awaiting: { readonly expected: string; readonly resolve: () => void } | undefined;

    const alphaSocket = connectSocketTransport({ url: relay.socketUrl, token: relay.token(0) });
    const betaSocket = connectSocketTransport({
      url: relay.socketUrl,
      token: relay.token(1),
      cursor: () => beta.lastServerSeq,
      onBatch: (batch) => {
        beta.applyPull(batch);
        if (awaiting === undefined) return;
        if (beta.getRow(TODOS, row)?.fields.get(TITLE) !== awaiting.expected) return;
        const { resolve } = awaiting;
        awaiting = undefined;
        resolve();
      },
    });
    sockets.push(alphaSocket, betaSocket);
    await waitForSocket(alphaSocket);
    await waitForSocket(betaSocket);
    seedRows(alpha, 1);
    await alpha.syncWith(alphaSocket, HASH);
    await beta.syncWith(betaSocket, HASH);

    let counter = 0;
    const samples = await repeatAsync(async () => {
      counter += 1;
      const expected = `title ${counter}`;
      const landed = new Promise<void>((resolve) => {
        awaiting = { expected, resolve };
      });
      const start = performance.now();
      alpha.update(TODOS, row, { [TITLE]: expected }, updateTxn(row));
      const session = alpha.syncWith(alphaSocket, HASH);
      await withTimeout(landed, "the relay never pushed the edit to the subscribed device");
      const elapsed = performance.now() - start;
      await session;
      return elapsed;
    }, config.latencyBudget);

    return duration(
      {
        id: "sync.roundtrip.pushed",
        group: GROUP,
        label: "Edit visible on a second device, pushed by the relay",
        note: "device B is subscribed with a cursor, so the relay sends the batch unasked; timing ends when B has applied it",
      },
      samples,
    );
  } finally {
    for (const socket of sockets) socket.close();
    await relay.close();
  }
}

async function measureRoundTrip(
  config: BenchConfig,
  alpha: WeftClient,
  beta: WeftClient,
  exchange: (expected: string) => Promise<void>,
): Promise<readonly number[]> {
  let counter = 0;
  return repeatAsync(async () => {
    counter += 1;
    const expected = `title ${counter}`;
    const start = performance.now();
    await exchange(expected);
    const elapsed = performance.now() - start;
    assertLanded(beta, expected);
    if (alpha.outbox.length !== 0) throw new Error("the edit never left device A");
    return elapsed;
  }, config.latencyBudget);
}

function assertLanded(beta: WeftClient, expected: WireValue): void {
  if (beta.getRow(TODOS, todoId(0))?.fields.get(TITLE) !== expected) {
    throw new Error("the edit never reached device B");
  }
}

async function withTimeout(promise: Promise<void>, message: string, timeoutMs = 10_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
