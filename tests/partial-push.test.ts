// A push carries several transactions and is validated one at a time, so it can half succeed:
// the transactions before the rejected one are applied and stay applied. If the response says
// only "rejected", the client re-sends work the server already has, and the server answers the
// second copy with `row_exists` for a create and `merge_required` for a prose edit — a device
// manufacturing conflicts with itself out of a push that partly worked.
import assert from "node:assert/strict";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId, type FieldName, type WireValue } from "weftdb/core";
import { type AsyncSyncTransport, inProcessTransport, WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { schemaHash } from "weftdb/schema";
import { schema } from "weftdb-demo-todo/schema";

const SCOPE = scopeId("shared-list");
const TODOS = tableName("todos");
const NOTES = fieldName("notes");
const TITLE = fieldName("title");
const ROW = rowId("todo-1");
const HASH = schemaHash(schema);
const SKEW_MS = 6 * 60 * 1000;

function values(input: Record<string, WireValue>): Record<FieldName, WireValue> {
  return input;
}

/** A device whose clock runs ahead of the server's, so its second transaction is refused. */
function skewedPair(): { readonly server: WeftServer; readonly client: WeftClient; skew: () => void } {
  const state = { server: Date.parse("2026-03-01T09:00:00.000Z"), skewed: false };
  const server = new WeftServer(() => state.server);
  const client = new WeftClient(SCOPE, deviceId("tab-1"), schema, () => state.server + (state.skewed ? SKEW_MS : 0));
  return { server, client, skew: () => void (state.skewed = true) };
}

test("a write that loses the comparison leaves the device holding what the scope holds", async () => {
  // Losing is not rejection: the write was valid and it arrived, so the transaction is
  // acknowledged and the device drops it from its outbox. What it must not do is keep the value
  // it wrote. The record that beat it kept the sequence it already had, which is below this
  // device's cursor, so nothing it pulls afterwards carries the winner.
  //
  // The cursor gets past the winner because of the device's own queued write: a pull skips a
  // field the outbox is holding, so the sequence advances while the value does not.
  const now = Date.parse("2026-03-01T09:00:00.000Z");
  const server = new WeftServer(() => now);
  const transport = inProcessTransport(server);
  // Ahead of the other device, and well inside the skew threshold, so its stamps simply win.
  const ahead = new WeftClient(SCOPE, deviceId("ahead"), schema, () => now + 60_000);
  const behind = new WeftClient(SCOPE, deviceId("behind"), schema, () => now);

  await ahead.create(
    TODOS,
    ROW,
    values({ title: "first", notes: "n", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  await ahead.syncWith(transport, HASH);
  await behind.syncWith(transport, HASH);

  await behind.update(TODOS, ROW, values({ title: "behind" }), txnId("behind-edit"));
  await ahead.update(TODOS, ROW, values({ title: "ahead" }), txnId("ahead-edit"));
  await ahead.syncWith(transport, HASH);

  // Pulled before the push, which is the order that strands the device: the winner arrives while
  // the outbox is still holding a write for that field, so the value is skipped and the cursor
  // moves past it regardless.
  await behind.applyPull(server.pull(SCOPE, behind.lastServerSeq));
  await behind.syncWith(transport, HASH);

  assert.deepEqual(behind.outbox, [], "the losing write was not acknowledged");
  assert.deepEqual(behind.listQuarantine(), [], "a write that lost was quarantined rather than settled");
  assert.equal(
    behind.getRow(TODOS, ROW)?.fields.get(fieldName("title")),
    "ahead",
    "the device kept the value it wrote after the scope had already decided against it",
  );
});

test("a push that half succeeds acknowledges the half that landed", async () => {
  const { server, client, skew } = skewedPair();
  await client.create(
    TODOS,
    ROW,
    values({ title: "plan", notes: "first", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  skew();
  await client.update(TODOS, ROW, values({ notes: "second" }), txnId("edit"));

  const result = server.push(SCOPE, [...client.outbox]);
  assert.equal(result.ok, false, "the skewed transaction was accepted");
  if (result.ok) return;
  assert.equal(result.rejection.reason, "clock_skew");
  assert.deepEqual(
    result.acks.map((ack) => ack.txnId),
    [txnId("create")],
    "the applied transaction went unacknowledged",
  );
});

test("a device does not collide with its own half-landed push", async () => {
  const { server, client, skew } = skewedPair();
  await client.create(
    TODOS,
    ROW,
    values({ title: "plan", notes: "first", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  skew();
  await client.update(TODOS, ROW, values({ notes: "second" }), txnId("edit"));

  await client.syncWith(inProcessTransport(server), HASH);

  assert.deepEqual(
    client.listQuarantine().map((op) => `${op.txnId}:${op.reason}`),
    [],
    "the device quarantined its own work after a push that partly succeeded",
  );
  assert.equal(client.outbox.length, 0, "the outbox never drained");

  const stored = server.snapshot(SCOPE).fields;
  assert.equal(stored.find((record) => record.field === TITLE)?.value, "plan");
  assert.equal(
    stored.find((record) => record.field === NOTES)?.value,
    "second",
    "the edit behind the rejection was lost",
  );
});

test("what a half-successful push applied is durable, not just in memory", async () => {
  // The client is told those transactions were acknowledged, so a server that only persists on
  // a fully successful push has promised work it will lose on the next restart.
  const { openSqliteExecutor } = await import("weftdb/server/node-sqlite");
  const { SqliteWeftServer } = await import("weftdb/server/sqlite");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  // `join` is declared as a method on the module's type, so the rule cannot tell that it never
  // reads `this` and is safe to pull off the namespace.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const { join } = await import("node:path");

  const directory = await mkdtemp(join(tmpdir(), "weft-partial-"));
  const path = join(directory, "weft.sqlite");
  try {
    const state = { now: Date.parse("2026-03-01T09:00:00.000Z"), skewed: false };
    const first = openSqliteExecutor(path);
    const server = new SqliteWeftServer(first, () => state.now);
    const client = new WeftClient(SCOPE, deviceId("tab-1"), schema, () => state.now + (state.skewed ? SKEW_MS : 0));
    await client.create(
      TODOS,
      ROW,
      values({ title: "plan", notes: "first", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
      txnId("create"),
    );
    state.skewed = true;
    await client.update(TODOS, ROW, values({ notes: "second" }), txnId("edit"));

    const result = server.push(SCOPE, [...client.outbox]);
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.acks.length > 0, "nothing was applied, so this proves nothing");
    first.close();

    const reopened = new SqliteWeftServer(openSqliteExecutor(path), () => state.now);
    assert.equal(
      reopened.snapshot(SCOPE).fields.find((record) => record.field === TITLE)?.value,
      "plan",
      "an acknowledged transaction did not survive the restart",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a wholly successful async push does not drain edits queued while it was in flight", async () => {
  // The same hazard as the partly-acknowledged case below, on the path that succeeds outright.
  // Draining by anything other than what was actually sent takes the edit with it, and the
  // device is told the push worked, so nothing ever asks after it again.
  const { server, client } = skewedPair();
  await client.create(
    TODOS,
    ROW,
    values({ title: "plan", notes: "first", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );

  let injected = false;
  const transport: Pick<AsyncSyncTransport, "push"> = {
    push: async (scope, ops) => {
      if (!injected) {
        injected = true;
        await client.update(TODOS, ROW, values({ title: "typed while the push was in flight" }), txnId("edit"));
      }
      return server.push(scope, ops);
    },
  };

  await client.flushWith(transport as AsyncSyncTransport);

  assert.equal(client.outbox.length, 0, "the retry loop left sendable work behind");
  assert.equal(
    server.snapshot(SCOPE).fields.find((record) => record.field === TITLE)?.value,
    "typed while the push was in flight",
    "the edit queued during a successful push was dropped instead of sent",
  );
});

test("a device with nothing queued does not push at all", async () => {
  // The loop's own condition is what decides this. A client that has just synced, or has never
  // written anything, talks to the relay on a schedule; sending it empty batches is traffic
  // every idle device in a deployment pays for.
  const { server, client } = skewedPair();
  let pushes = 0;
  const original = server.push.bind(server);
  const counting = server as WeftServer & { push: WeftServer["push"] };
  counting.push = (scope, ops) => {
    pushes += 1;
    return original(scope, ops);
  };

  await client.flushWith(inProcessTransport(counting));
  assert.equal(pushes, 0, "an empty outbox still reached the relay");

  await client.create(
    TODOS,
    ROW,
    values({ title: "plan", notes: "first", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  await client.flushWith(inProcessTransport(counting));
  assert.equal(pushes, 1, "queued work took more than one push to deliver");

  await client.flushWith(inProcessTransport(counting));
  assert.equal(pushes, 1, "a drained outbox pushed again");
});

test("a partly acknowledged async push does not drain edits queued while it was in flight", async () => {
  const { server, client, skew } = skewedPair();
  await client.create(
    TODOS,
    ROW,
    values({ title: "plan", notes: "first", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  skew();
  await client.update(TODOS, ROW, values({ notes: "second" }), txnId("edit"));
  let injected = false;
  const transport: Pick<AsyncSyncTransport, "push"> = {
    push: async (scope, ops) => {
      if (!injected) {
        injected = true;
        await client.update(TODOS, ROW, values({ title: "typed while push was pending" }), txnId("create"));
      }
      return server.push(scope, ops);
    },
  };

  await client.flushWith(transport as AsyncSyncTransport);

  assert.equal(client.outbox.length, 0, "the retry loop did not finish draining sendable work");
  assert.equal(
    server.snapshot(SCOPE).fields.find((record) => record.field === TITLE)?.value,
    "typed while push was pending",
    "the edit queued during the push was never sent",
  );
});
