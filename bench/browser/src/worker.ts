// The dedicated worker the whole question is about. A synchronous `SqlExecutor` over OPFS exists
// only here — `installOpfsSAHPoolVfs` takes exclusive sync access handles, which no other context
// can hold — so every durable number in this harness is measured inside this file and only the
// resulting samples cross back to the page.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { WeftClient } from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import {
  openWebSqliteExecutor,
  WasmSqliteUnavailableError,
  type Sqlite3Module,
  type WasmSqliteExecutor,
} from "weftdb/client/wasm-sqlite";
import {
  DEVICE,
  SCOPE,
  TITLE,
  TODOS,
  deltaRowOf,
  deltaRows,
  schema,
  syncedClient,
  todoId,
  updateTxn,
} from "./fixtures.ts";
import type { BenchRequest, BenchResponse, DeltaRow, InitValue, SampleBudget, SamplesValue } from "./protocol.ts";

/**
 * The worker's global, named rather than inferred. The page's TypeScript configuration carries the
 * DOM library rather than the worker one, where `self` is a `Window` and `postMessage` wants an
 * origin it has no use for here.
 */
interface WorkerScope {
  postMessage(message: BenchResponse): void;
  addEventListener(type: "message", listener: (event: MessageEvent<BenchRequest>) => void): void;
}

/** The part of the SAH pool handle this needs beyond opening a database: housekeeping. */
interface PoolUtil {
  unlink(filename: string): boolean;
  getFileNames(): readonly string[];
  reserveMinimumCapacity(minimum: number): Promise<number>;
}

const scope = globalThis as unknown as WorkerScope;

/** One pool of OPFS files for the harness, so nothing it writes lands among an application's. */
const POOL = "weftdb-bench";
const PREFIX = "/weft-bench-";
/** Three databases open at once, each with room for its journal, and slack for the pool's own. */
const CAPACITY = 16;

let sqlite3: Sqlite3Module | undefined;
let pool: PoolUtil | undefined;

interface Prepared {
  readonly size: number;
  readonly path: string;
  readonly executor: WasmSqliteExecutor;
  readonly store: SqliteClientStore;
  readonly client: WeftClient;
}

const prepared = new Map<number, Prepared>();
/** Prebuilt, because a round trip is being timed for its clone rather than for its allocation. */
const payloads = new Map<number, readonly DeltaRow[]>();
/** Distinct titles, so no update is ever a no-op the store could in principle skip. */
let edits = 0;

scope.addEventListener("message", (event: MessageEvent<BenchRequest>) => {
  void answer(event.data);
});

async function answer(request: BenchRequest): Promise<void> {
  try {
    scope.postMessage({ id: request.id, ok: true, value: await execute(request) });
  } catch (error) {
    scope.postMessage({ id: request.id, ok: false, error: describe(error) });
  }
}

async function execute(request: BenchRequest): Promise<unknown> {
  switch (request.type) {
    case "init":
      return await init();
    case "ping":
      return null;
    case "delta":
      return { rows: payload(request.rows) };
    case "prepare":
      await prepare(request.size);
      return null;
    case "commit":
      return commit(request.size, request.budget);
    case "hydrate":
      return hydrate(request.size, request.budget);
    case "edit":
      return { rows: [edit(request.size)] };
    case "dispose":
      dispose();
      return null;
  }
}

/**
 * Boots SQLite and installs the pool once, so the page can say up front whether OPFS was reachable
 * instead of discovering it four cases in. A build without the pool, or an origin without OPFS, is
 * reported rather than thrown: the round-trip numbers are still worth having on such a browser.
 */
async function init(): Promise<InitValue> {
  try {
    await openPool();
    return { opfs: true, detail: `OPFS sync access handle pool "${POOL}" installed` };
  } catch (error) {
    return { opfs: false, detail: describe(error) };
  }
}

async function openPool(): Promise<{ readonly sqlite3: Sqlite3Module; readonly pool: PoolUtil }> {
  if (sqlite3 === undefined) sqlite3 = await sqlite3InitModule();
  const runtime: Sqlite3Module = sqlite3;
  const install = runtime.installOpfsSAHPoolVfs?.bind(runtime);
  if (install === undefined) {
    throw new WasmSqliteUnavailableError(
      "this SQLite build has no OPFS sync access handle pool, so it cannot store anything synchronously",
    );
  }
  if (pool === undefined) {
    // `Sqlite3Module` deliberately describes only the part of the pool handle weftdb itself uses,
    // which is the constructor; the housekeeping this harness needs is on the same object.
    const util = (await install({ name: POOL })) as unknown as PoolUtil;
    await util.reserveMinimumCapacity(CAPACITY);
    // A previous run's files would otherwise be reopened and grown, and a 10,000-row number
    // measured against 20,000 rows is not the number anybody asked for.
    for (const name of util.getFileNames()) if (name.startsWith(PREFIX)) util.unlink(name);
    pool = util;
  }
  return { sqlite3: runtime, pool };
}

/**
 * A database of `size` rows with its client attached, left open for the cases that follow. The
 * attach performs the first, whole-scope save; every save measured afterwards is the incremental
 * one a keystroke actually pays for.
 */
async function prepare(size: number): Promise<void> {
  const existing = prepared.get(size);
  if (existing !== undefined) return;
  const opened = await openPool();
  const path = `${PREFIX}${size}.db`;
  // Unlinked rather than reused: a file left by an earlier click of "Run all" already holds this
  // scope, and hydrating it would report a size nobody asked for.
  opened.pool.unlink(path);
  const executor = await openWebSqliteExecutor(opened.sqlite3, { path, poolName: POOL });
  const store = new SqliteClientStore(executor, schema);
  store.installSchema();
  const client = syncedClient(size);
  store.attach(client);
  prepared.set(size, { size, path, executor, store, client });
}

function openedAt(size: number): Prepared {
  const entry = prepared.get(size);
  if (entry === undefined) throw new Error(`no database prepared at ${size} rows`);
  return entry;
}

/**
 * The number the design decision turns on: one `client.update()` with the store attached, which is
 * a field write, a rewrite of the row, a rewrite of the one queued op, the sync-state upsert, and
 * the commit that makes all of it durable.
 *
 * Every sample writes the same field of the same row, which keeps the outbox at one op — an unsent
 * write to a field is superseded rather than followed — so what grows across samples is nothing.
 */
function commit(size: number, budget: SampleBudget): SamplesValue {
  const entry = openedAt(size);
  const row = todoId(0);
  const once = (): number => {
    edits += 1;
    const start = performance.now();
    entry.client.update(TODOS, row, { [TITLE]: `title ${edits}` }, updateTxn(row));
    return performance.now() - start;
  };
  for (let index = 0; index < budget.warmup; index += 1) once();
  const samples: number[] = [];
  for (let index = 0; index < budget.iterations; index += 1) samples.push(once());
  return { samples };
}

/**
 * Startup: every row, tombstone and queued op read back and decoded. The store is fresh each time
 * because a cold start has no store, which means the schema check runs inside the clock — as it
 * does in the application, and as it does in `bench/cases/persistence.ts`.
 */
function hydrate(size: number, budget: SampleBudget): SamplesValue {
  const entry = openedAt(size);
  const once = (): number => {
    const store = new SqliteClientStore(entry.executor, schema);
    const start = performance.now();
    const client = store.hydrate(SCOPE, DEVICE);
    const elapsed = performance.now() - start;
    if (client.rows.size !== size) throw new Error(`hydrated ${client.rows.size} rows, expected ${size}`);
    return elapsed;
  };
  for (let index = 0; index < budget.warmup; index += 1) once();
  const samples: number[] = [];
  for (let index = 0; index < budget.iterations; index += 1) samples.push(once());
  return { samples };
}

/** One real edit, answered with the row it produced — the echo a mirror design would send back. */
function edit(size: number): DeltaRow {
  const entry = openedAt(size);
  const row = todoId(0);
  edits += 1;
  entry.client.update(TODOS, row, { [TITLE]: `title ${edits}` }, updateTxn(row));
  return deltaRowOf(entry.client, row);
}

function payload(rows: number): readonly DeltaRow[] {
  const existing = payloads.get(rows);
  if (existing !== undefined) return existing;
  const built = deltaRows(rows);
  payloads.set(rows, built);
  return built;
}

/** Closes what is open and takes the files back out, so a second run starts where the first did. */
function dispose(): void {
  for (const entry of prepared.values()) {
    entry.executor.close();
    pool?.unlink(entry.path);
  }
  prepared.clear();
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
