// The demo talks to the relay over HTTP, so the sync session has to survive JSON. Every op,
// rejection, ack and snapshot crosses a real Request/Response boundary here, instead of being
// handed directly between two objects in the same heap.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  deviceId,
  fieldName,
  rowId,
  scopeId,
  tableName,
  txnId,
  wireText,
  type WireValue,
  type FieldName,
} from "weftdb/core";
import { type AsyncSyncTransport, type FetchLike, httpTransport, inProcessTransport, WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { createRelayHandler, type TokenVerifier } from "weftdb/server/relay";
import { schemaHash } from "weftdb/schema";
import { schema } from "weftdb-demo-todo/schema";
import { TODO_SCOPE as DEMO_SCOPE } from "weftdb-demo-todo/scope";
import { demoToken, demoVerifier } from "weftdb-demo-shared/auth";

const TODOS = tableName("todos");
const TITLE = fieldName("title");
const NOTES = fieldName("notes");
const HASH = schemaHash(schema);

// A token names the scope it may reach, so these are built here instead of written out plainly.
// The last test turns on a client whose scope is not the one its token names.
const ALPHA = demoToken(DEMO_SCOPE, "alpha");
const BETA = demoToken(DEMO_SCOPE, "beta");

/** The relay's real handler, reached through real Request/Response objects but no socket. */
function relayTransport(server: WeftServer, token: string, verifier: TokenVerifier = demoVerifier): AsyncSyncTransport {
  const handler = createRelayHandler({ server, verifier });
  const fetchLike: FetchLike = async (input, init) =>
    handler(new Request(`http://relay${input.replace(/^\/api/u, "")}`, init));
  return httpTransport({ baseUrl: "/api", token, fetch: fetchLike });
}

function client(device: string, now?: () => number): WeftClient {
  return new WeftClient(DEMO_SCOPE, deviceId(device), schema, now);
}

function values(input: Record<string, WireValue>): Record<FieldName, WireValue> {
  return input;
}

async function newTodo(target: WeftClient, id: string, title: string, notes = ""): Promise<void> {
  await target.create(
    TODOS,
    rowId(id),
    values({ title, notes, done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId(`create-${id}`),
  );
}

test("two devices converge through the relay's HTTP surface", async () => {
  const server = new WeftServer();
  const alpha = client("alpha");
  const beta = client("beta");

  await newTodo(alpha, "todo-1", "buy milk", "Monday: nothing yet\nTuesday: nothing yet");
  await alpha.syncWith(relayTransport(server, ALPHA), HASH);
  await beta.syncWith(relayTransport(server, BETA), HASH);

  assert.equal(beta.getRow(TODOS, rowId("todo-1"))?.fields.get(TITLE), "buy milk");
  assert.equal(alpha.outbox.length, 0, "acknowledged work stayed in the outbox");
});

test("edits to different note lines merge across the wire", async () => {
  const server = new WeftServer();
  const alpha = client("alpha");
  const beta = client("beta");
  await newTodo(alpha, "todo-1", "plan", "Monday: nothing yet\nTuesday: nothing yet");
  await alpha.syncWith(relayTransport(server, ALPHA), HASH);
  await beta.syncWith(relayTransport(server, BETA), HASH);

  await alpha.update(
    TODOS,
    rowId("todo-1"),
    values({ notes: "Monday: draft the proposal\nTuesday: nothing yet" }),
    txnId("a1"),
  );
  await beta.update(
    TODOS,
    rowId("todo-1"),
    values({ notes: "Monday: nothing yet\nTuesday: review with Sam" }),
    txnId("b1"),
  );

  await alpha.syncWith(relayTransport(server, ALPHA), HASH);
  await beta.syncWith(relayTransport(server, BETA), HASH);
  await alpha.syncWith(relayTransport(server, ALPHA), HASH);

  for (const [name, target] of [
    ["alpha", alpha],
    ["beta", beta],
  ] as const) {
    const notes = wireText(target.getRow(TODOS, rowId("todo-1"))?.fields.get(NOTES) ?? "");
    assert.match(notes, /draft the proposal/u, `${name} lost alpha's line`);
    assert.match(notes, /review with Sam/u, `${name} lost beta's line`);
    assert.doesNotMatch(notes, /WEFT_LOCAL/u, `${name} reported a conflict for disjoint lines`);
  }
});

test("a rejection survives the wire and quarantines the diverged work", async () => {
  // A delete alone leaves a tombstone, and a late edit against one is simply outvoted. The
  // case with nowhere to put the edit is a row that has been purged out from under it.
  let now = Date.parse("2026-03-01T09:00:00.000Z");
  const clock = (): number => now;
  const server = new WeftServer(clock);
  const alpha = client("alpha", clock);
  const beta = client("beta", clock);
  await newTodo(alpha, "todo-1", "plan");
  await alpha.syncWith(relayTransport(server, ALPHA), HASH);
  await beta.syncWith(relayTransport(server, BETA), HASH);

  // Alpha, offline, edits the row beta is about to delete.
  await alpha.update(TODOS, rowId("todo-1"), values({ title: "plan (edited)" }), txnId("a-edit"));
  await beta.delete(TODOS, rowId("todo-1"), txnId("b-delete"));
  await beta.syncWith(relayTransport(server, BETA), HASH);

  now += 31 * 24 * 60 * 60 * 1000;
  assert.equal(server.pruneTombstones(DEMO_SCOPE), 1, "the tombstone was not purged");

  await alpha.syncWith(relayTransport(server, ALPHA), HASH);
  const quarantined = alpha.listQuarantine();
  assert.ok(quarantined.length > 0, "the diverged edit was neither applied nor surfaced");
  assert.equal(alpha.outbox.length, 0, "quarantine is a move, not a copy");
  // The edit stays visible until somebody decides what to do with it. Losing it quietly at
  // this point would be the same data loss the quarantine exists to prevent (§5.5).
  assert.equal(alpha.getRow(TODOS, rowId("todo-1"))?.fields.get(TITLE), "plan (edited)");

  for (const transaction of new Set(quarantined.map((op) => op.txnId))) {
    await alpha.discardQuarantinedTxn(transaction);
  }
  await alpha.syncWith(relayTransport(server, ALPHA), HASH);
  assert.equal(alpha.listQuarantine().length, 0);
  assert.equal(alpha.getRow(TODOS, rowId("todo-1")), undefined, "discarding left the purged row behind");
});

test("an unreachable relay leaves the work in the outbox rather than losing it", async () => {
  const alpha = client("alpha");
  await newTodo(alpha, "todo-1", "buy milk");
  const pending = alpha.outbox.length;

  const dead = httpTransport({
    baseUrl: "/api",
    token: ALPHA,
    fetch: async () => {
      throw new Error("connection refused");
    },
  });
  await assert.rejects(alpha.syncWith(dead, HASH), /connection refused/u);
  assert.equal(alpha.outbox.length, pending, "unsent ops were dropped by a failed sync");
});

test("a token the relay does not recognise fails loudly instead of silently not syncing", async () => {
  const server = new WeftServer();
  const alpha = client("alpha");
  await newTodo(alpha, "todo-1", "buy milk");

  await assert.rejects(
    alpha.syncWith(relayTransport(server, "not-a-demo-token"), HASH),
    (error: unknown) => error instanceof Error && /401/u.test(error.message),
  );
  assert.equal(alpha.outbox.length > 0, true, "work was drained despite never reaching the server");
});

test("the asynchronous session ends where the synchronous one does", async () => {
  // The two paths share every decision and differ only in sequencing. Pinning this matters
  // because a divergence here is a bug the whole property suite would miss, since it only
  // drives sync.
  const overHttp = new WeftServer();
  const inProcess = new WeftServer();
  const remote = client("alpha");
  const local = client("alpha");

  for (const [target, run] of [
    [remote, async () => remote.syncWith(relayTransport(overHttp, ALPHA), HASH)],
    [
      local,
      async () => {
        await local.syncWith(inProcessTransport(inProcess), HASH);
      },
    ],
  ] as const) {
    await newTodo(target, "todo-1", "plan", "Monday: nothing yet");
    await run();
    await target.update(TODOS, rowId("todo-1"), values({ title: "plan the week" }), txnId("edit"));
    await run();
    await target.delete(TODOS, rowId("todo-1"), txnId("remove"));
    await run();
  }

  assert.deepEqual(
    [...remote.rows.keys()].sort(),
    [...local.rows.keys()].sort(),
    "the two paths disagree about which rows exist",
  );
  assert.equal(remote.lastServerSeq, local.lastServerSeq, "the two paths disagree about the cursor");
  assert.equal(remote.outbox.length, local.outbox.length);
  assert.equal(remote.listQuarantine().length, local.listQuarantine().length);
});

test("the relay refuses a handshake for a scope the token does not name", async () => {
  const server = new WeftServer();
  const impostor = new WeftClient(scopeId("someone-elses-list"), deviceId("alpha"), schema);
  await newTodo(impostor, "todo-1", "buy milk");

  await assert.rejects(
    impostor.syncWith(relayTransport(server, ALPHA), HASH),
    (error: unknown) => error instanceof Error && /403/u.test(error.message),
    "a client reached a scope its token does not name",
  );
});
