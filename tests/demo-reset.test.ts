import assert from "node:assert/strict";
import { test } from "vitest";
import { tabIdentity } from "weftdb-demo-shared/identity";
import { resetDemoData, type DatabaseRegistry, type EnumerableStorage } from "weftdb-demo-shared/reset";

const DEMO = "todo";

test("a reset leaves the visitor a scope and a device they have never used", async () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const before = tabIdentity(session, local, { demo: DEMO });

  await reset(local, session);

  const after = tabIdentity(session, local, { demo: DEMO });
  assert.notEqual(after.scopeId, before.scopeId, "the visitor came back to the scope they just cleared");
  assert.notEqual(after.deviceId, before.deviceId, "the tab came back as the device that wrote the outbox");
});

test("a reset takes only the keys of the demo it was asked for", async () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const chat = tabIdentity(session, local, { demo: "chat" });
  tabIdentity(session, local, { demo: DEMO });
  // The host page's own storage, which a demo embedded in a docs site shares.
  local.setItem("theme", "dark");

  await reset(local, session);

  assert.equal(tabIdentity(session, local, { demo: "chat" }).scopeId, chat.scopeId, "the other demo was cleared");
  assert.equal(local.getItem("theme"), "dark", "the host page's own key was cleared");
});

test("a reset drops the databases this demo's namespaces named", async () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const identity = tabIdentity(session, local, { demo: DEMO });
  // What the storage worker calls the file for a namespace of `weftdb-demo/<demo>/<device>`, and
  // one from a demo sharing the origin.
  const mine = `weft-${encodeURIComponent(`weftdb-demo/${DEMO}/${identity.deviceId}`)}`;
  const theirs = `weft-${encodeURIComponent("weftdb-demo/chat/tab-1-a")}`;
  const databases = new MemoryDatabases([mine, theirs, "some-other-app"]);

  await reset(local, session, databases);

  assert.deepEqual(databases.deleted, [mine], "the wrong databases were deleted");
});

test("a reset tells the other tabs before it reloads", async () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  tabIdentity(session, local, { demo: DEMO });
  const order: string[] = [];

  await resetDemoData({
    demo: DEMO,
    local,
    session,
    announce: () => order.push("announce"),
    reload: () => order.push("reload"),
  });

  // A tab that reloads before the others are told comes back on a scope they were never given,
  // and the two go on syncing under scopes that have come apart.
  assert.deepEqual(order, ["announce", "reload"], "the other tabs were told after this one had gone");
});

async function reset(
  local: EnumerableStorage,
  session: EnumerableStorage,
  databases?: DatabaseRegistry,
): Promise<void> {
  await resetDemoData({
    demo: DEMO,
    local,
    session,
    ...(databases === undefined ? {} : { databases }),
    announce: () => {},
    reload: () => {},
  });
}

/** `Storage`, in the part `resetDemoData` uses, over a map. */
class MemoryStorage implements EnumerableStorage {
  readonly #entries = new Map<string, string>();

  get length(): number {
    return this.#entries.size;
  }

  key(index: number): string | null {
    return [...this.#entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#entries.set(key, value);
  }

  removeItem(key: string): void {
    this.#entries.delete(key);
  }
}

/** `IDBFactory` in the two members a reset touches, recording what it was asked to delete. */
class MemoryDatabases {
  readonly deleted: string[] = [];
  readonly #names: readonly string[];

  constructor(names: readonly string[]) {
    this.#names = names;
  }

  databases(): Promise<{ name?: string }[]> {
    return Promise.resolve(this.#names.map((name) => ({ name })));
  }

  deleteDatabase(name: string): void {
    this.deleted.push(name);
  }
}
