// The browser's storage port. A device's durable state is the one thing a local-first
// application cannot afford to lose, and it has a second SQLite under it — so the question is not
// whether SQLite compiled to WebAssembly runs SQL, but whether it answers exactly as the port every
// other suite is written against.
//
// The properties are therefore differential: the same generated history is saved through both
// executors, and any disagreement between them is a defect in the WebAssembly one.
//
// The build here is the one a browser loads. What Node cannot give it is IndexedDB, so the VFS is
// `MemoryAsyncVFS` — the same author's, the same asynchronous interface, the same suspend inside a
// page fault — and what differs is only where the bytes end up.
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { rowId, txnId } from "weftdb/core";
import { asyncSqlExecutor, type AsyncSqlExecutor, type AsyncSqlTransaction, type SqlValue } from "weftdb/shared";
import type { WeftClient } from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { openWebSqliteExecutor } from "weftdb/client/wasm-sqlite";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import { memorySqlite } from "./storage-fixtures.ts";
import {
  AUTO_DELETE_DAYS,
  BASE_NOTES,
  CONSUMED_AT,
  deviceAt,
  NOTES,
  propertySchema,
  quiesce,
  RANK,
  runWorld,
  SCENARIO_RUNS,
  STATUS,
  TASKS,
  TITLE,
  worldCommands,
} from "./property-model.ts";

const RUNS = Math.min(SCENARIO_RUNS, 30);

test("a client saved through the wasm executor hydrates exactly as one saved through node:sqlite", async () => {
  await fc.assert(
    fc.asyncProperty(worldCommands(40), async (commands) => {
      await using wasm = await wasmStore();
      await using native = await nativeStore();
      const world = await runWorld(commands);
      await quiesce(world);
      const client = deviceAt(world, 0).client;

      await wasm.store.save(client);
      await native.store.save(client);
      const throughWasm = await wasm.store.hydrate(client.scopeId, client.deviceId);
      const throughNative = await native.store.hydrate(client.scopeId, client.deviceId);

      // Against each other, so a shared misunderstanding of the schema cannot pass, and against
      // the client, so agreeing on the wrong answer cannot either.
      assert.deepEqual(state(throughWasm), state(throughNative), "the two executors disagree about what was stored");
      assert.deepEqual(state(throughWasm), state(client), "the wasm executor lost or changed something");
    }),
    { numRuns: RUNS },
  );
});

test("a value survives the wasm executor whatever is in it", async () => {
  // SQL text, lone surrogates and the rest reach storage as parameters and come back as
  // parameters. A round trip that mangles one is a row that silently changes when a tab is
  // reloaded — and prose fields are exactly where such characters turn up.
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.tuple(
          fc.string({ unit: "binary", maxLength: 40 }).filter((text) => !text.includes(NUL)),
          fc.oneof(
            fc.string({ unit: "binary", maxLength: 60 }).filter((text) => !text.includes(NUL)),
            fc.constant(null),
          ),
        ),
        {
          minLength: 1,
          maxLength: 8,
        },
      ),
      async (entries) => {
        await using wasm = await wasmStore();
        await wasm.executor.run({ sql: "CREATE TABLE probe (key TEXT PRIMARY KEY, value TEXT)", parameters: [] });
        for (const [key, value] of dedupe(entries)) {
          await wasm.executor.run({ sql: "INSERT INTO probe (key, value) VALUES (?, ?)", parameters: [key, value] });
        }
        const read = new Map(
          await wasm.executor.all<readonly [string, string | null]>({
            sql: "SELECT key, value FROM probe",
            parameters: [],
            decode: (row) => [String(row["key"]), row["value"] === null ? null : String(row["value"])],
          }),
        );
        assert.deepEqual([...read.entries()].sort(compareKeys), [...dedupe(entries)].sort(compareKeys));
      },
    ),
    { numRuns: 60 },
  );
});

test("a value this build would store truncated is refused rather than stored", async () => {
  // `wa-sqlite` binds text by pointer with no length, so SQLite reads a bound string up to the
  // first NUL. Storing it would put a note back on the next hydrate with everything after that
  // character gone, and nothing anywhere would report it.
  await using wasm = await wasmStore();
  await wasm.executor.run({ sql: "CREATE TABLE probe (value TEXT)", parameters: [] });
  await assert.rejects(
    () => wasm.executor.run({ sql: "INSERT INTO probe (value) VALUES (?)", parameters: [`before${NUL}after`] }),
    /NUL/u,
    "a value that cannot be stored whole was accepted",
  );
  assert.deepEqual(
    await wasm.executor.all<string>({
      sql: "SELECT value FROM probe",
      parameters: [],
      decode: (row) => String(row["value"]),
    }),
    [],
    "the refused value was stored anyway",
  );
});

test("every SQL type the port declares comes back as the type it went in as", async () => {
  await using wasm = await wasmStore();
  await using native = await nativeStore();
  // Integers beyond what a double holds exactly are outside the two ports' common ground:
  // `node:sqlite` refuses to read them unless it was opened for BigInts, while the wasm build
  // hands them back as BigInt. Nothing weft stores goes there — every value on the wire is
  // JSON text — so the contract stops at what both answer alike.
  const values: readonly SqlValue[] = ["text", 0, -1.5, 2 ** 53 - 1, new Uint8Array([0, 1, 255]), null];
  for (const executor of [wasm.executor, native.executor]) {
    await executor.run({ sql: "CREATE TABLE probe (position INTEGER PRIMARY KEY, value BLOB)", parameters: [] });
    for (const [position, value] of values.entries()) {
      await executor.run({ sql: "INSERT INTO probe (position, value) VALUES (?, ?)", parameters: [position, value] });
    }
  }
  const read = (executor: AsyncSqlExecutor): Promise<readonly string[]> =>
    executor.all<string>({
      sql: "SELECT value FROM probe ORDER BY position",
      parameters: [],
      decode: (row) => describe(row["value"] ?? null),
    });
  assert.deepEqual(await read(wasm.executor), await read(native.executor));
  assert.deepEqual(await read(wasm.executor), values.map(describe));
});

test("a transaction that throws leaves nothing behind, however deeply it was nested", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 0, max: 3 }), async (depth, writesPerLevel) => {
      await using wasm = await wasmStore();
      await wasm.executor.run({ sql: "CREATE TABLE probe (value INTEGER)", parameters: [] });
      const write = async (tx: AsyncSqlTransaction): Promise<void> => {
        for (let index = 0; index < writesPerLevel; index += 1) {
          await tx.run({ sql: "INSERT INTO probe (value) VALUES (?)", parameters: [index] });
        }
      };
      const nest = async (tx: AsyncSqlTransaction, level: number): Promise<void> => {
        await tx.transaction(async (inner) => {
          await write(inner);
          if (level === depth) throw new Error("rolled back");
          await nest(inner, level + 1);
        });
      };

      await assert.rejects(() => wasm.executor.transaction((tx) => nest(tx, 1)), /rolled back/u);
      assert.equal(await count(wasm.executor), 0, "a rolled back transaction left rows behind");

      // And the connection is still usable afterwards: a rollback that left the database in a
      // transaction would fail the next write instead of this one.
      await wasm.executor.transaction(write);
      assert.equal(await count(wasm.executor), writesPerLevel);
    }),
    { numRuns: 40 },
  );
});

test("a database is opened with a page cache large enough to hold an ordinary device", async () => {
  // SQLite's own default is 2 MB and a 10,000-row table is around 3.5 MB, so a device of ordinary
  // size would answer a `where` and an `order by` out of storage on every page it touched. It is
  // also what a journal has to fit inside for a VFS to commit a write in one batch.
  await using wasm = await wasmStore();
  assert.equal(await pragma(wasm.executor, "cache_size"), -16_384);

  await using narrow = await wasmStore({ cacheSizeKib: 512 });
  assert.equal(await pragma(narrow.executor, "cache_size"), -512, "the option did not reach the connection");
});

test("a save that fails part way through leaves the previous state intact", async () => {
  // The store writes a save as one transaction. If the tab is closed, the quota is exceeded or
  // a constraint is violated half way through, the device must come back to the state it last
  // completed rather than to half of two of them.
  await using wasm = await wasmStore();
  const world = await runWorld([]);
  const client = deviceAt(world, 0).client;
  await client.create(
    TASKS,
    rowId("row-1"),
    {
      [TITLE]: "first",
      [STATUS]: "open",
      [NOTES]: BASE_NOTES,
      [RANK]: "a0",
      [CONSUMED_AT]: null,
      [AUTO_DELETE_DAYS]: null,
    },
    txnId("txn-1"),
  );
  await wasm.store.save(client);
  const before = state(await wasm.store.hydrate(client.scopeId, client.deviceId));

  await client.update(TASKS, rowId("row-1"), { [TITLE]: "second" }, txnId("txn-2"));
  wasm.refuseAfter(2);
  await assert.rejects(() => wasm.store.save(client), /interrupted/u);

  assert.deepEqual(state(await wasm.store.hydrate(client.scopeId, client.deviceId)), before);
});

interface Store extends AsyncDisposable {
  readonly executor: AsyncSqlExecutor;
  readonly store: SqliteClientStore;
  /** Makes the store's next save throw after this many statements, wherever it has got to. */
  refuseAfter(statements: number): void;
}

/** A database in the build a browser loads, under a VFS of its own so no two of them share a file. */
/** One WebAssembly module for the whole file, because each one is an instance and its heap. */
const build = memorySqlite();

async function wasmStore(options: { readonly cacheSizeKib?: number } = {}): Promise<Store> {
  const opened = await openWebSqliteExecutor(await build(), {
    path: "weft.sqlite3",
    name: `probe-${String(probes++)}`,
    ...options,
  });
  let countdown = Number.POSITIVE_INFINITY;
  const executor: AsyncSqlExecutor = {
    all: (statement) => opened.all(statement),
    get: (statement) => opened.get(statement),
    run: (statement) => opened.run(statement),
    transaction: (body) =>
      opened.transaction((tx) =>
        body({
          all: (statement) => tx.all(statement),
          get: (statement) => tx.get(statement),
          run: async (statement) => {
            countdown -= 1;
            if (countdown < 0) throw new Error("interrupted");
            await tx.run(statement);
          },
          transaction: (nested) => tx.transaction(nested),
        }),
      ),
  };
  const store = new SqliteClientStore(executor, propertySchema);
  await store.installSchema();
  return {
    executor,
    store,
    refuseAfter: (statements) => {
      countdown = statements;
    },
    [Symbol.asyncDispose]: () => opened.close(),
  };
}

async function nativeStore(): Promise<Store> {
  const directory = mkdtempSync(join(tmpdir(), "weft-wasm-"));
  const file = openSqliteExecutor(join(directory, "weft.sqlite"));
  const executor = asyncSqlExecutor(file);
  const store = new SqliteClientStore(executor, propertySchema);
  await store.installSchema();
  return {
    executor,
    store,
    refuseAfter: () => undefined,
    [Symbol.asyncDispose]: async () => {
      file.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

let probes = 0;

/** What the connection says about itself, so a claim about it is read back rather than assumed. */
async function pragma(executor: AsyncSqlExecutor, name: string): Promise<number> {
  const value = await executor.get<number>({
    sql: `PRAGMA ${name}`,
    parameters: [],
    decode: (row) => Number(Object.values(row)[0]),
  });
  return value ?? Number.NaN;
}

/** The character SQLite reads a bound text value up to and no further. */
const NUL = String.fromCodePoint(0);

/** Everything a store is responsible for preserving, in a form two clients compare by. */
function state(client: WeftClient): string {
  return JSON.stringify({
    rows: [...client.rows.entries()]
      .map(([key, row]) => [
        key,
        row.id,
        row.scopeId,
        row.created,
        [...row.fields.entries()].sort(compareKeys),
        [...row.internals.hlc.entries()].sort(compareKeys),
        [...row.internals.diff3Base.entries()].sort(compareKeys),
        row.internals._weft_first_synced_at,
        row.internals._weft_dirty,
      ])
      .sort(compareKeys),
    // Key order is how an op was built, not what it says, and the two stores build theirs from
    // different column orders.
    outbox: client.outbox.map(canonical),
    quarantine: client.quarantine.map(canonical),
    tombstones: [...client.tombstones.entries()].sort(compareKeys),
    lastServerSeq: client.lastServerSeq,
  });
}

function canonical(record: object): readonly (readonly [string, unknown])[] {
  return Object.entries(record).sort(compareKeys);
}

function describe(value: SqlValue): string {
  if (value === null) return "null";
  if (value instanceof Uint8Array) return `blob:${[...value].join(",")}`;
  return `${typeof value}:${String(value)}`;
}

async function count(executor: AsyncSqlExecutor): Promise<number> {
  return (
    (await executor.get<number>({
      sql: "SELECT count(*) AS total FROM probe",
      parameters: [],
      decode: (row) => Number(row["total"]),
    })) ?? 0
  );
}

function dedupe(entries: readonly (readonly [string, string | null])[]): ReadonlyMap<string, string | null> {
  return new Map(entries);
}

function compareKeys(left: ArrayLike<unknown>, right: ArrayLike<unknown>): number {
  return String(left[0]) < String(right[0]) ? -1 : String(left[0]) > String(right[0]) ? 1 : 0;
}
