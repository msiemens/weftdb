// Typing is not one edit. A field that merges with diff3 carries the hash of the version it
// was written against, and several edits queued before a sync are pushed together — so each
// one's ancestor has to be the edit queued before it, not the last thing the server said. Take
// the latter and a single device typing into a note cannot push at all: every op after the first
// is rejected as `merge_required` against a value only that device has written.
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
} from "weftdb/core";
import { inProcessTransport, WeftClient } from "weftdb/client";
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

async function seeded(): Promise<{ readonly server: WeftServer; readonly client: WeftClient }> {
  const server = new WeftServer();
  const client = new WeftClient(SCOPE, deviceId("tab-1"), schema);
  await client.create(
    TODOS,
    ROW,
    values({ title: "plan", notes: "", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  await client.syncWith(inProcessTransport(server), HASH);
  return { server, client };
}

function serverValue(server: WeftServer, field: FieldName): WireValue | undefined {
  return server.snapshot(SCOPE).fields.find((record) => record.field === field && record.rowId === ROW)?.value;
}

function serverRowValue(server: WeftServer, row: ReturnType<typeof rowId>, field: FieldName): WireValue | undefined {
  return server.snapshot(SCOPE).fields.find((record) => record.field === field && record.rowId === row)?.value;
}

test("keystrokes queued into a diff3 field before a sync all push", async () => {
  const { server, client } = await seeded();
  for (const [index, text] of ["h", "he", "hel", "hell", "hello"].entries()) {
    await client.update(TODOS, ROW, values({ notes: text }), txnId(`key-${index}`));
  }
  await client.syncWith(inProcessTransport(server), HASH);

  assert.equal(client.listQuarantine().length, 0, "a device's own successive edits were quarantined");
  assert.equal(client.outbox.length, 0, "the outbox never drained");
  assert.equal(serverValue(server, NOTES), "hello");
  assert.equal(client.getRow(TODOS, ROW)?.fields.get(NOTES), "hello", "the local value was rewritten backwards");
});

test("one device's edits to a diff3 field converge on what it last typed", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 1, maxLength: 12 }),
      fc.integer({ min: 1, max: 4 }),
      async (edits, syncEvery) => {
        const { server, client } = await seeded();
        for (const [index, text] of edits.entries()) {
          await client.update(TODOS, ROW, values({ notes: text }), txnId(`edit-${index}`));
          // Syncing at an arbitrary rhythm: what matters is that the queue may hold any number
          // of edits when it is finally pushed.
          if ((index + 1) % syncEvery === 0) await client.syncWith(inProcessTransport(server), HASH);
        }
        await client.syncWith(inProcessTransport(server), HASH);

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

test("a queued diff3 edit is still rebased against another device's write", async () => {
  // The chained base must not paper over a real conflict: an edit from elsewhere landing
  // between the queue and the push still has to be merged rather than overwritten.
  const { server, client } = await seeded();
  await client.update(TODOS, ROW, values({ notes: "Monday: nothing\nTuesday: nothing" }), txnId("seed"));
  await client.syncWith(inProcessTransport(server), HASH);

  const other = new WeftClient(SCOPE, deviceId("tab-2"), schema);
  await other.syncWith(inProcessTransport(server), HASH);
  await other.update(TODOS, ROW, values({ notes: "Monday: nothing\nTuesday: review with Sam" }), txnId("remote"));
  await other.syncWith(inProcessTransport(server), HASH);

  await client.update(TODOS, ROW, values({ notes: "Monday: draft it\nTuesday: nothing" }), txnId("local-1"));
  await client.update(TODOS, ROW, values({ notes: "Monday: draft the proposal\nTuesday: nothing" }), txnId("local-2"));
  await client.syncWith(inProcessTransport(server), HASH);
  await client.syncWith(inProcessTransport(server), HASH);

  const merged = wireText(client.getRow(TODOS, ROW)?.fields.get(NOTES) ?? "");
  assert.match(merged, /draft the proposal/u, "the local edit was lost");
  assert.match(merged, /review with Sam/u, "the remote edit was overwritten instead of merged");
  assert.equal(client.outbox.length, 0, "the merged result never reached the server");
});

test("a merge survives the field's last-writer-wins comparison", async () => {
  // The rebased write is stamped by a clock that has never seen the value it merged with, so
  // without the server's stamp travelling back with the rejection the push accepts the merge
  // and the field comparison then discards it — an edit the client was told had landed.
  const { server, client } = await seeded();
  await client.update(TODOS, ROW, values({ notes: "line one\nline two" }), txnId("seed"));
  await client.syncWith(inProcessTransport(server), HASH);

  // A device whose id sorts after this one, so it wins every tie the clocks cannot break.
  const later = new WeftClient(SCOPE, deviceId("zz-last"), schema);
  await later.syncWith(inProcessTransport(server), HASH);
  await later.update(TODOS, ROW, values({ notes: "line one\nline two, revised" }), txnId("remote"));
  await later.syncWith(inProcessTransport(server), HASH);

  await client.update(TODOS, ROW, values({ notes: "line one, edited\nline two" }), txnId("local"));
  await client.syncWith(inProcessTransport(server), HASH);
  await client.syncWith(inProcessTransport(server), HASH);

  assert.match(wireText(serverValue(server, NOTES) ?? ""), /line one, edited/u, "the merge was outvoted and dropped");
  assert.match(wireText(client.getRow(TODOS, ROW)?.fields.get(NOTES) ?? ""), /line one, edited/u);
  assert.match(wireText(client.getRow(TODOS, ROW)?.fields.get(NOTES) ?? ""), /line two, revised/u);
});

test("rebasing one diff3 row does not rewrite another row in the same transaction", async () => {
  const server = new WeftServer();
  const local = new WeftClient(SCOPE, deviceId("tab-1"), schema);
  const remote = new WeftClient(SCOPE, deviceId("tab-2"), schema);
  const first = rowId("todo-1");
  const second = rowId("todo-2");

  for (const row of [first, second]) {
    await local.create(
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
  await local.syncWith(inProcessTransport(server), HASH);
  await remote.syncWith(inProcessTransport(server), HASH);

  await remote.update(TODOS, first, values({ notes: "line one\nline two, remote" }), txnId("remote-first"));
  await remote.syncWith(inProcessTransport(server), HASH);

  const transaction = txnId("local-both");
  await local.update(TODOS, first, values({ notes: "line one, local\nline two" }), transaction);
  await local.update(TODOS, second, values({ notes: "second row only" }), transaction);
  await local.syncWith(inProcessTransport(server), HASH);
  await local.syncWith(inProcessTransport(server), HASH);

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

test("a create transaction may refine a diff3 field before it is pushed", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 40 }),
      fc.string({ minLength: 1, maxLength: 40 }),
      async (initialNotes, refinedNotes) => {
        fc.pre(initialNotes !== refinedNotes);
        const server = new WeftServer(() => 1_000);
        const client = new WeftClient(SCOPE, deviceId("tab-1"), schema, () => 1_000);
        const transaction = txnId("create-and-refine");

        await client.create(
          TODOS,
          ROW,
          values({ title: "plan", notes: initialNotes, done: false, rank: "a0", due_at: null, auto_delete_days: null }),
          transaction,
        );
        await client.update(TODOS, ROW, values({ notes: refinedNotes }), transaction);
        await client.syncWith(inProcessTransport(server), HASH);

        assert.equal(client.listQuarantine().length, 0, "a valid create transaction was quarantined");
        assert.equal(client.outbox.length, 0, "the valid transaction did not drain");
        assert.equal(serverValue(server, NOTES), refinedNotes, "the transaction did not land as one atomic unit");
      },
    ),
    { numRuns: 200 },
  );
});

test("prose written before the relay was ever heard from does not come back marked", async () => {
  // The ancestor a rebase merges against is recorded on every pull, applied or not. Record it
  // only when the value is applied and a device that wrote the field before it ever received one —
  // a row made offline, or one whose every pull is shadowed by the unsent write sitting on top of
  // it — reaches `rebase` with no ancestor, where `diff3("", mine, theirs)` matches neither side
  // and returns a conflict block. The markers are the signal that two writers contended (§6), so
  // producing them where the relay's copy is the very text this edit was made from makes the
  // signal a lie.
  const prose = "alpha\nbravo\ncharlie\ndelta";
  const server = new WeftServer();

  const first = new WeftClient(SCOPE, deviceId("tab-1"), schema);
  await first.create(
    TODOS,
    ROW,
    values({ title: "plan", notes: prose, done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create-first"),
  );
  await first.syncWith(inProcessTransport(server), HASH);

  // The second device makes the same row offline, so its create is refused and set aside. That
  // leaves it holding the row with a quarantined write on `notes`, which is what shadows every
  // pull that would otherwise have told it what the relay holds.
  const second = new WeftClient(SCOPE, deviceId("tab-2"), schema);
  await second.create(
    TODOS,
    ROW,
    values({ title: "plan", notes: prose, done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create-second"),
  );
  await second.syncWith(inProcessTransport(server), HASH);

  // Only now does it edit one line, of prose the relay's copy still agrees with word for word.
  await second.update(TODOS, ROW, values({ notes: prose.replace("alpha", "revised") }), txnId("edit-second"));
  for (let attempt = 0; attempt < 4; attempt += 1) await second.syncWith(inProcessTransport(server), HASH);

  const local = wireText(second.getRow(TODOS, ROW)?.fields.get(NOTES) ?? "");
  assert.doesNotMatch(local, /WEFT_LOCAL/u, `an uncontended edit came back marked: ${JSON.stringify(local)}`);
  assert.equal(local.split("\n")[0], "revised", "the edit was lost rather than kept");
});

test("the same rhythm on a last-writer-wins field is unaffected", async () => {
  const { server, client } = await seeded();
  for (const [index, text] of ["p", "pl", "pla", "plan"].entries()) {
    await client.update(TODOS, ROW, values({ title: text }), txnId(`title-${index}`));
  }
  await client.syncWith(inProcessTransport(server), HASH);

  assert.equal(client.listQuarantine().length, 0);
  assert.equal(client.outbox.length, 0);
  assert.equal(serverValue(server, TITLE), "plan");
});
