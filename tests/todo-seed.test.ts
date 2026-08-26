// The rows a visitor arrives to, and the rule that they are written once. Seeding is the one
// thing the demo does behind the visitor's back, so it is held to the shape of the storage it
// reads: a scope shared by every tab of a browser, a device per tab, and a list that stays as the
// visitor left it.
import assert from "node:assert/strict";
import { test } from "vitest";
import { TodoStore } from "weftdb-demo-todo";
import { schema } from "weftdb-demo-todo/schema";
import { DEMO } from "weftdb-demo-todo/scope";
import { DemoBrowser, drain } from "./demo-fixtures.ts";

/**
 * One browser against one relay. Local storage is shared, session storage is per tab, so reusing
 * a name is a reload of that tab and a new name is a new device on the same visitor's scope.
 */
function openBrowser(): DemoBrowser {
  return new DemoBrowser({ schema, demo: DEMO });
}

/**
 * Opens a tab, runs it until its outbox is empty, closes it, and hands back the titles it was
 * showing in rank order.
 *
 * Every write crosses a port twice — the mutator posts and the worker echoes — so what a list holds
 * a tick after `start` is not what it holds once the echoes have landed. Draining the outbox is the
 * one condition that covers both: nothing is pending until every mutation has been applied in the
 * worker, and nothing is unsent once the relay has taken them.
 */
async function titles(browser: DemoBrowser, name: string): Promise<readonly string[]> {
  const store = await TodoStore.open(browser.window(name), browser.overrides());
  const stop = store.start();
  try {
    await drain(store);
    return store.rows().map((row) => row.title);
  } finally {
    stop();
    await store.dispose();
  }
}

test("a first visit arrives at a list, with a done row and notes to merge", async (t) => {
  const browser = openBrowser();
  t.onTestFinished(() => browser.close());
  const store = await TodoStore.open(browser.window("one"), browser.overrides());
  t.onTestFinished(() => store.dispose());
  const stop = store.start();
  t.onTestFinished(stop);
  await drain(store);

  const rows = store.rows();
  assert.ok(rows.length > 0, "a first visit has nothing to look at");
  assert.ok(rows.every((row) => row.title !== ""));
  assert.ok(
    rows.some((row) => row.done),
    "no row shows what a done row looks like",
  );
  assert.ok(
    rows.some((row) => row.notes.includes("\n")),
    "no row has notes for diff3 to merge",
  );
  // Written through the ordinary mutators, so the relay has them and the history says who wrote
  // them.
  assert.equal(rows.filter((row) => row.dirty).length, 0);
});

test("a reload does not write the list a second time", async (t) => {
  const browser = openBrowser();
  t.onTestFinished(() => browser.close());
  const first = await titles(browser, "one");
  const second = await titles(browser, "one");

  assert.deepEqual(second, first);
});

test("a second tab is a second device on one list, not a second copy of it", async (t) => {
  const browser = openBrowser();
  t.onTestFinished(() => browser.close());
  const list = await titles(browser, "one");

  assert.deepEqual(await titles(browser, "two"), list);
  // And nothing the second tab did comes back to the first.
  assert.deepEqual(await titles(browser, "one"), list);
});

test("emptying the list empties it, on this tab and the next", async (t) => {
  const browser = openBrowser();
  t.onTestFinished(() => browser.close());
  const store = await TodoStore.open(browser.window("one"), browser.overrides());
  const stop = store.start();
  await drain(store);
  assert.ok(store.rows().length > 0);

  for (const row of store.rows()) store.todos.delete(row.id);
  await drain(store);
  assert.deepEqual(store.rows(), []);
  stop();
  await store.dispose();

  assert.deepEqual(await titles(browser, "one"), []);
  assert.deepEqual(await titles(browser, "two"), []);
});
