// Durability: what survives a process that dies without warning.
//
// The client's local database is its state, not a cache of it (§4.1), and §10 depends on
// that — unsent ops sit on disk with no session present until sign-in lets them push. The
// server acknowledges a push only after committing it, and the client drains its outbox on
// that acknowledgement, so an acknowledged transaction has to survive a crash too.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId } from "weftdb/shared";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { WeftClient } from "weftdb/client";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import { SqliteWeftServer } from "weftdb/server/sqlite";

const schema = defineSchema({
  tasks: S.collection({
    title: S.string(),
    notes: S.string({ nullable: true, merge: "diff3" }),
  }),
});

const SCOPE = scopeId("durability");
const DEVICE = deviceId("laptop");
const TASKS = tableName("tasks");
const TITLE = fieldName("title");

test("unsent local work survives losing the process", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "client.sqlite");

  {
    using executor = openSqliteExecutor(path);
    const store = new SqliteClientStore(executor, schema);
    store.installSchema();
    const client = store.attach(new WeftClient(SCOPE, DEVICE, schema, () => 1_000));

    client.create(TASKS, rowId("task-1"), { [TITLE]: "written before the crash" }, txnId("create"));
    client.update(TASKS, rowId("task-1"), { [TITLE]: "edited before the crash" }, txnId("edit"));
    // No save() call anywhere: persistence is a property of making the change.
  }

  using executor = openSqliteExecutor(path);
  const hydrated = new SqliteClientStore(executor, schema).hydrate(SCOPE, DEVICE);
  assert.equal(hydrated.getRow(TASKS, rowId("task-1"))?.fields.get(TITLE), "edited before the crash");
  assert.equal(hydrated.outbox.length > 0, true, "the outbox did not survive");
  assert.deepEqual(
    [...new Set(hydrated.outbox.map((op) => op.txnId))].sort(),
    [txnId("create"), txnId("edit")].sort(),
    "an unsent transaction was lost",
  );
});

test("quarantined work survives losing the process, and can still be repaired", (t) => {
  const directory = temporaryDirectory(t);
  const clientPath = join(directory, "client.sqlite");
  const serverPath = join(directory, "server.sqlite");

  {
    using clientDb = openSqliteExecutor(clientPath);
    using serverDb = openSqliteExecutor(serverPath);
    const store = new SqliteClientStore(clientDb, schema);
    store.installSchema();
    const server = new SqliteWeftServer(serverDb, () => 1_000);
    const client = store.attach(new WeftClient(SCOPE, DEVICE, schema, () => 1_000));

    client.create(TASKS, rowId("task-1"), { [TITLE]: "first" }, txnId("create"));
    client.sync(server, schemaHash(schema));
    // A base field write is a quarantine-class rejection.
    client.update(TASKS, rowId("task-1"), { [fieldName("created")]: "rewritten" }, txnId("bad"));
    client.sync(server, schemaHash(schema));
    assert.equal(client.quarantine.length > 0, true, "nothing was quarantined to begin with");
  }

  using clientDb = openSqliteExecutor(clientPath);
  const hydrated = new SqliteClientStore(clientDb, schema).hydrate(SCOPE, DEVICE);
  assert.equal(
    hydrated.quarantine.some((op) => op.txnId === txnId("bad") && op.reason === "base_field_violation"),
    true,
    "quarantined work was lost, so the user could never be asked about it",
  );
  assert.equal(hydrated.exportQuarantinedTxn(txnId("bad")).length > 0, true, "the repair API cannot see it");
  hydrated.discardQuarantinedTxn(txnId("bad"));
  assert.deepEqual(hydrated.quarantine, [], "discarding after a restart did not take");
});

test("an acknowledged push survives the server being killed outright", (t) => {
  const directory = temporaryDirectory(t);
  const databasePath = join(directory, "server.sqlite");
  const scriptPath = join(directory, "push-then-die.ts");
  writeFileSync(scriptPath, PUSH_THEN_DIE);

  // The child pushes, waits for the acknowledgement, and is then killed without unwinding:
  // no close, no flush, nothing. Whatever the acknowledgement promised must already be on
  // disk, because the client that received it has dropped the ops from its outbox.
  const child = spawnSync(process.execPath, [scriptPath, databasePath], { encoding: "utf8" });
  assert.equal(child.stdout.includes("acked"), true, `the child never acknowledged: ${child.stderr}`);
  assert.equal(child.signal, "SIGKILL", `the child exited normally instead of being killed: ${child.signal}`);

  using executor = openSqliteExecutor(databasePath);
  const reopened = new SqliteWeftServer(executor, () => 2_000);
  const snapshot = reopened.snapshotInReadTransaction(SCOPE);
  assert.equal(
    snapshot.fields.some((field) => field.field === TITLE && field.value === "acknowledged before the kill"),
    true,
    "an acknowledged transaction did not survive the crash",
  );
  assert.equal(snapshot.rows.length, 1, "the row record did not survive the crash");
});

test("the server database is configured to survive power loss, not just process death", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "server.sqlite");
  using executor = openSqliteExecutor(path);
  executor.run({ sql: "CREATE TABLE probe (id INTEGER)", parameters: [] });

  // synchronous=FULL is what makes a commit durable across a power cut under WAL; NORMAL
  // can lose the most recent transactions, which the push acknowledgement has promised.
  const synchronous = executor.get({ sql: "PRAGMA synchronous", parameters: [], decode: (row) => row["synchronous"] });
  assert.equal(synchronous, 2, "the database is not configured for full durability");
  const journal = executor.get({ sql: "PRAGMA journal_mode", parameters: [], decode: (row) => row["journal_mode"] });
  assert.equal(journal, "wal");
});

const PUSH_THEN_DIE = `
import { deviceId, fieldName, rowId, scopeId, tableName, txnId } from "weftdb/shared";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { WeftClient } from "weftdb/client";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import { SqliteWeftServer } from "weftdb/server/sqlite";

const schema = defineSchema({
  tasks: S.collection({
    title: S.string(),
    notes: S.string({ nullable: true, merge: "diff3" }),
  }),
});

const executor = openSqliteExecutor(process.argv[2]);
const server = new SqliteWeftServer(executor, () => 1_000);
const client = new WeftClient(scopeId("durability"), deviceId("laptop"), schema, () => 1_000);
client.create(tableName("tasks"), rowId("task-1"), { [fieldName("title")]: "acknowledged before the kill" }, txnId("create"));
client.sync(server, schemaHash(schema));

if (client.outbox.length !== 0) throw new Error("the push was not acknowledged");
process.stdout.write("acked\\n");
// Die the way a power cut does: no close, no flush, no exit handlers.
process.kill(process.pid, "SIGKILL");
`;

/**
 * Inside the workspace rather than the system temp directory: the crash test spawns a child
 * that imports the packages, so it has to sit somewhere they resolve from.
 */
function temporaryDirectory(t: import("node:test").TestContext): string {
  const directory = mkdtempSync(join(process.cwd(), ".weft-durability-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
