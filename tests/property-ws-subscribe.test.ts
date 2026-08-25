// The socket's push extension, under generated histories. A subscribed connection is told what
// changed rather than that something did: the relay keeps a cursor per connection and sends the
// records beyond it, and the client applies them through the same path a pull goes through.
//
// That makes the relay responsible for something it was not before. A poll is self-correcting —
// a device that misses one asks again a moment later — but a device that has stopped polling
// because it is being pushed to has nothing to fall back on. So the properties here are about
// what a subscriber ends up holding: it must be exactly what a device that polled would hold,
// with nothing skipped over, nothing arriving out of order, and nothing belonging to a scope
// this connection has no claim to.
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
  type FieldName,
  type ScopeId,
  type WireValue,
} from "weftdb/core";
import { connectSocketTransport, httpTransport, WeftClient, type SocketTransport } from "weftdb/client";
import type { PullBatch } from "weftdb/server";
import { startRelay } from "weftdb/server/serve";
import { authContext } from "weftdb/server/relay";
import { CHUNK_BYTES } from "weftdb/server/websocket";
import { schemaHash } from "weftdb/schema";
import { schema } from "weftdb-demo-todo/schema";

const SCOPE = scopeId("shared-list");
const OTHER_SCOPE = scopeId("someone-elses-list");
const TODOS = tableName("todos");
const TITLE = fieldName("title");
const NOTES = fieldName("notes");
const HASH = schemaHash(schema);
const RUNS = Number(process.env["WEFT_SOCKET_RUNS"] ?? 12);

type Edit =
  | { readonly kind: "create"; readonly row: number; readonly title: string }
  | { readonly kind: "edit"; readonly row: number; readonly title: string }
  | { readonly kind: "delete"; readonly row: number }
  | { readonly kind: "drop" };

const editArb: fc.Arbitrary<Edit> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("create" as const),
      row: fc.integer({ min: 0, max: 3 }),
      title: fc.string({ maxLength: 10 }),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("edit" as const),
      row: fc.integer({ min: 0, max: 3 }),
      title: fc.string({ maxLength: 10 }),
    }),
    weight: 4,
  },
  { arbitrary: fc.record({ kind: fc.constant("delete" as const), row: fc.integer({ min: 0, max: 3 }) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("drop" as const) }), weight: 1 },
);

test("a device that only ever listens ends where a device that polls ends", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(editArb, { minLength: 2, maxLength: 14 }), async (edits) => {
      await using running = await relay();
      const { subscriber, delivered } = running.subscribe();
      try {
        await running.play(edits);
        await running.settle(subscriber);

        // The control device learns the same history the way every other suite does.
        const polling = new WeftClient(SCOPE, deviceId("device-c"), schema);
        await polling.syncWith(running.http("token-c"), HASH);

        assert.deepEqual(
          rowState(subscriber),
          rowState(polling),
          "the pushed device holds something else than the polled one",
        );
        assert.equal(delivered.length > 0, true, "nothing was ever pushed, so the property proved nothing");
      } finally {
        running.closeSockets();
      }
    }),
    { numRuns: RUNS, endOnFailure: true },
  );
});

test("everything the relay holds above a subscriber's cursor reaches it", async () => {
  // The gap a push protocol can leave is a record written between the pull that answers a
  // subscription and the cursor being recorded. Nothing polls it out of that gap afterwards.
  await fc.assert(
    fc.asyncProperty(fc.array(editArb, { minLength: 2, maxLength: 14 }), async (edits) => {
      await using running = await relay();
      const { subscriber, delivered } = running.subscribe();
      try {
        await running.play(edits);
        await running.settle(subscriber);

        const held = new Set(running.records(0));
        const seen = new Set(delivered.flatMap((batch) => batch.fields.map(recordKey)));
        assert.deepEqual(
          [...held].filter((record) => !seen.has(record)),
          [],
          "records the relay holds were never sent",
        );
      } finally {
        running.closeSockets();
      }
    }),
    { numRuns: RUNS, endOnFailure: true },
  );
});

test("batches arrive in order, and a cursor only ever moves forward", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(editArb, { minLength: 2, maxLength: 14 }), async (edits) => {
      await using running = await relay();
      const cursors: number[] = [];
      const { subscriber, delivered } = running.subscribe((client) => cursors.push(client.lastServerSeq));
      try {
        await running.play(edits);
        await running.settle(subscriber);

        for (const [index, batch] of delivered.entries()) {
          const previous = delivered[index - 1];
          if (previous !== undefined) {
            assert.ok(batch.serverSeq >= previous.serverSeq, `batch ${index} went backwards`);
          }
          // Records within a batch are in no particular order — merging is by HLC, not by
          // arrival — but none of them may sit above the sequence the batch reports, because
          // that sequence is what the client will call itself caught up to.
          for (const record of batch.fields) {
            assert.ok(
              record.serverSeq <= batch.serverSeq,
              `batch ${index} carried a record above the cursor it advertises`,
            );
          }
        }
        assert.deepEqual(
          [...cursors].sort((left, right) => left - right),
          cursors,
          "the client's cursor moved backwards",
        );
      } finally {
        running.closeSockets();
      }
    }),
    { numRuns: RUNS, endOnFailure: true },
  );
});

test("a subscription reaches only the scope its token names", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(editArb, { minLength: 2, maxLength: 10 }), async (edits) => {
      await using running = await relay();
      const { subscriber, delivered } = running.subscribe();
      try {
        // A busy neighbour, on the same relay, in the same process, at the same time.
        const neighbour = new WeftClient(OTHER_SCOPE, deviceId("device-d"), schema);
        const neighbourTransport = running.http("token-d");
        for (const [index, edit] of edits.entries()) {
          if (edit.kind === "create" || edit.kind === "edit") {
            seed(neighbour, `neighbour-${index}`, edit.title);
            await neighbourTransport
              .push(OTHER_SCOPE, [...neighbour.outbox])
              .then(() => neighbour.syncWith(neighbourTransport, HASH));
          }
        }
        await running.play(edits);
        await running.settle(subscriber);

        for (const batch of delivered) {
          for (const record of batch.fields) {
            assert.equal(record.scopeId, SCOPE, "a record from another scope was pushed to this connection");
          }
        }
        assert.deepEqual(
          [...subscriber.rows.keys()].filter((key) => key.includes("neighbour-")),
          [],
          "another scope's rows reached this device",
        );
      } finally {
        running.closeSockets();
      }
    }),
    { numRuns: Math.max(4, Math.floor(RUNS / 2)), endOnFailure: true },
  );
});

test("a connection that dies catches up on what it missed rather than from where it was told", async () => {
  // The relay's cursor moves when a batch is written, not when one is acknowledged, so a batch
  // lost to a dying socket is a batch the relay believes was delivered. The client is the only
  // party that knows where it really got to, which is why it says so on every connect.
  await fc.assert(
    fc.asyncProperty(
      fc.array(editArb, { minLength: 4, maxLength: 14 }),
      fc.integer({ min: 1, max: 6 }),
      async (edits, dropAfter) => {
        await using running = await relay();
        const { subscriber, delivered } = running.subscribe();
        try {
          await running.play(edits.slice(0, dropAfter));
          running.server.sockets.close();
          // Written while nobody is listening: this is what the reconnect has to recover.
          await running.play(edits.slice(dropAfter));
          await running.settle(subscriber, 30_000);

          const polling = new WeftClient(SCOPE, deviceId("device-c"), schema);
          await polling.syncWith(running.http("token-c"), HASH);
          assert.deepEqual(rowState(subscriber), rowState(polling), "the device did not catch up after reconnecting");

          // Re-delivery is the price of a cursor that moves on send, so applying a batch twice
          // has to leave the device where applying it once did.
          const before = rowState(subscriber);
          for (const batch of delivered) subscriber.applyPull(batch);
          assert.deepEqual(rowState(subscriber), before, "applying a batch a second time changed the device");
        } finally {
          running.closeSockets();
        }
      },
    ),
    { numRuns: Math.max(4, Math.floor(RUNS / 2)), endOnFailure: true },
  );
});

test("a pushed batch too big for one message reassembles into the batch that was sent", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (multiplier) => {
      await using running = await relay();
      const { subscriber, delivered } = running.subscribe();
      try {
        const long = "x".repeat(Math.ceil((CHUNK_BYTES * multiplier) / 2));
        const writer = new WeftClient(SCOPE, deviceId("device-a"), schema);
        seed(writer, "todo-big", "big", long);
        await writer.syncWith(running.http("token-a"), HASH);
        await running.settle(subscriber, 30_000);

        assert.equal(
          subscriber.getRow(TODOS, rowId("todo-big"))?.fields.get(NOTES),
          long,
          "a chunked batch did not reassemble",
        );
        assert.equal(
          delivered.some((batch) => batch.fields.some((field) => field.field === NOTES)),
          true,
        );
      } finally {
        running.closeSockets();
      }
    }),
    { numRuns: 4, endOnFailure: true },
  );
});

interface Subscription {
  readonly subscriber: WeftClient;
  readonly delivered: readonly PullBatch[];
  readonly socket: SocketTransport;
}

interface Relay extends AsyncDisposable {
  readonly server: Awaited<ReturnType<typeof startRelay>>;
  http(token: string): ReturnType<typeof httpTransport>;
  subscribe(onApplied?: (client: WeftClient) => void): Subscription;
  play(edits: readonly Edit[]): Promise<void>;
  settle(subscriber: WeftClient, timeoutMs?: number): Promise<void>;
  records(from: number): readonly string[];
  closeSockets(): void;
}

async function relay(): Promise<Relay> {
  const server = await startRelay({
    host: "127.0.0.1",
    port: 0,
    keepaliveMs: 0,
    tokens: new Map([
      ["token-a", authContext("shared-list", "device-a")],
      ["token-b", authContext("shared-list", "device-b")],
      ["token-c", authContext("shared-list", "device-c")],
      ["token-d", authContext("someone-elses-list", "device-d")],
    ]),
  });
  const socketUrl = `${server.url.replace(/^http/u, "ws")}/sync`;
  const sockets: SocketTransport[] = [];
  const writer = new WeftClient(SCOPE, deviceId("device-a"), schema);
  const rows = ["todo-0", "todo-1", "todo-2", "todo-3"] as const;
  const used = new Set<string>();

  const running: Relay = {
    server,
    http: (token) => httpTransport({ baseUrl: server.url, token }),
    subscribe(onApplied) {
      const subscriber = new WeftClient(SCOPE, deviceId("device-b"), schema);
      const delivered: PullBatch[] = [];
      const socket = connectSocketTransport({
        url: socketUrl,
        token: "token-b",
        // Exactly what the session does with a pushed batch, and nothing else: this device
        // never pulls, so anything it ends up holding arrived unasked.
        onBatch: (batch) => {
          delivered.push(batch);
          subscriber.applyPull(batch);
          onApplied?.(subscriber);
        },
        cursor: () => subscriber.lastServerSeq,
      });
      sockets.push(socket);
      return { subscriber, delivered, socket };
    },
    async play(edits) {
      const transport = running.http("token-a");
      for (const [index, edit] of edits.entries()) {
        const id = rowId(rows[edit.kind === "drop" ? 0 : edit.row] ?? "todo-0");
        switch (edit.kind) {
          case "create": {
            // A deleted row leaves a tombstone under its id, and an id is never reused: the
            // history generates one, not the application's behaviour.
            if (!used.has(String(id))) {
              used.add(String(id));
              seed(writer, String(id), edit.title);
            }
            break;
          }
          case "edit": {
            if (writer.getRow(TODOS, id) !== undefined) {
              writer.update(TODOS, id, values({ title: edit.title }), txnId(`edit-${index}`));
            }
            break;
          }
          case "delete": {
            if (writer.getRow(TODOS, id) !== undefined) writer.delete(TODOS, id, txnId(`delete-${index}`));
            break;
          }
          case "drop": {
            server.sockets.close();
            break;
          }
        }
        await writer.syncWith(transport, HASH);
      }
    },
    async settle(subscriber, timeoutMs = 15_000) {
      const target = server.server.pull(SCOPE, 0).serverSeq;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (subscriber.lastServerSeq >= target) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`the subscriber stalled at ${subscriber.lastServerSeq} of ${target}`);
    },
    records: (from) => server.server.pull(SCOPE, from).fields.map(recordKey),
    closeSockets() {
      for (const socket of sockets) socket.close();
      sockets.length = 0;
    },
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) socket.close();
      await server.close();
    },
  };
  return running;
}

function seed(target: WeftClient, id: string, title: string, notes = "line one\nline two"): void {
  target.create(
    TODOS,
    rowId(id),
    values({ title, notes, done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId(`create-${id}`),
  );
}

function values(input: Record<string, WireValue>): Record<FieldName, WireValue> {
  return input;
}

function recordKey(record: {
  readonly rowId: string;
  readonly field: string;
  readonly serverSeq: number;
  readonly scopeId: ScopeId;
}): string {
  return `${record.scopeId}/${record.rowId}/${record.field}@${record.serverSeq}`;
}

/** What a device holds, in a form two devices compare by. */
function rowState(client: WeftClient): readonly string[] {
  return [...client.rows.entries()]
    .map(([key, row]) =>
      JSON.stringify({
        key,
        title: row.fields.get(TITLE) ?? null,
        notes: row.fields.get(NOTES) ?? null,
        fields: [...row.fields.entries()].map(([field, value]) => [String(field), value]).sort(),
      }),
    )
    .sort();
}
