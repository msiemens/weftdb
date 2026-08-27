// Putting a demo back to what a first-time visitor sees.
//
// A visitor is a scope and a tab is a device, and `identity.ts` mints both from storage the first
// time something asks for one. Clearing what this demo has written is therefore the whole of the
// reset. The next load mints a new scope, and the relay holds no records under a scope nothing has
// pushed to yet.
//
// The relay is left running. It keeps its records in memory (`relay-worker.ts`) under the scope
// just retired, which nothing can name again, so they go when the worker does.
//
// Every tab of the origin is told, because one scope serves all of them. A tab left on the old
// scope goes on syncing it with any other tab that has not reset, and a demo about two tabs
// agreeing then shows two that do not.
import type { StorageLike } from "weftdb/client";
import { demoKeyPrefix } from "./identity.ts";

/** The part of `Storage` a reset needs. What is in it, and taking things out of it. */
export interface EnumerableStorage extends StorageLike {
  readonly length: number;
  key(index: number): string | null;
}

/** The part of `IDBFactory` a reset uses. What this origin holds, and dropping one. */
export interface DatabaseRegistry {
  databases(): Promise<{ name?: string | undefined }[]>;
  deleteDatabase(name: string): unknown;
}

export interface DemoResetOptions {
  /** Slug of the demo, as `tabIdentity` takes it. */
  readonly demo: string;
  readonly local: EnumerableStorage;
  readonly session: EnumerableStorage;
  /** This origin's databases. Left out keeps the retired ones. */
  readonly databases?: DatabaseRegistry | undefined;
  /** How the other tabs hear. Defaults to the channel `watchDemoReset` listens on. */
  readonly announce?: (() => void) | undefined;
  readonly reload?: (() => void) | undefined;
}

/** Clears this demo, tells the other tabs, and reloads. */
export async function resetDemoData(options: DemoResetOptions): Promise<void> {
  const prefix = demoKeyPrefix(options.demo);
  forget(options.local, prefix);
  forget(options.session, prefix);
  await dropDatabases(options.databases, prefix);
  const announce =
    options.announce ??
    ((): void => {
      const channel = new BroadcastChannel(channelName(options.demo));
      channel.postMessage("reset");
      channel.close();
    });
  const reload =
    options.reload ??
    ((): void => {
      globalThis.location.reload();
    });
  announce();
  reload();
}

/**
 * Runs `onReset` when another tab of this origin resets the demo. The returned function stops it.
 *
 * A `BroadcastChannel` does not deliver to the context that posted, so the tab doing the resetting
 * hears nothing here and reloads on its own.
 */
export function watchDemoReset(demo: string, onReset: () => void): () => void {
  const channel = new BroadcastChannel(channelName(demo));
  const listener = (): void => {
    onReset();
  };
  channel.addEventListener("message", listener);
  return () => {
    channel.removeEventListener("message", listener);
    channel.close();
  };
}

function channelName(demo: string): string {
  return `${demoKeyPrefix(demo)}reset`;
}

/**
 * Takes every key under `prefix` out of one storage.
 *
 * The keys are collected before any of them is removed. `key(index)` walks a list that shifts under
 * every removal, so removing inside the walk steps over whichever key moved into the vacated index.
 */
function forget(storage: EnumerableStorage, prefix: string): void {
  const held: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(prefix)) held.push(key);
  }
  for (const key of held) storage.removeItem(key);
}

/**
 * Removes the databases this demo's namespaces named.
 *
 * A tab's namespace is the prefix and its device id (`store.ts`), and the storage worker builds a
 * database name out of that namespace, escaping what it has to. Matching the name against both
 * forms of the prefix leaves the escaping the worker's business.
 *
 * `indexedDB.databases()` is the only way to learn the names and Firefox gained it in 126, so an
 * older browser keeps its retired databases and still shows the visitor a demo with nothing in it.
 *
 * A delete waits for every connection to that database to close, and the reload below is what
 * closes this tab's. Driven over two tabs in Chrome, the retired database is gone by the time both
 * reloaded pages have settled.
 */
async function dropDatabases(databases: DatabaseRegistry | undefined, prefix: string): Promise<void> {
  if (databases?.databases === undefined) return;
  const escaped = encodeURIComponent(prefix);
  for (const { name } of await databases.databases()) {
    if (name === undefined) continue;
    if (!name.includes(prefix) && !name.includes(escaped)) continue;
    databases.deleteDatabase(name);
  }
}
