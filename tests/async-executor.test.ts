// The asynchronous SQL port: what "one transaction at a time" has to mean once a body can `await`.
//
// One connection serves every tab of an origin, so a mutation in one tab and a sync applying a
// batch for another overlap in ordinary use. SQLite answers a second `BEGIN` on an open connection
// with an error, and a write that landed inside somebody else's transaction would be rolled back
// with it having already told its caller it had committed — which is the guarantee an awaited
// mutator is sold on.
import assert from "node:assert/strict";
import { test } from "vitest";
import { asyncSqlExecutor, type AsyncSqlExecutor } from "weftdb/shared";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";

test("a statement from outside waits for the transaction in flight and survives it rolling back", async () => {
  using file = openSqliteExecutor(":memory:");
  const executor = asyncSqlExecutor(file);
  await executor.run({ sql: "CREATE TABLE probe (value TEXT)", parameters: [] });

  // Held open across a turn of the loop, which is what an awaited write does between two of its
  // statements.
  const inside = signal();
  const held = signal();
  const rolling = executor
    .transaction(async (tx) => {
      await tx.run({ sql: "INSERT INTO probe (value) VALUES (?)", parameters: ["rolled back"] });
      inside.fire();
      await held.reached;
      throw new Error("refused");
    })
    .then(
      () => "committed",
      () => "rolled back",
    );

  // Issued with the transaction open and a statement of its own already in it, which is the only
  // arrangement in which the two can collide.
  await inside.reached;
  const outside = executor.run({ sql: "INSERT INTO probe (value) VALUES (?)", parameters: ["outside"] });
  held.fire();

  assert.equal(await rolling, "rolled back");
  await outside;
  assert.deepEqual(await values(executor), ["outside"], "a write from outside was rolled back with somebody else's");
});

test("a read from outside answers only once the transaction in flight has settled", async () => {
  // One connection shows a statement its own open transaction has written, so a read that ran
  // alongside would answer with rows that are not committed and may never be — and a watched
  // statement answering from those pushes ids for a row the file does not hold.
  using file = openSqliteExecutor(":memory:");
  const executor = asyncSqlExecutor(file);
  await executor.run({ sql: "CREATE TABLE probe (value TEXT)", parameters: [] });

  const inside = signal();
  const held = signal();
  const order: string[] = [];
  const writing = executor
    .transaction(async (tx) => {
      await tx.run({ sql: "INSERT INTO probe (value) VALUES (?)", parameters: ["rolled back"] });
      inside.fire();
      await held.reached;
      throw new Error("refused");
    })
    .catch(() => order.push("transaction"));

  await inside.reached;
  const reading = values(executor).then((rows) => {
    order.push("read");
    return rows;
  });
  held.fire();

  await writing;
  assert.deepEqual(await reading, [], "a read answered from a state that was rolled back");
  assert.deepEqual(order, ["transaction", "read"], "a read ran alongside the transaction rather than after it");
});

test("a nested transaction runs inside the one that holds it", async () => {
  // `SqliteClientStore` wraps its writes in a transaction while a caller may already hold an outer
  // one (§5.2). A nested call that took its place in the queue would wait for the transaction its
  // own caller is holding, which is a body that never returns and a connection nothing can reach
  // again.
  using file = openSqliteExecutor(":memory:");
  const executor = asyncSqlExecutor(file);
  await executor.run({ sql: "CREATE TABLE probe (value TEXT)", parameters: [] });

  await assert.rejects(() =>
    executor.transaction(async (outer) => {
      await outer.run({ sql: "INSERT INTO probe (value) VALUES (?)", parameters: ["outer"] });
      await outer.transaction(async (inner) => {
        await inner.run({ sql: "INSERT INTO probe (value) VALUES (?)", parameters: ["inner"] });
      });
      throw new Error("refused");
    }),
  );
  // Both writes are gone, so the inner one was part of the outer transaction and went back with it.
  assert.deepEqual(await values(executor), []);

  // And the connection is still usable: a rollback that left a transaction open would fail the
  // next write instead of this one.
  await executor.run({ sql: "INSERT INTO probe (value) VALUES (?)", parameters: ["after"] });
  assert.deepEqual(await values(executor), ["after"]);
});

/** A point one half of a test waits for and the other half reaches. */
function signal(): { readonly reached: Promise<void>; fire: () => void } {
  let fire = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { reached, fire: () => fire() };
}

async function values(executor: AsyncSqlExecutor): Promise<readonly string[]> {
  return executor.all<string>({
    sql: "SELECT value FROM probe ORDER BY value",
    parameters: [],
    decode: (row) => String(row["value"]),
  });
}
