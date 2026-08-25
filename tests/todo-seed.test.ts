// The rows a visitor arrives to, and the rule that they are written once. Seeding is the one
// thing the demo does behind the visitor's back, so it is held to the shape of the storage it
// reads: a scope shared by every tab of a browser, a device per tab, and a list that stays as the
// visitor left it.
import assert from "node:assert/strict";
import { test } from "vitest";
import { httpTransport, WebStorageClientStore, type FetchLike, type StorageLike } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { createRelayHandler } from "weftdb/server/relay";
import { demoVerifier } from "weftdb-demo-shared/auth";
import { tabIdentity } from "weftdb-demo-shared/identity";
import { schema } from "weftdb-demo-todo/schema";
import { DEMO } from "weftdb-demo-todo/scope";
import { TodoStore } from "weftdb-demo-todo";

/** Storage that behaves like the browser's: string in, string out, nothing shared by accident. */
function memoryStorage(): StorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, String(value)),
    removeItem: (key) => void entries.delete(key),
  };
}

/**
 * One browser against one relay. Local storage is shared, session storage is per tab, so reusing
 * a name is a reload of that tab and a new name is a new device on the same visitor's scope.
 */
function openBrowser(): (name: string) => TodoStore {
  const server = new WeftServer();
  const handler = createRelayHandler({ server, verifier: demoVerifier });
  const fetchLike: FetchLike = async (input, init) =>
    handler(new Request(`http://relay${input.replace(/^\/api/u, "")}`, init));
  const local = memoryStorage();
  const sessions = new Map<string, StorageLike>();

  return (name) => {
    const session = sessions.get(name) ?? memoryStorage();
    sessions.set(name, session);
    const identity = tabIdentity(session, local, { demo: DEMO });
    const persistence = new WebStorageClientStore(local, schema, "weft-demo");
    return new TodoStore({
      identity,
      client: persistence.hydrate(identity.scopeId, identity.deviceId),
      transport: httpTransport({ baseUrl: "/api", token: identity.token, fetch: fetchLike }),
      seedStorage: local,
    });
  };
}

/**
 * Starts a tab, runs it until its outbox is empty, stops it, and hands back the titles it is
 * showing in rank order. `start` puts a sync in flight of its own, and a second call while one is
 * running queues behind it rather than doing the work, so the loop gives that one a turn first.
 */
async function titles(store: TodoStore): Promise<readonly string[]> {
  const stop = store.start();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.sync();
    if (store.status().pending === 0) break;
  }
  stop();
  return store.rows().map((row) => row.title);
}

test("a first visit arrives at a list, with a done row and notes to merge", async () => {
  const open = openBrowser();
  const tab = open("one");
  const list = await titles(tab);

  assert.ok(list.length > 0, "a first visit has nothing to look at");
  assert.ok(list.every((title) => title !== ""));
  const rows = tab.rows();
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

test("a reload does not write the list a second time", async () => {
  const open = openBrowser();
  const first = await titles(open("one"));
  const second = await titles(open("one"));

  assert.deepEqual(second, first);
});

test("a second tab is a second device on one list, not a second copy of it", async () => {
  const open = openBrowser();
  const first = open("one");
  const list = await titles(first);

  const second = open("two");
  assert.deepEqual(await titles(second), list);
  // And nothing the second tab did comes back to the first.
  assert.deepEqual(await titles(first), list);
});

test("emptying the list empties it, on this tab and the next", async () => {
  const open = openBrowser();
  const tab = open("one");
  assert.ok((await titles(tab)).length > 0);
  for (const row of tab.rows()) tab.todos.delete(row.id);
  assert.deepEqual(await titles(tab), []);

  assert.deepEqual(await titles(open("one")), []);
  assert.deepEqual(await titles(open("two")), []);
});
