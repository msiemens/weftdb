// Local durability: what it costs to write the client through to a real SQLite file and to read
// it back at startup. §4.1 makes that file the client's state rather than a cache of it, so the
// write-through happens on every mutation — which is what the per-edit case measures.
import { deviceId } from "weftdb/core";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import { SCOPE, TITLE, TODOS, schema, syncedClient, tempDirectory, todoId, updateTxn } from "../fixtures.ts";
import { consume, duration, repeat, type BenchConfig, type BenchGroup, type CaseResult } from "../harness.ts";

const GROUP = "Persistence";

const DEVICE = deviceId("device-0");

export const persistence: BenchGroup = {
  name: GROUP,
  run: async (config: BenchConfig): Promise<readonly CaseResult[]> => {
    using directory = tempDirectory();
    let file = 0;
    const nextPath = (): string => {
      file += 1;
      return directory.file(`client-${file}.sqlite`);
    };
    return config.persistenceSizes.flatMap((rows) => [
      saveCase(config, rows, nextPath),
      editCase(config, rows, nextPath),
      hydrateCase(config, rows, nextPath),
    ]);
  },
};

/** One full write-through of a scope, which is what a single mutation triggers. */
function saveCase(config: BenchConfig, rows: number, nextPath: () => string): CaseResult {
  const client = syncedClient(rows);
  const samples = repeat(() => {
    using executor = openSqliteExecutor(nextPath());
    const store = new SqliteClientStore(executor, schema);
    store.installSchema();
    // The first save writes into empty tables and has nothing to delete, which is not what a
    // save costs in a running application. What is measured is the one after it.
    store.save(client);
    const start = performance.now();
    store.save(client);
    return performance.now() - start;
  }, config.heavyBudget);
  return duration(
    {
      id: `persist.save.${rows}`,
      group: GROUP,
      label: `Save a ${rows.toLocaleString("en-US")}-row scope to SQLite`,
      note: "the store rewrites the whole scope rather than the rows that changed: one transaction that deletes every row and writes it back, committed with synchronous=FULL",
    },
    samples,
  );
}

/** One edit on a device whose store is attached — the write-through a keystroke pays for. */
function editCase(config: BenchConfig, rows: number, nextPath: () => string): CaseResult {
  const client = syncedClient(rows);
  const row = todoId(0);
  let counter = 0;
  const samples = repeat(() => {
    using executor = openSqliteExecutor(nextPath());
    const store = new SqliteClientStore(executor, schema);
    store.installSchema();
    store.attach(client);
    counter += 1;
    const start = performance.now();
    client.update(TODOS, row, { [TITLE]: `title ${counter}` }, updateTxn(row));
    return performance.now() - start;
  }, config.heavyBudget);
  return duration(
    {
      id: `persist.edit.${rows}`,
      group: GROUP,
      label: `One edit with a ${rows.toLocaleString("en-US")}-row store attached`,
      note: "a single field update, including the durable write it triggers",
    },
    samples,
  );
}

/** Reading the whole client back, as a cold start does. */
function hydrateCase(config: BenchConfig, rows: number, nextPath: () => string): CaseResult {
  const path = nextPath();
  populate(path, rows);
  const samples = repeat(() => {
    using executor = openSqliteExecutor(path);
    const store = new SqliteClientStore(executor, schema);
    const start = performance.now();
    const hydrated = store.hydrate(SCOPE, DEVICE);
    const elapsed = performance.now() - start;
    if (hydrated.rows.size !== rows) throw new Error(`hydrated ${hydrated.rows.size} rows, expected ${rows}`);
    consume(hydrated.outbox.length);
    return elapsed;
  }, config.heavyBudget);
  return duration(
    {
      id: `persist.hydrate.${rows}`,
      group: GROUP,
      label: `Hydrate a ${rows.toLocaleString("en-US")}-row client from SQLite`,
      note: "every row, tombstone and queued op is read back and decoded; the file is warm in the OS cache",
    },
    samples,
  );
}

/** A file holding a device that has synced, so what hydrate reads back is rows rather than outbox. */
function populate(path: string, rows: number): void {
  using executor = openSqliteExecutor(path);
  const store = new SqliteClientStore(executor, schema);
  store.installSchema();
  store.save(syncedClient(rows));
}
