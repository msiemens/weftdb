// Typing is not one edit. A field that merges with diff3 carries the hash of the version it
// was written against, and several edits queued before a sync are pushed together — so each
// one's ancestor has to be the edit queued before it, not the last thing the server said. When
// it was the latter, a single device typing into a note could not push at all: every op after
// the first was rejected as `merge_required` against a value only it had written.
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
import { WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { schemaHash } from "weftdb/schema";
import { schema } from "weftdb-demo-todo/schema";

const SCOPE = scopeId("shared-list");
const TODOS = tableName("todos");
const NOTES = fieldName("notes");
const TITLE = fieldName("title");
const ROW = rowId("todo-1");
const HASH = schemaHash(schema);

function values(input: Record<string, WireValue>): Record<FieldName, WireValue> {
  return input;
}

function seeded(): { readonly server: WeftServer; readonly client: WeftClient } {
  const server = new WeftServer();
  const client = new WeftClient(SCOPE, deviceId("tab-1"), schema);
  client.create(
    TODOS,
    ROW,
    values({ title: "plan", notes: "", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  client.sync(server, HASH);
  return { server, client };
}

function serverValue(server: WeftServer, field: FieldName): WireValue | undefined {
  return server.snapshot(SCOPE).fields.find((record) => record.field === field && record.rowId === ROW)?.value;
}

function serverRowValue(server: WeftServer, row: ReturnType<typeof rowId>, field: FieldName): WireValue | undefined {
  return server.snapshot(SCOPE).fields.find((record) => record.field === field && record.rowId === row)?.value;
}

test("keystrokes queued into a diff3 field before a sync all push", () => {
  const { server, client } = seeded();
  for (const [index, text] of ["h", "he", "hel", "hell", "hello"].entries()) {
    client.update(TODOS, ROW, values({ notes: text }), txnId(`key-${index}`));
  }
  client.sync(server, HASH);

  assert.equal(client.listQuarantine().length, 0, "a device's own successive edits were quarantined");
  assert.equal(client.outbox.length, 0, "the outbox never drained");
  assert.equal(serverValue(server, NOTES), "hello");
  assert.equal(client.getRow(TODOS, ROW)?.fields.get(NOTES), "hello", "the local value was rewritten backwards");
});

test("one device's edits to a diff3 field converge on what it last typed", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 1, maxLength: 12 }),
      fc.integer({ min: 1, max: 4 }),
      (edits, syncEvery) => {
        const { server, client } = seeded();
        for (const [index, text] of edits.entries()) {
          client.update(TODOS, ROW, values({ notes: text }), txnId(`edit-${index}`));
          // Syncing at an arbitrary rhythm: what matters is that the queue may hold any number
          // of edits when it is finally pushed.
          if ((index + 1) % syncEvery === 0) client.sync(server, HASH);
        }
        client.sync(server, HASH);

        const last = edits.at(-1);
        assert.equal(client.listQuarantine().length, 0, "a device's own edits were quarantined");
        assert.equal(client.outbox.length, 0, "the outbox never drained");
        assert.equal(serverValue(server, NOTES), last, "the server did not end on the last thing typed");
        assert.equal(client.getRow(TODOS, ROW)?.fields.get(NOTES), last, "the device does not show what it typed");
      },
    ),
    { numRuns: 400 },
  );
});

test("a queued diff3 edit is still rebased against another device's write", () => {
  // The chained base must not paper over a real conflict: an edit from elsewhere landing
  // between the queue and the push still has to be merged rather than overwritten.
  const { server, client } = seeded();
  client.update(TODOS, ROW, values({ notes: "Monday: nothing\nTuesday: nothing" }), txnId("seed"));
  client.sync(server, HASH);

  const other = new WeftClient(SCOPE, deviceId("tab-2"), schema);
  other.sync(server, HASH);
  other.update(TODOS, ROW, values({ notes: "Monday: nothing\nTuesday: review with Sam" }), txnId("remote"));
  other.sync(server, HASH);

  client.update(TODOS, ROW, values({ notes: "Monday: draft it\nTuesday: nothing" }), txnId("local-1"));
  client.update(TODOS, ROW, values({ notes: "Monday: draft the proposal\nTuesday: nothing" }), txnId("local-2"));
  client.sync(server, HASH);
  client.sync(server, HASH);

  const merged = wireText(client.getRow(TODOS, ROW)?.fields.get(NOTES) ?? "");
  assert.match(merged, /draft the proposal/u, "the local edit was lost");
  assert.match(merged, /review with Sam/u, "the remote edit was overwritten instead of merged");
  assert.equal(client.outbox.length, 0, "the merged result never reached the server");
});

test("a merge survives the field's last-writer-wins comparison", () => {
  // The rebased write is stamped by a clock that has never seen the value it merged with, so
  // without the server's stamp travelling back with the rejection the push accepts the merge
  // and the field comparison then discards it — an edit the client was told had landed.
  const { server, client } = seeded();
  client.update(TODOS, ROW, values({ notes: "line one\nline two" }), txnId("seed"));
  client.sync(server, HASH);

  // A device whose id sorts after this one, so it wins every tie the clocks cannot break.
  const later = new WeftClient(SCOPE, deviceId("zz-last"), schema);
  later.sync(server, HASH);
  later.update(TODOS, ROW, values({ notes: "line one\nline two, revised" }), txnId("remote"));
  later.sync(server, HASH);

  client.update(TODOS, ROW, values({ notes: "line one, edited\nline two" }), txnId("local"));
  client.sync(server, HASH);
  client.sync(server, HASH);

  assert.match(wireText(serverValue(server, NOTES) ?? ""), /line one, edited/u, "the merge was outvoted and dropped");
  assert.match(wireText(client.getRow(TODOS, ROW)?.fields.get(NOTES) ?? ""), /line one, edited/u);
  assert.match(wireText(client.getRow(TODOS, ROW)?.fields.get(NOTES) ?? ""), /line two, revised/u);
});

test("rebasing one diff3 row does not rewrite another row in the same transaction", () => {
  const server = new WeftServer();
  const local = new WeftClient(SCOPE, deviceId("tab-1"), schema);
  const remote = new WeftClient(SCOPE, deviceId("tab-2"), schema);
  const first = rowId("todo-1");
  const second = rowId("todo-2");

  for (const row of [first, second]) {
    local.create(
      TODOS,
      row,
      values({
        title: String(row),
        notes: "line one\nline two",
        done: false,
        rank: "a0",
        due_at: null,
        auto_delete_days: null,
      }),
      txnId(`create-${row}`),
    );
  }
  local.sync(server, HASH);
  remote.sync(server, HASH);

  remote.update(TODOS, first, values({ notes: "line one\nline two, remote" }), txnId("remote-first"));
  remote.sync(server, HASH);

  const transaction = txnId("local-both");
  local.update(TODOS, first, values({ notes: "line one, local\nline two" }), transaction);
  local.update(TODOS, second, values({ notes: "second row only" }), transaction);
  local.sync(server, HASH);
  local.sync(server, HASH);

  assert.equal(
    local.listQuarantine().some((op) => op.rowId === second),
    false,
    "an unrelated row was quarantined by another row's rebase",
  );
  assert.equal(
    serverRowValue(server, second, NOTES),
    "second row only",
    "an unrelated row's edit was overwritten during rebase",
  );
  assert.equal(
    local.getRow(TODOS, second)?.fields.get(NOTES),
    "second row only",
    "local state for the unrelated row was rewritten",
  );

  const mergedFirst = wireText(serverRowValue(server, first, NOTES) ?? "");
  assert.match(mergedFirst, /line one, local/u, "the rebased row lost its local edit");
  assert.match(mergedFirst, /line two, remote/u, "the rebased row lost the remote edit");
});

test("a create transaction may refine a diff3 field before it is pushed", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 40 }),
      fc.string({ minLength: 1, maxLength: 40 }),
      (initialNotes, refinedNotes) => {
        fc.pre(initialNotes !== refinedNotes);
        const server = new WeftServer(() => 1_000);
        const client = new WeftClient(SCOPE, deviceId("tab-1"), schema, () => 1_000);
        const transaction = txnId("create-and-refine");

        client.create(
          TODOS,
          ROW,
          values({ title: "plan", notes: initialNotes, done: false, rank: "a0", due_at: null, auto_delete_days: null }),
          transaction,
        );
        client.update(TODOS, ROW, values({ notes: refinedNotes }), transaction);
        client.sync(server, HASH);

        assert.equal(client.listQuarantine().length, 0, "a valid create transaction was quarantined");
        assert.equal(client.outbox.length, 0, "the valid transaction did not drain");
        assert.equal(serverValue(server, NOTES), refinedNotes, "the transaction did not land as one atomic unit");
      },
    ),
    { numRuns: 200 },
  );
});

test("the same rhythm on a last-writer-wins field is unaffected", () => {
  const { server, client } = seeded();
  for (const [index, text] of ["p", "pl", "pla", "plan"].entries()) {
    client.update(TODOS, ROW, values({ title: text }), txnId(`title-${index}`));
  }
  client.sync(server, HASH);

  assert.equal(client.listQuarantine().length, 0);
  assert.equal(client.outbox.length, 0);
  assert.equal(serverValue(server, TITLE), "plan");
});
