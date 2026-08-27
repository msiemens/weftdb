// What a device does when the server it syncs with has lost the history the device was counting
// against. A relay holding its records in memory loses them whenever it is restarted; a deployed
// one loses them when it is restored from a backup. The device cannot see either directly. What it
// can see is that the sequence numbers it holds were counted somewhere else.
import assert from "node:assert/strict";
import { test } from "vitest";
import { deviceId, rowId, scopeId, tableName, txnId, type FieldName, type WireValue } from "weftdb/core";
import { inProcessTransport, WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { schemaHash } from "weftdb/schema";
import { schema } from "weftdb-demo-todo/schema";

const SCOPE = scopeId("shared-list");
const TODOS = tableName("todos");
const HASH = schemaHash(schema);
const AT = Date.parse("2026-08-26T09:00:00.000Z");

function values(title: string, rank: number): Record<FieldName, WireValue> {
  return { title, done: false, rank: `r${String(rank)}`, notes: "" } as Record<FieldName, WireValue>;
}

function device(name: string): WeftClient {
  return new WeftClient(SCOPE, deviceId(name), schema, () => AT);
}

function serverNamed(epoch: string): WeftServer {
  return new WeftServer(
    () => AT,
    undefined,
    () => epoch,
  );
}

test("a device whose cursor was counted in another epoch is told to resync", async () => {
  const first = serverNamed("epoch-1");
  const author = device("tab-1");
  // Enough work that this device's cursor ends up above anything the replacement will reach,
  // because keeping the higher of the two leaves the device asking for records after a point the
  // replacement never gets to.
  await author.create(TODOS, rowId("todo-1"), values("seeded", 1), txnId("txn-1"));
  await author.create(TODOS, rowId("todo-3"), values("also seeded", 3), txnId("txn-3"));
  await author.syncWith(inProcessTransport(first), HASH);
  const reached = author.lastServerSeq;
  assert.ok(reached > 0, "the device never advanced against the first server");
  assert.equal(author.serverEpoch, "epoch-1");

  // The relay comes back having lost everything, which is what a restarted in-memory relay is.
  // Its scope starts again at sequence 0 and climbs as other devices write to it.
  const replacement = serverNamed("epoch-2");
  const other = device("tab-2");
  await other.create(TODOS, rowId("todo-2"), values("written after", 2), txnId("txn-2"));
  await other.syncWith(inProcessTransport(replacement), HASH);
  const head = replacement.scopes.get(SCOPE)?.serverSeq ?? 0;
  assert.ok(head < reached, "the replacement reached as far as the first server, so the cursor proves nothing");

  await author.syncWith(inProcessTransport(replacement), HASH);

  assert.equal(author.serverEpoch, "epoch-2", "the device kept counting in a history that had gone");
  assert.equal(author.lastServerSeq, head, "the cursor was not adopted");
  assert.deepEqual(
    [...author.rows.values()].map((row) => row.fields.get("title" as FieldName)).sort(),
    ["written after"],
    "the device did not take the replacement's world",
  );
});

test("a cursor above the server's head is refused even where the epoch matches", async () => {
  // A restore that lands below where a device had reached, with the epoch preserved. The records
  // are the same run of history, and the device is still ahead of everything the server holds.
  const server = serverNamed("epoch-1");
  const author = device("tab-1");
  await author.create(TODOS, rowId("todo-1"), values("seeded", 1), txnId("txn-1"));
  await author.syncWith(inProcessTransport(server), HASH);
  const reached = author.lastServerSeq;

  const scope = server.scopes.get(SCOPE);
  assert.ok(scope !== undefined);
  scope.serverSeq = reached - 1;

  assert.deepEqual(server.handshake(author.handshakeRequest(HASH)), {
    ok: false,
    reason: "resync_required",
    epoch: "epoch-1",
  });
});

test("an ordinary sync against a server that has kept its history is not disturbed", async () => {
  // The check has to stay quiet on the path everything else takes, or it converts every sync into
  // a snapshot and the incremental protocol stops existing.
  const server = serverNamed("epoch-1");
  const author = device("tab-1");
  await author.create(TODOS, rowId("todo-1"), values("first", 1), txnId("txn-1"));
  await author.syncWith(inProcessTransport(server), HASH);
  const afterFirst = author.lastServerSeq;

  await author.create(TODOS, rowId("todo-2"), values("second", 2), txnId("txn-2"));
  await author.syncWith(inProcessTransport(server), HASH);

  assert.equal(server.handshake(author.handshakeRequest(HASH)).ok, true, "a caught-up device was told to resync");
  assert.ok(author.lastServerSeq > afterFirst, "the cursor stopped advancing");
  assert.equal(author.rows.size, 2);
});

test("a batch from another epoch is refused on the path the handshake does not cover", async () => {
  // The socket hands batches straight to `applyPull`, with no handshake in front of them.
  const first = serverNamed("epoch-1");
  const author = device("tab-1");
  await author.create(TODOS, rowId("todo-1"), values("seeded", 1), txnId("txn-1"));
  await author.syncWith(inProcessTransport(first), HASH);

  const replacement = serverNamed("epoch-2");
  const other = device("tab-2");
  await other.create(TODOS, rowId("todo-2"), values("written after", 2), txnId("txn-2"));
  await other.syncWith(inProcessTransport(replacement), HASH);

  await author.applyPull(replacement.pull(SCOPE, 0));

  assert.equal(author.resyncRequired, true, "a batch from a history this device never held was applied");
  assert.equal(author.rows.has(`${TODOS}\0todo-2`), false, "the batch was applied despite the epoch");
});
