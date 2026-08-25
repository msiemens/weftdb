// A device whose rows do not survive a reload and whose unsent work does.
//
// The split is the point. Rows came from the relay and can be asked for again, so losing them costs
// a snapshot. The outbox and the quarantine came from the person, and §4.1 makes them the client's
// state rather than a cache of it — nothing else holds them, so a reload that dropped them would
// lose work that was typed and never sent, with nothing to say so.
//
// `openSqliteExecutor(":memory:")` stands in for the wasm in-memory database a browser would use:
// what matters here is that it is synchronous and that a fresh one starts empty, which is exactly
// what a reload produces.
import assert from "node:assert/strict";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, type HlcString } from "weftdb/core";
import { defineSchema, S } from "weftdb/schema";
import { EphemeralClientStore, type StorageLike, type WeftClient } from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";

const schema = defineSchema({
  todos: S.collection({
    title: S.string(),
    done: S.boolean(),
  }),
});

const SCOPE = scopeId("scope-1");
const DEVICE = deviceId("device-1");
const TODOS = tableName("todos");

/** `localStorage`, as much of it as this needs, with the keys visible to a test. */
class FakeStorage implements StorageLike {
  readonly items = new Map<string, string>();
  failWith: string | undefined;

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWith !== undefined) throw new Error(this.failWith);
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** One tab's lifetime: a database of its own, and whatever storage it was handed. */
function session(
  storage: StorageLike,
  onError?: (error: Error) => void,
  scope = SCOPE,
  device = DEVICE,
): { store: EphemeralClientStore; executor: ReturnType<typeof openSqliteExecutor>; client: WeftClient } {
  const executor = openSqliteExecutor(":memory:");
  const rows = new SqliteClientStore(executor, schema);
  const store = new EphemeralClientStore({
    rows,
    storage,
    ...(onError === undefined ? {} : { onError }),
  });
  store.installSchema();
  return { store, executor, client: store.hydrate(scope, device) };
}

test("unsent work comes back after a reload, and the rows do not", () => {
  const storage = new FakeStorage();

  const first = session(storage);
  first.client.create(TODOS, rowId("todo-1"), { [fieldName("title")]: "alpha", [fieldName("done")]: false });
  assert.equal(first.client.rows.size, 1);
  const queued = first.client.outbox.length;
  assert.ok(queued > 0, "the write queued nothing, so this test proves nothing");
  first.executor.close();

  // The tab reloads: a new in-memory database, the same `localStorage`.
  const second = session(storage);

  assert.equal(second.client.outbox.length, queued, "the work this device had not sent was lost on reload");
  assert.equal(second.client.rows.size, 0, "rows survived a database that does not");
  // A cursor is a claim about what this device has already seen. It has seen none of it, so asking
  // for an increment from where it left off would leave it believing it holds what it does not.
  assert.equal(second.client.lastServerSeq, 0);
  assert.equal(second.client.resyncRequired, true, "the next sync would pull incrementally into an empty database");
  second.executor.close();
});

test("quarantined work comes back too", () => {
  const storage = new FakeStorage();

  const first = session(storage);
  first.client.create(TODOS, rowId("todo-1"), { [fieldName("title")]: "alpha", [fieldName("done")]: false });
  // Moved by hand into the state a refused push leaves behind, which is what §5.5 says a person has
  // to decide about. Reaching it through a relay would test the refusal; what is under test here is
  // whether it survives the tab.
  const rejected = first.client.outbox.splice(0, first.client.outbox.length);
  first.client.quarantine.push(...rejected.map((op) => ({ ...op, rejectedAt: 1_000, reason: "row_exists" as const })));
  first.store.save(first.client);
  const held = first.client.listQuarantine().length;
  assert.ok(held > 0, "nothing reached quarantine, so this test proves nothing");
  first.executor.close();

  const second = session(storage);

  // Losing it would resolve a divergence the person never decided about, which is what §5.5 forbids.
  assert.equal(second.client.listQuarantine().length, held, "a divergence was dropped rather than kept");
  second.executor.close();
});

test("the clock comes back above the work it already stamped", () => {
  const storage = new FakeStorage();

  const first = session(storage);
  first.client.create(TODOS, rowId("todo-1"), { [fieldName("title")]: "alpha", [fieldName("done")]: false });
  const highest = [...first.client.outbox].map((op) => op.hlc).sort()[first.client.outbox.length - 1] as HlcString;
  first.executor.close();

  const second = session(storage);
  second.client.create(TODOS, rowId("todo-2"), { [fieldName("title")]: "beta", [fieldName("done")]: false });

  // An edit made after a reload has to stamp above work still queued from before it. Below, and it
  // loses the field-wise comparison to a value the person typed over and never sees again.
  const after = second.client.outbox.filter((op) => op.rowId === rowId("todo-2")).map((op) => op.hlc);
  assert.ok(after.length > 0);
  for (const stamp of after) {
    assert.ok(stamp > highest, `a write after the reload stamped ${stamp}, at or below the queued ${highest}`);
  }
  second.executor.close();
});

test("a queue written by another build is dropped rather than half-read", () => {
  const storage = new FakeStorage();
  const errors: Error[] = [];

  const first = session(storage);
  first.client.create(TODOS, rowId("todo-1"), { [fieldName("title")]: "alpha", [fieldName("done")]: false });
  const key = [...storage.items.keys()][0];
  if (key === undefined) throw new Error("nothing was written to storage");
  first.executor.close();

  // A shape from a version this build does not know. Reading it as if it were current would put
  // ops of an unknown shape into an outbox that will try to push them.
  storage.items.set(key, JSON.stringify({ version: 99, outbox: [], quarantine: [], hlc: null }));
  const second = session(storage, (error) => errors.push(error));
  assert.equal(second.client.outbox.length, 0);
  second.executor.close();

  // Unreadable is different from absent, and is reported: dropping a queue loses work.
  storage.items.set(key, "{ not json");
  const third = session(storage, (error) => errors.push(error));
  assert.equal(third.client.outbox.length, 0, "a queue that could not be parsed was used anyway");
  assert.equal(errors.length, 1, "an unreadable queue was dropped without saying so");
  third.executor.close();
});

test("storage that refuses a write is reported, and the work stays in memory", () => {
  const storage = new FakeStorage();
  const errors: Error[] = [];
  const first = session(storage, (error) => errors.push(error));

  // A full or refused `localStorage`. There is nothing to be done about it from inside a save, but
  // the work is still in the outbox and a session that lasts will push it.
  storage.failWith = "QuotaExceededError";
  first.client.create(TODOS, rowId("todo-1"), { [fieldName("title")]: "alpha", [fieldName("done")]: false });

  assert.ok(errors.length > 0, "a refused write to the queue was swallowed");
  assert.ok(first.client.outbox.length > 0, "the work was dropped because storage refused it");
  first.executor.close();
});

test("two devices in one browser keep their own queues", () => {
  // One origin, two scopes, so two opens and two databases — the shape a person signed into two
  // accounts in one browser produces.
  const storage = new FakeStorage();
  const mine = session(storage);
  const theirs = session(storage, undefined, scopeId("scope-2"), deviceId("device-2"));

  mine.client.create(TODOS, rowId("todo-1"), { [fieldName("title")]: "mine", [fieldName("done")]: false });
  theirs.client.create(TODOS, rowId("todo-1"), { [fieldName("title")]: "theirs", [fieldName("done")]: false });

  // One key for both would hand each reload the other's ops, to be pushed under an identity that
  // never wrote them.
  assert.equal(storage.items.size, 2, "two devices shared one key");

  const reloaded = session(storage, undefined, scopeId("scope-2"), deviceId("device-2"));
  const titles = reloaded.client.outbox.flatMap((op) =>
    op.kind === "set" && op.field === fieldName("title") ? [op.value] : [],
  );
  assert.deepEqual(titles, ["theirs"], "a device came back holding another device's unsent work");

  mine.executor.close();
  theirs.executor.close();
  reloaded.executor.close();
});
