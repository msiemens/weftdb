// The socket stack under generated histories, with the connection failing at generated moments.
// A transport is only worth anything when the network is behaving badly, so the interesting
// question is not whether a sync works — the other suites establish that — but whether these
// hold no matter where a socket dies:
//
//   nothing acknowledged is lost, the outbox always drains once the relay is reachable again,
//   the devices converge, and a session over the socket ends where the same session over HTTP
//   would have.
//
// Faults are generated alongside the edits rather than scripted, so they land in the middle of
// a push, between a push and a pull, during a snapshot, and everywhere else the schedule can
// put them.
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import {
  deviceId,
  fieldName,
  rowId,
  scopeId,
  tableName,
  txnId,
  wireText,
  type FieldName,
  type WireValue,
} from "weftdb/shared";
import { connectSocketTransport, httpTransport, WeftClient, type SocketTransport } from "weftdb/client";
import { startRelay } from "weftdb/server/serve";
import { authContext } from "weftdb/server/relay";
import { CHUNK_BYTES } from "weftdb/server/websocket";
import { schemaHash } from "weftdb/schema";
import { schema } from "weftdb-demo-todo/schema";

const SCOPE = scopeId("shared-list");
const TODOS = tableName("todos");
const TITLE = fieldName("title");
const NOTES = fieldName("notes");
const HASH = schemaHash(schema);
const RUNS = Number(process.env["WEFT_SOCKET_RUNS"] ?? 40);

function values(input: Record<string, WireValue>): Record<FieldName, WireValue> {
  return input;
}

function seedRow(target: WeftClient, id: string, title: string, notes = "line one\nline two"): void {
  target.create(
    TODOS,
    rowId(id),
    values({ title, notes, done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId(`create-${id}`),
  );
}

/** What a generated history can do. Faults sit alongside edits so they interleave with them. */
type Step =
  | { readonly kind: "edit"; readonly device: number; readonly text: string }
  | { readonly kind: "editNotes"; readonly device: number; readonly line: number; readonly text: string }
  | { readonly kind: "delete"; readonly device: number }
  | { readonly kind: "sync"; readonly device: number }
  | { readonly kind: "dropSocket"; readonly device: number }
  | { readonly kind: "dropAll" }
  | { readonly kind: "prune" };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("edit" as const),
      device: fc.integer({ min: 0, max: 1 }),
      text: fc.string({ maxLength: 12 }),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("editNotes" as const),
      device: fc.integer({ min: 0, max: 1 }),
      line: fc.integer({ min: 0, max: 1 }),
      text: fc.string({ maxLength: 12 }),
    }),
    weight: 4,
  },
  { arbitrary: fc.record({ kind: fc.constant("sync" as const), device: fc.integer({ min: 0, max: 1 }) }), weight: 6 },
  {
    arbitrary: fc.record({ kind: fc.constant("dropSocket" as const), device: fc.integer({ min: 0, max: 1 }) }),
    weight: 3,
  },
  { arbitrary: fc.record({ kind: fc.constant("dropAll" as const) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("delete" as const), device: fc.integer({ min: 0, max: 1 }) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("prune" as const) }), weight: 1 },
);

interface World {
  readonly relay: Awaited<ReturnType<typeof startRelay>>;
  readonly clients: readonly WeftClient[];
  readonly sockets: readonly SocketTransport[];
  close(): Promise<void>;
}

async function world(): Promise<World> {
  const relay = await startRelay({
    host: "127.0.0.1",
    port: 0,
    tokens: new Map([
      ["token-a", authContext("shared-list", "device-a")],
      ["token-b", authContext("shared-list", "device-b")],
    ]),
    // The keepalive is driven by hand where it matters, never by a timer racing the test.
    keepaliveMs: 0,
  });
  const socketUrl = `${relay.url.replace(/^http/u, "ws")}/sync`;
  const clients = [
    new WeftClient(SCOPE, deviceId("device-a"), schema),
    new WeftClient(SCOPE, deviceId("device-b"), schema),
  ];
  const sockets = [
    connectSocketTransport({ url: socketUrl, token: "token-a" }),
    connectSocketTransport({ url: socketUrl, token: "token-b" }),
  ];
  return {
    relay,
    clients,
    sockets,
    close: async () => {
      for (const socket of sockets) socket.close();
      await relay.close();
    },
  };
}

async function waitFor(condition: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

/**
 * Syncs until there is nothing left to push. A client learns that its socket died only when
 * the close reaches it, so right after a drop it will still call itself connected and the send
 * will fail — which is exactly the condition being tested. Settling therefore has to be driven
 * by the outcome (is the outbox empty?) rather than by the connection flag, and it has to
 * allow for the reconnect backoff.
 */
async function settle(
  clients: readonly WeftClient[],
  sockets: readonly SocketTransport[],
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const round = async (): Promise<boolean> => {
    let complete = true;
    for (const [index, client] of clients.entries()) {
      const transport = sockets[index];
      if (transport === undefined) continue;
      // A device with nothing to push still has to complete a session: an empty outbox is not
      // the same as being caught up, and a sync that failed pulled nothing.
      if (!(await trySync(client, transport))) complete = false;
    }
    return complete && clients.every((client) => client.outbox.length === 0);
  };

  while (Date.now() < deadline) {
    // Two clean rounds: the first drains and the second lets each device see what the other
    // pushed during the first.
    if ((await round()) && (await round())) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the devices never settled against a reachable relay");
}

/** Runs a session, tolerating the failures the history is deliberately causing. Returns
 * whether the session actually completed. */
async function trySync(client: WeftClient, transport: SocketTransport): Promise<boolean> {
  try {
    await client.syncWith(transport, HASH);
    return true;
  } catch (error) {
    // A socket that died mid-session is the point of the exercise, not a failure of it. What
    // must not happen is losing work, and that is what the assertions afterwards are about.
    if (error instanceof Error && /socket|closed|timed out|not connected/u.test(error.message)) return false;
    throw error;
  }
}

test("no history of edits and connection failures loses acknowledged work", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(stepArb, { minLength: 4, maxLength: 22 }), async (steps) => {
      const running = await world();
      try {
        const [alpha, beta] = running.clients;
        const [socketA, socketB] = running.sockets;
        if (alpha === undefined || beta === undefined || socketA === undefined || socketB === undefined) return;
        const sockets = [socketA, socketB] as const;

        await waitFor(() => sockets.every((socket) => socket.connected), "the sockets never connected");
        seedRow(alpha, "todo-1", "seed");
        await trySync(alpha, socketA);
        await trySync(beta, socketB);

        for (const step of steps) {
          const client = step.kind === "prune" || step.kind === "dropAll" ? undefined : running.clients[step.device];
          const socket = step.kind === "prune" || step.kind === "dropAll" ? undefined : sockets[step.device];
          switch (step.kind) {
            case "edit": {
              if (client?.getRow(TODOS, rowId("todo-1")) === undefined) break;
              client.update(TODOS, rowId("todo-1"), values({ title: step.text }), txnId(`t-${Math.random()}`));
              break;
            }
            case "editNotes": {
              const row = client?.getRow(TODOS, rowId("todo-1"));
              if (client === undefined || row === undefined) break;
              const lines = wireText(row.fields.get(NOTES) ?? "").split("\n");
              lines[step.line] = step.text;
              client.update(TODOS, rowId("todo-1"), values({ notes: lines.join("\n") }), txnId(`n-${Math.random()}`));
              break;
            }
            case "delete": {
              if (client?.getRow(TODOS, rowId("todo-1")) === undefined) break;
              client.delete(TODOS, rowId("todo-1"), txnId(`d-${Math.random()}`));
              break;
            }
            case "sync": {
              if (client === undefined || socket === undefined) break;
              await trySync(client, socket);
              break;
            }
            case "dropSocket": {
              // The relay drops this connection underneath whatever it was doing.
              running.relay.sockets.close();
              break;
            }
            case "dropAll": {
              running.relay.sockets.close();
              break;
            }
            case "prune": {
              running.relay.server.pruneTombstones(SCOPE, 0);
              break;
            }
          }
        }

        // However badly the connections behaved, a reachable relay must be able to take
        // everything that is still queued.
        await settle(running.clients, sockets);

        for (const [index, client] of running.clients.entries()) {
          assert.equal(
            client.outbox.length,
            0,
            `device ${index} could neither push nor surface ${client.outbox.length} op(s) after settling`,
          );
        }

        // And they agree, unless something is quarantined — which is the one state where a
        // device is allowed to differ, because its diverged work is waiting on a person.
        const [first, second] = running.clients;
        if (first?.listQuarantine().length === 0 && second?.listQuarantine().length === 0) {
          assert.deepEqual(
            [...first.rows.keys()].sort(),
            [...second.rows.keys()].sort(),
            "the devices disagree about which rows exist",
          );
          assert.equal(
            first.getRow(TODOS, rowId("todo-1"))?.fields.get(TITLE),
            second.getRow(TODOS, rowId("todo-1"))?.fields.get(TITLE),
            "the devices disagree about the title",
          );
        }
      } finally {
        await running.close();
      }
    }),
    { numRuns: RUNS, endOnFailure: true },
  );
});

test("a session over the socket lands where the same session over HTTP does", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.string({ maxLength: 10 }), { minLength: 1, maxLength: 6 }),
      fc.boolean(),
      async (edits, deleteAtEnd) => {
        const running = await world();
        try {
          const [socket] = running.sockets;
          if (socket === undefined) return;
          await waitFor(() => socket.connected, "the socket never connected");
          const http = httpTransport({ baseUrl: running.relay.url, token: "token-b" });

          const overSocket = new WeftClient(SCOPE, deviceId("device-a"), schema);
          const overHttp = new WeftClient(SCOPE, deviceId("device-b"), schema);

          for (const [target, transport, id] of [
            [overSocket, socket, "todo-socket"],
            [overHttp, http, "todo-http"],
          ] as const) {
            seedRow(target, id, "seed");
            await target.syncWith(transport, HASH);
            for (const [index, text] of edits.entries()) {
              target.update(TODOS, rowId(id), values({ title: text }), txnId(`${id}-edit-${index}`));
              await target.syncWith(transport, HASH);
            }
            if (deleteAtEnd) {
              target.delete(TODOS, rowId(id), txnId(`${id}-delete`));
              await target.syncWith(transport, HASH);
            }
          }

          // Each device ends holding the same shape of state: its own row in whatever state the
          // history left it, plus the other's.
          await overSocket.syncWith(socket, HASH);
          await overHttp.syncWith(http, HASH);
          await overSocket.syncWith(socket, HASH);

          assert.equal(overSocket.outbox.length, 0);
          assert.equal(overHttp.outbox.length, 0);
          assert.equal(overSocket.listQuarantine().length, overHttp.listQuarantine().length);
          assert.deepEqual(
            [...overSocket.rows.keys()].sort(),
            [...overHttp.rows.keys()].sort(),
            "the two transports disagree about which rows exist",
          );
          assert.deepEqual(
            [...overSocket.tombstones.keys()].sort(),
            [...overHttp.tombstones.keys()].sort(),
            "the two transports disagree about what was deleted",
          );
        } finally {
          await running.close();
        }
      },
    ),
    { numRuns: Math.max(8, Math.floor(RUNS / 2)), endOnFailure: true },
  );
});

// --- stability over sustained use -----------------------------------------------------------

test("many requests in flight at once each get their own answer", async () => {
  // One socket carries every request, correlated by id. If that correlation is wrong under
  // load, a client silently gets another request's answer — a pull batch belonging to someone
  // else's cursor, applied as though it were its own.
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 24 }), async (count) => {
      const running = await world();
      try {
        const [socket] = running.sockets;
        const [client] = running.clients;
        if (socket === undefined || client === undefined) return;
        await waitFor(() => socket.connected, "the socket never connected");

        // Rows at known sequences, so each cursor has a different, checkable answer.
        for (let index = 0; index < 4; index += 1) {
          seedRow(client, `todo-${index}`, `row ${index}`);
          await trySync(client, socket);
        }

        const cursors = Array.from({ length: count }, (_, index) => index % 5);
        const answers = await Promise.all(cursors.map(async (cursor) => socket.pull(SCOPE, cursor)));
        for (const [index, batch] of answers.entries()) {
          const cursor = cursors[index] ?? 0;
          assert.ok(
            batch.fields.every((field) => field.serverSeq > cursor),
            `the answer to a pull from ${cursor} carried records at or below it`,
          );
        }
      } finally {
        await running.close();
      }
    }),
    { numRuns: 8, endOnFailure: true },
  );
});

/**
 * A relay with nothing attached to it. The shared world opens two sockets of its own, which
 * makes it useless for counting who is connected — the count would be measuring the harness.
 */
async function bareRelay(): Promise<{
  readonly url: string;
  readonly socketUrl: string;
  readonly relay: Awaited<ReturnType<typeof startRelay>>;
  close(): Promise<void>;
}> {
  const relay = await startRelay({
    host: "127.0.0.1",
    port: 0,
    keepaliveMs: 0,
    tokens: new Map([["token-a", authContext("shared-list", "device-a")]]),
  });
  return {
    url: relay.url,
    socketUrl: `${relay.url.replace(/^http/u, "ws")}/sync`,
    relay,
    close: () => relay.close(),
  };
}

test("connecting and dropping repeatedly leaves nothing behind on the relay", async () => {
  // A relay that leaks a subscriber per connection is one that dies after a day of tabs
  // opening and closing, and nothing else in the suite would ever notice.
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 10 }), async (cycles) => {
      const running = await bareRelay();
      try {
        for (let cycle = 0; cycle < cycles; cycle += 1) {
          const transport = connectSocketTransport({ url: running.socketUrl, token: "token-a" });
          await waitFor(() => transport.connected, `cycle ${cycle} never connected`);
          // Alternate between the client hanging up and the relay dropping it, since the two
          // sides clean up along different paths.
          if (cycle % 2 === 0) transport.close();
          else running.relay.sockets.close();
          await waitFor(
            () => running.relay.sockets.subscribers(SCOPE) === 0,
            `cycle ${cycle} left a subscriber behind`,
          );
          if (cycle % 2 !== 0) transport.close();
        }
        assert.equal(running.relay.sockets.subscribers(SCOPE), 0);
      } finally {
        await running.close();
      }
    }),
    { numRuns: 6, endOnFailure: true },
  );
});

test("a long-lived connection keeps working, sweep after sweep", async () => {
  // The keepalive drops peers that answer nothing. A connection that is being used must never
  // be mistaken for one of those, however many sweeps it lives through.
  const running = await bareRelay();
  const socket = connectSocketTransport({ url: running.socketUrl, token: "token-a" });
  const client = new WeftClient(SCOPE, deviceId("device-a"), schema);
  try {
    await waitFor(() => socket.connected, "the socket never connected");

    for (let round = 0; round < 12; round += 1) {
      running.relay.sockets.sweep();
      // A pong is a message, and Node's client answers pings on its own; the round trip below
      // is what proves the connection is still carrying traffic either way.
      seedRow(client, `todo-${round}`, `round ${round}`);
      await trySync(client, socket);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(socket.connected, true, `the connection was dropped during round ${round}`);
      assert.equal(client.outbox.length, 0, `round ${round} could not push`);
      assert.equal(running.relay.sockets.subscribers(SCOPE), 1, `the live connection was swept away in round ${round}`);
    }
  } finally {
    socket.close();
    await running.close();
  }
});

test("a socket carrying hundreds of requests answers all of them", async () => {
  const running = await world();
  try {
    const [socket] = running.sockets;
    if (socket === undefined) return;
    await waitFor(() => socket.connected, "the socket never connected");

    // Sustained sequential use on one connection: nothing accumulating, nothing drifting.
    for (let index = 0; index < 300; index += 1) {
      const batch = await socket.pull(SCOPE, 0);
      assert.equal(typeof batch.serverSeq, "number", `request ${index} came back malformed`);
    }
    assert.equal(socket.connected, true, "the connection did not survive being used");
  } finally {
    await running.close();
  }
});

test("an answer too big for one message survives being cut into pieces", async () => {
  // Snapshots are the answers that get large, and they are also the ones a client falls back
  // to when it cannot be caught up incrementally — so losing one to reassembly would strand a
  // device precisely when it had no other way back.
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (multiplier) => {
      const running = await world();
      try {
        const [alpha, beta] = running.clients;
        const [socketA, socketB] = running.sockets;
        if (alpha === undefined || beta === undefined || socketA === undefined || socketB === undefined) return;
        await waitFor(() => socketA.connected && socketB.connected, "the sockets never connected");

        // Prose long enough that the snapshot has to be chunked several times over.
        const long = "x".repeat(Math.ceil((CHUNK_BYTES * multiplier) / 4));
        seedRow(alpha, "todo-1", "big", long);
        await alpha.syncWith(socketA, HASH);

        // Beta has never seen this scope, so its first pull is the whole thing.
        await beta.syncWith(socketB, HASH);
        assert.equal(
          beta.getRow(TODOS, rowId("todo-1"))?.fields.get(NOTES),
          long,
          "a chunked answer did not reassemble into what was sent",
        );
      } finally {
        await running.close();
      }
    }),
    { numRuns: 6, endOnFailure: true },
  );
});

test("a socket dying mid-request never resolves that request with someone else's answer", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (inFlight) => {
      const running = await world();
      try {
        const [socket] = running.sockets;
        if (socket === undefined) return;
        await waitFor(() => socket.connected, "the socket never connected");

        const requests = Array.from({ length: inFlight }, () => socket.pull(SCOPE, 0));
        running.relay.sockets.close();

        // Every one of them has to end, and end as a failure rather than as another request's
        // answer or a promise nobody ever settles.
        const outcomes = await Promise.allSettled(requests);
        for (const outcome of outcomes) {
          if (outcome.status === "fulfilled") continue;
          assert.match(String(outcome.reason), /socket|closed|timed out/u);
        }
        assert.equal(outcomes.length, inFlight);

        // And the transport recovers rather than staying broken.
        await waitFor(() => socket.connected, "the transport never reconnected");
        const batch = await socket.pull(SCOPE, 0);
        assert.equal(typeof batch.serverSeq, "number");
      } finally {
        await running.close();
      }
    }),
    { numRuns: 8, endOnFailure: true },
  );
});
