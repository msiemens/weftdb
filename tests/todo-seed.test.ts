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
    await store.seeded();
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
  await store.seeded();
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

test("three tabs opened together seed the list once between them", async (t) => {
  const browser = openBrowser();
  t.onTestFinished(() => browser.close());
  const stores: TodoStore[] = [];
  // One at a time, because opening a database is where this browser's one wasm module runs its
  // migration and two of those interleaved are two transactions on one connection.
  for (const name of ["one", "two", "three"])
    stores.push(await TodoStore.open(browser.window(name), browser.overrides()));
  t.onTestFinished(async () => {
    for (const store of stores) await store.dispose();
  });
  // Started in one turn, which is what three tabs opened at once are: every one of them reads the
  // mark before any of them has written it.
  const stops = stores.map((store) => store.start());
  t.onTestFinished(() => {
    for (const stop of stops) stop();
  });
  await Promise.all(stores.map((store) => store.seeded()));
  // Twice: the first pass sends what each tab wrote, the second is what pulls the others' work.
  for (const pass of [0, 1]) for (const store of stores) await drain(store, `pass ${pass} never drained`);

  for (const store of stores) {
    const shown = store.rows().map((row) => row.title);
    assert.ok(shown.length > 0, "a tab that opened with the others has nothing to look at");
    assert.deepEqual([...new Set(shown)], shown, "the scope was seeded more than once");
  }
});

test("a tab that arrives to a scope with rows in it seeds nothing", async (t) => {
  const browser = openBrowser();
  t.onTestFinished(() => browser.close());
  const list = await titles(browser, "one");
  assert.ok(list.length > 0);

  // The state of a browser whose demo storage has been cleared while the relay kept the rows: the
  // list exists, and nothing on this machine remembers writing it.
  const scope = browser.local.getItem(`weftdb-demo/${DEMO}/scope`);
  browser.local.removeItem(`weftdb-demo/${DEMO}/seeded/${String(scope)}`);

  assert.deepEqual(await titles(browser, "two"), list);
});

test("emptying the list empties it, on this tab and the next", async (t) => {
  const browser = openBrowser();
  t.onTestFinished(() => browser.close());
  const store = await TodoStore.open(browser.window("one"), browser.overrides());
  const stop = store.start();
  await store.seeded();
  await drain(store);
  assert.ok(store.rows().length > 0);

  for (const row of store.rows()) await store.todos.delete(row.id);
  await drain(store);
  assert.deepEqual(store.rows(), []);
  stop();
  await store.dispose();

  assert.deepEqual(await titles(browser, "one"), []);
  assert.deepEqual(await titles(browser, "two"), []);
});
