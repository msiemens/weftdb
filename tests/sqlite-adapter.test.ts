import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import { compareHlc, deviceId, fieldName, rowId, scopeId, tableName, txnId, type HlcString } from "weftdb/core";
import {
  asyncSqlExecutor,
  type AsyncSqlExecutor,
  type AsyncSqlTransaction,
  type SqlParameters,
  type SqlRow,
  type SqlStatement,
  type SqlValue,
} from "weftdb/shared";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { inProcessTransport, WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { SqliteWeftServer } from "weftdb/server/sqlite";
import { openSqliteExecutor, type SqliteExecutor } from "weftdb/server/node-sqlite";

const schema = defineSchema({
  tasks: S.collection({
    title: S.string(),
    notes: S.string({ nullable: true, merge: "diff3" }),
  }),
});
const SQLITE_PROPERTY_RUNS = Number(process.env["WEFT_SQLITE_PROPERTY_RUNS"] ?? 25);
const tokenArb = fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}$/u);

test("the generated SQL runs on a SQLite that is not the Node binding", async () => {
  // The one test that pays for the `sqlite3` binary. Everything else here runs on
  // `openSqliteExecutor`, which is what a device and a relay actually use. Running only on that
  // would leave the generated DDL and statements free to depend on whatever `node:sqlite` happens
  // to accept, and nothing would say so until someone ported the store. This installs the schema,
  // writes a row through the store, and reads it back with a separate `sqlite3` process per
  // statement.
  using db = TempCliSqlite.open();
  const store = new SqliteClientStore(db.executor, schema);

  const client = new WeftClient(scopeId("sqlite-portable"), deviceId("device"), schema, () => 1_000);
  await client.create(tableName("tasks"), rowId("task-1"), { [fieldName("title")]: "portable" }, txnId("txn"));
  await store.save(client);

  const hydrated = await store.hydrate(scopeId("sqlite-portable"), deviceId("device"));
  assert.equal(hydrated.getRow(tableName("tasks"), rowId("task-1"))?.fields.get(fieldName("title")), "portable");
  assert.deepEqual(
    (await tableColumns(db.executor, "tasks")).includes("_weft_base_notes"),
    true,
    "the generated DDL did not survive stock sqlite3",
  );
});

test("client SQLite adapter installs itself, persists, and hydrates rows and outbox", async () => {
  using db = TempSqlite.open();
  const store = new SqliteClientStore(db.executor, schema);

  const client = new WeftClient(scopeId("sqlite-client"), deviceId("device"), schema, () => 1_000);
  await client.create(tableName("tasks"), rowId("task-1"), { [fieldName("title")]: "persisted" }, txnId("txn"));
  await store.save(client);

  const hydrated = await store.hydrate(scopeId("sqlite-client"), deviceId("device"));
  assert.equal(hydrated.getRow(tableName("tasks"), rowId("task-1"))?.fields.get(fieldName("title")), "persisted");
  assert.equal(hydrated.outbox.length, client.outbox.length);
});

test("client SQLite adapter adds missing columns for a newer additive schema", async () => {
  using db = TempSqlite.open();
  const firstSchema = defineSchema(
    {
      tasks: S.collection({
        title: S.string(),
      }),
    },
    1,
  );
  const nextSchema = defineSchema(
    {
      tasks: S.collection({
        title: S.string(),
        notes: S.string({ nullable: true, merge: "diff3" }),
        done: S.boolean(),
        status: S.enum(["open", "done"]),
      }),
    },
    2,
  );

  const firstStore = new SqliteClientStore(db.executor, firstSchema);
  const client = new WeftClient(scopeId("sqlite-upgrade"), deviceId("device"), firstSchema, () => 1_000);
  await client.create(tableName("tasks"), rowId("task-1"), { [fieldName("title")]: "persisted" }, txnId("txn"));
  await firstStore.save(client);

  const nextStore = new SqliteClientStore(db.executor, nextSchema);
  const hydrated = await nextStore.hydrate(scopeId("sqlite-upgrade"), deviceId("device"));
  const row = hydrated.getRow(tableName("tasks"), rowId("task-1"));

  assert.equal(row?.fields.get(fieldName("title")), "persisted");
  assert.equal(row?.fields.get(fieldName("done")), false);
  assert.equal(row?.fields.get(fieldName("status")), "open");
  assert.equal(row?.fields.has(fieldName("notes")), false);
  assert.deepEqual(
    (await tableColumns(db.executor, "tasks")).filter((name) => name.startsWith("_weft_base_")),
    ["_weft_base_notes"],
  );
});

test("server SQLite adapter persists scope, device, and snapshot rows", async () => {
  using db = TempSqlite.open();
  const server = new SqliteWeftServer(db.connection, () => 1_000);
  const client = new WeftClient(scopeId("sqlite-server"), deviceId("device"), schema, () => 1_000);
  await client.create(tableName("tasks"), rowId("task-1"), { [fieldName("title")]: "server" }, txnId("txn"));
  await client.syncWith(inProcessTransport(server), schemaHash(schema));

  const reloaded = new SqliteWeftServer(db.connection, () => 2_000);
  const snapshot = reloaded.snapshotInReadTransaction(scopeId("sqlite-server"));
  assert.equal(snapshot.rows.length, 1);
  assert.equal(
    snapshot.fields.some((field) => field.field === fieldName("title") && field.value === "server"),
    true,
  );
  assert.equal(reloaded.devices.size, 1);
});

test("client SQLite hydrate only restores state for the requested scope", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(tokenArb, { minLength: 2, maxLength: 4 }),
      fc.uniqueArray(fc.tuple(tokenArb, tokenArb), {
        minLength: 1,
        maxLength: 3,
        selector: ([rowToken]) => rowToken,
      }),
      fc.integer({ min: 0, max: 3 }),
      async (scopeTokens, rowEntries, targetIndex) => {
        using db = TempSqlite.open();
        const tasks = tableName("tasks");
        const title = fieldName("title");
        const targetScope = scopeTokens[targetIndex % scopeTokens.length] ?? scopeTokens[0] ?? "target";

        for (const scope of scopeTokens) {
          const server = new WeftServer(() => 1_000);
          const store = new SqliteClientStore(db.executor, schema);
          const client = await store.attach(new WeftClient(scopeId(scope), deviceId("device"), schema, () => 1_000));
          const synced = rowId(`${scope}-synced`);
          await client.create(tasks, synced, { [title]: `${scope}-synced` }, txnId(`create-synced-${scope}`));
          await client.syncWith(inProcessTransport(server), schemaHash(schema));
          await client.update(tasks, synced, { [fieldName("created")]: `${scope}-bad` }, txnId(`bad-${scope}`));
          await client.syncWith(inProcessTransport(server), schemaHash(schema));

          for (const [rowToken, titleToken] of rowEntries) {
            await client.create(
              tasks,
              rowId(`${scope}-${rowToken}`),
              { [title]: `${scope}-${titleToken}` },
              txnId(`create-${scope}-${rowToken}`),
            );
          }
          const deleted = rowId(`${scope}-deleted`);
          await client.create(tasks, deleted, { [title]: `${scope}-deleted` }, txnId(`create-deleted-${scope}`));
          await client.delete(tasks, deleted, txnId(`delete-${scope}`));
        }

        const hydrated = await new SqliteClientStore(db.executor, schema).hydrate(
          scopeId(targetScope),
          deviceId("device"),
        );
        assert.deepEqual(
          [...new Set([...hydrated.rows.values()].map((record) => record.scopeId))],
          [scopeId(targetScope)],
          "rows from another scope were hydrated into this client",
        );
        assert.deepEqual(
          [...new Set(hydrated.outbox.map((op) => op.scopeId))],
          [scopeId(targetScope)],
          "outbox ops from another scope were hydrated into this client",
        );
        assert.deepEqual(
          [...new Set([...hydrated.tombstones.values()].map((record) => record.scopeId))],
          [scopeId(targetScope)],
          "tombstones from another scope were hydrated into this client",
        );
        assert.deepEqual(
          [...new Set(hydrated.quarantine.map((op) => op.scopeId))],
          [scopeId(targetScope)],
          "quarantined ops from another scope were hydrated into this client",
        );
        for (const [rowToken, titleToken] of rowEntries) {
          assert.equal(
            hydrated.getRow(tasks, rowId(`${targetScope}-${rowToken}`))?.fields.get(title),
            `${targetScope}-${titleToken}`,
            "the requested scope's own row was not restored",
          );
        }
      },
    ),
    { numRuns: SQLITE_PROPERTY_RUNS },
  );
});

test("client SQLite hydrate filters framework tables for the requested scope", async () => {
  using db = TempSqlite.open();
  const store = new SqliteClientStore(db.executor, schema);
  await store.installSchema();
  for (const [scope, title] of [
    ["target", "keep"],
    ["other", "drop"],
  ] as const) {
    const client = new WeftClient(scopeId(scope), deviceId("device"), schema, () => 1_000);
    await client.create(
      tableName("tasks"),
      rowId(`task-${scope}`),
      { [fieldName("title")]: title },
      txnId(`create-${scope}`),
    );
    // Remove the row state so this assertion isolates framework tables, because outbox,
    // quarantine, tombstones and sync_state must still be scoped even when no domain rows are
    // involved.
    client.rows.clear();
    client.drainTouchedRows();
    await store.save(client);
  }

  const hydrated = await store.hydrate(scopeId("target"), deviceId("device"));
  assert.deepEqual(
    [...new Set(hydrated.outbox.map((op) => op.scopeId))],
    [scopeId("target")],
    "outbox ops from another scope were hydrated into this client",
  );
});

test("client SQLite storage keeps the same row id distinct across scopes", async () => {
  using db = TempSqlite.open();
  for (const [scope, title] of [
    ["scope-a", "from a"],
    ["scope-b", "from b"],
  ] as const) {
    const client = new WeftClient(scopeId(scope), deviceId("device"), schema, () => 1_000);
    await client.create(tableName("tasks"), rowId("shared"), { [fieldName("title")]: title }, txnId(`create-${scope}`));
    await new SqliteClientStore(db.executor, schema).save(client);
  }

  for (const [scope, title] of [
    ["scope-a", "from a"],
    ["scope-b", "from b"],
  ] as const) {
    const hydrated = await new SqliteClientStore(db.executor, schema).hydrate(scopeId(scope), deviceId("device"));
    assert.equal(hydrated.getRow(tableName("tasks"), rowId("shared"))?.fields.get(fieldName("title")), title);
  }
});

test("client SQLite hydrate preserves a pending resync requirement", async () => {
  using db = TempSqlite.open();
  const store = new SqliteClientStore(db.executor, schema);
  const client = new WeftClient(scopeId("resync-scope"), deviceId("device"), schema, () => 1_000);
  await client.create(tableName("tasks"), rowId("task-1"), { [fieldName("title")]: "local" }, txnId("create"));
  client.resyncRequired = true;
  await store.save(client);

  const hydrated = await new SqliteClientStore(db.executor, schema).hydrate(
    scopeId("resync-scope"),
    deviceId("device"),
  );
  assert.equal(hydrated.resyncRequired, true, "a restart dropped the pending snapshot requirement");
});

test("client SQLite hydrate preserves the clock across a reload", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (edits) => {
      using db = TempSqlite.open();
      const store = new SqliteClientStore(db.executor, schema);
      const tasks = tableName("tasks");
      const title = fieldName("title");
      const row = rowId("clocked");
      const frozen = 1_000;
      const client = await store.attach(
        new WeftClient(scopeId("clock-scope"), deviceId("device"), schema, () => frozen),
      );
      await client.create(tasks, row, { [title]: "initial" }, txnId("create"));
      for (let index = 0; index < edits; index += 1) {
        await client.update(tasks, row, { [title]: `before-${index}` }, txnId(`before-${index}`));
      }
      const highest = client.outbox.map((op) => op.hlc).reduce(maxHlc);

      const originalNow = Date.now;
      Date.now = () => frozen;
      try {
        const hydrated = await store.hydrate(scopeId("clock-scope"), deviceId("device"));
        await hydrated.update(tasks, row, { [title]: "after reload" }, txnId("after"));
        const afterReload = hydrated.outbox.at(-1)?.hlc;
        assert.ok(afterReload !== undefined, "the post-reload edit was not queued");
        assert.equal(
          compareHlc(afterReload, highest) > 0,
          true,
          "a post-reload edit did not come after persisted local work",
        );
      } finally {
        Date.now = originalNow;
      }
    }),
    { numRuns: SQLITE_PROPERTY_RUNS },
  );
});

function maxHlc(left: HlcString, right: HlcString): HlcString {
  return compareHlc(left, right) >= 0 ? left : right;
}

/**
 * A throwaway database on the binding a deployed device and server actually run.
 *
 * Both ports run over the one connection. The server takes the synchronous executor, and the
 * client store takes the asynchronous one. A second `asyncSqlExecutor` over the same connection
 * would hold a second transaction queue, and the two would issue overlapping `BEGIN`s.
 */
class TempSqlite implements Disposable {
  readonly dir: string;
  readonly path: string;
  readonly connection: SqliteExecutor;
  readonly executor: AsyncSqlExecutor;

  private constructor(dir: string) {
    this.dir = dir;
    this.path = join(dir, "weft.sqlite");
    this.connection = openSqliteExecutor(this.path);
    this.executor = asyncSqlExecutor(this.connection);
  }

  static open(): TempSqlite {
    return new TempSqlite(mkdtempSync(join(tmpdir(), "weftdb-")));
  }

  [Symbol.dispose](): void {
    this.connection.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The same, over the `sqlite3` command line. */
class TempCliSqlite implements Disposable {
  readonly dir: string;
  readonly path: string;
  readonly executor: SqliteCliExecutor;

  private constructor(dir: string) {
    this.dir = dir;
    this.path = join(dir, "weft.sqlite");
    this.executor = new SqliteCliExecutor(this.path);
  }

  static open(): TempCliSqlite {
    return new TempCliSqlite(mkdtempSync(join(tmpdir(), "weftdb-cli-")));
  }

  [Symbol.dispose](): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * `AsyncSqlExecutor` over the `sqlite3` binary, one process per statement.
 *
 * It exists to run the generated SQL through a SQLite that is not `node:sqlite`, which is the
 * only way to tell a portable statement from one the Node binding happens to accept. It is not a
 * general substitute for `openSqliteExecutor`. A `BEGIN` in one process does not reach the next,
 * so `transaction` has no transaction to give, and the method below reports that truthfully.
 * Anything whose meaning depends on atomicity, isolation or rollback belongs on `node:sqlite`.
 */
class SqliteCliExecutor implements AsyncSqlExecutor {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async all<Decoded>(statement: SqlStatement<Decoded>): Promise<readonly Decoded[]> {
    const output = execFileSync("sqlite3", ["-json", this.path, bind(statement.sql, statement.parameters)], {
      encoding: "utf8",
    });
    const rows = parseRows(output);
    return rows.map(statement.decode);
  }

  async get<Decoded>(statement: SqlStatement<Decoded>): Promise<Decoded | undefined> {
    return (await this.all(statement))[0];
  }

  async run(statement: { readonly sql: string; readonly parameters: SqlParameters }): Promise<void> {
    execFileSync("sqlite3", [this.path, bind(statement.sql, statement.parameters)]);
  }

  async transaction<Result>(body: (tx: AsyncSqlTransaction) => Result | PromiseLike<Result>): Promise<Result> {
    // Each statement is its own process and therefore its own implicit transaction. Emitting a
    // `BEGIN` here would be a lie the next `execFileSync` immediately breaks, so the handle the
    // body is given is this executor, and a statement issued through it is simply one more
    // process.
    return body(this);
  }
}

function parseRows(output: string): readonly SqlRow[] {
  if (output.trim().length === 0) return [];
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) throw new Error("sqlite json output was not an array");
  return parsed.map((row) => {
    if (!isRecord(row)) throw new Error("sqlite row was not an object");
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toSqlValue(value)]));
  });
}

function toSqlValue(value: unknown): SqlValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  throw new Error(`unsupported sqlite value: ${JSON.stringify(value)}`);
}

function bind(sql: string, parameters: SqlParameters): string {
  let index = 0;
  return sql.replaceAll("?", () => {
    const value = parameters[index];
    index += 1;
    if (value === undefined) throw new Error("missing SQL parameter");
    return sqlLiteral(value);
  });
}

function sqlLiteral(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) throw new Error("blob parameters are not supported in sqlite CLI tests");
  return `'${value.replaceAll("'", "''")}'`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function tableColumns(executor: AsyncSqlExecutor, tableName: string): Promise<readonly string[]> {
  return executor.all({
    sql: `PRAGMA table_info("${tableName}")`,
    parameters: [],
    decode: (row): string => {
      const name = row["name"];
      if (typeof name !== "string") throw new Error("missing column name");
      return name;
    },
  });
}
