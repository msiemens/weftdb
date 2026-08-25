// The browser's storage port. A device's durable state is the one thing a local-first
// application cannot afford to lose, and it now has a second `SqlExecutor` under it — so the
// question is not whether SQLite compiled to WebAssembly runs SQL, but whether it answers
// exactly as the port every other suite is written against.
//
// The properties are therefore differential: the same generated history is saved through both
// executors, and any disagreement between them is a defect in the new one.
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { rowId, txnId, type SqlValue } from "weftdb/shared";
import type { WeftClient } from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import {
  openMemorySqliteExecutor,
  WasmSqliteUnavailableError,
  openWebSqliteExecutor,
  type Sqlite3Module,
  type WasmSqliteExecutor,
} from "weftdb/client/wasm-sqlite";
import { openSqliteExecutor, type SqliteExecutor } from "weftdb/server/node-sqlite";
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

// Assigning the real module to the structural type is itself the check that the port describes
// the library it is a port of; nothing below would fail if the two had drifted apart.
const sqlite3: Sqlite3Module = await sqlite3InitModule();

const RUNS = Math.min(SCENARIO_RUNS, 30);

test("a client saved through the wasm executor hydrates exactly as one saved through node:sqlite", () => {
  fc.assert(
    fc.property(worldCommands(40), (commands) => {
      using wasm = wasmStore();
      using native = nativeStore();
      const world = runWorld(commands);
      quiesce(world);
      const client = deviceAt(world, 0).client;

      wasm.store.save(client);
      native.store.save(client);
      const throughWasm = wasm.store.hydrate(client.scopeId, client.deviceId);
      const throughNative = native.store.hydrate(client.scopeId, client.deviceId);

      // Against each other, so a shared misunderstanding of the schema cannot pass, and against
      // the client, so agreeing on the wrong answer cannot either.
      assert.deepEqual(state(throughWasm), state(throughNative), "the two executors disagree about what was stored");
      assert.deepEqual(state(throughWasm), state(client), "the wasm executor lost or changed something");
    }),
    { numRuns: RUNS },
  );
});

test("a value survives the wasm executor whatever is in it", () => {
  // SQL text, NULs, lone surrogates and the rest reach storage as parameters and come back as
  // parameters. A round trip that mangles one is a row that silently changes when a tab is
  // reloaded — and prose fields are exactly where such characters turn up.
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          fc.string({ unit: "binary", maxLength: 40 }),
          fc.oneof(fc.string({ unit: "binary", maxLength: 60 }), fc.constant(null)),
        ),
        {
          minLength: 1,
          maxLength: 8,
        },
      ),
      (entries) => {
        using wasm = wasmStore();
        wasm.executor.run({ sql: "CREATE TABLE probe (key TEXT PRIMARY KEY, value TEXT)", parameters: [] });
        for (const [key, value] of dedupe(entries)) {
          wasm.executor.run({ sql: "INSERT INTO probe (key, value) VALUES (?, ?)", parameters: [key, value] });
        }
        const read = new Map(
          wasm.executor.all<readonly [string, string | null]>({
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

test("every SQL type the port declares comes back as the type it went in as", () => {
  using wasm = wasmStore();
  using native = nativeStore();
  // Integers beyond what a double holds exactly are outside the two ports' common ground:
  // `node:sqlite` refuses to read them unless it was opened for BigInts, while the wasm build
  // hands them back as BigInt. Nothing weft stores goes there — every value on the wire is
  // JSON text — so the contract stops at what both answer alike.
  const values: readonly SqlValue[] = ["text", 0, -1.5, 2 ** 53 - 1, new Uint8Array([0, 1, 255]), null];
  for (const executor of [wasm.executor, native.executor]) {
    executor.run({ sql: "CREATE TABLE probe (position INTEGER PRIMARY KEY, value BLOB)", parameters: [] });
    for (const [position, value] of values.entries()) {
      executor.run({ sql: "INSERT INTO probe (position, value) VALUES (?, ?)", parameters: [position, value] });
    }
  }
  const read = (executor: { all: WasmSqliteExecutor["all"] }): readonly string[] =>
    executor.all<string>({
      sql: "SELECT value FROM probe ORDER BY position",
      parameters: [],
      decode: (row) => describe(row["value"] ?? null),
    });
  assert.deepEqual(read(wasm.executor), read(native.executor));
  assert.deepEqual(read(wasm.executor), values.map(describe));
});

test("a transaction that throws leaves nothing behind, however deeply it was nested", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 0, max: 3 }), (depth, writesPerLevel) => {
      using wasm = wasmStore();
      wasm.executor.run({ sql: "CREATE TABLE probe (value INTEGER)", parameters: [] });
      const write = (): void => {
        for (let index = 0; index < writesPerLevel; index += 1) {
          wasm.executor.run({ sql: "INSERT INTO probe (value) VALUES (?)", parameters: [index] });
        }
      };
      const nest = (level: number): void => {
        wasm.executor.transaction(() => {
          write();
          if (level === depth) throw new Error("rolled back");
          nest(level + 1);
        });
      };

      assert.throws(() => nest(1), /rolled back/u);
      assert.equal(count(wasm.executor), 0, "a rolled back transaction left rows behind");

      // And the connection is still usable afterwards: a rollback that left the database in a
      // transaction would fail the next write instead of this one.
      wasm.executor.transaction(write);
      assert.equal(count(wasm.executor), writesPerLevel);
    }),
    { numRuns: 40 },
  );
});

test("a save that fails part way through leaves the previous state intact", () => {
  // The store writes a save as one transaction. If the tab is closed, the quota is exceeded or
  // a constraint is violated half way through, the device must come back to the state it last
  // completed rather than to half of two of them.
  using wasm = wasmStore();
  const world = runWorld([]);
  const client = deviceAt(world, 0).client;
  client.create(
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
  wasm.store.save(client);
  const before = state(wasm.store.hydrate(client.scopeId, client.deviceId));

  client.update(TASKS, rowId("row-1"), { [TITLE]: "second" }, txnId("txn-2"));
  assert.throws(() =>
    wasm.executor.transaction(() => {
      wasm.store.save(client);
      throw new Error("interrupted");
    }),
  );

  assert.deepEqual(state(wasm.store.hydrate(client.scopeId, client.deviceId)), before);
});

test("persistent storage is refused rather than faked when the browser cannot provide it", async () => {
  // Falling back to memory would be a store that works in every test and loses everything on
  // the first reload, which is the worst possible way for this to fail.
  await assert.rejects(
    () => openWebSqliteExecutor(sqlite3, { path: "weft.sqlite3" }),
    (error: unknown) => error instanceof WasmSqliteUnavailableError,
  );
});

interface Store<Executor> extends Disposable {
  readonly executor: Executor;
  readonly store: SqliteClientStore;
}

function wasmStore(): Store<WasmSqliteExecutor> {
  const executor = openMemorySqliteExecutor(sqlite3);
  const store = new SqliteClientStore(executor, propertySchema);
  store.installSchema();
  return { executor, store, [Symbol.dispose]: () => executor.close() };
}

function nativeStore(): Store<SqliteExecutor> {
  const directory = mkdtempSync(join(tmpdir(), "weft-wasm-"));
  const executor = openSqliteExecutor(join(directory, "weft.sqlite"));
  const store = new SqliteClientStore(executor, propertySchema);
  store.installSchema();
  return {
    executor,
    store,
    [Symbol.dispose]: () => {
      executor.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

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

function count(executor: WasmSqliteExecutor): number {
  return (
    executor.get<number>({
      sql: "SELECT count(*) AS total FROM probe",
      parameters: [],
      decode: (row) => Number(row["total"]),
    }) ?? 0
  );
}

function dedupe(entries: readonly (readonly [string, string | null])[]): ReadonlyMap<string, string | null> {
  return new Map(entries);
}

function compareKeys(left: ArrayLike<unknown>, right: ArrayLike<unknown>): number {
  return String(left[0]) < String(right[0]) ? -1 : String(left[0]) > String(right[0]) ? 1 : 0;
}
