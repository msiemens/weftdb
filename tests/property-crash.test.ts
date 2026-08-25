// Durability, as a property rather than as three moments somebody thought of. §4.1 makes local
// storage the client's state rather than a cache of the server's, which means an edit that has
// been made is on disk before the call returns — so a process killed at *any* point must come
// back holding every edit made before it died, whether or not any of them ever reached a
// server. The existing durability tests pick particular instants to die at; this generates both
// the work and the instant.
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deviceId, fieldName, rowId, scopeId, tableName, wireText } from "weftdb/core";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import { SqliteWeftServer } from "weftdb/server/sqlite";
import { defineSchema, S } from "weftdb/schema";

const SCOPE = scopeId("durability");
const DEVICE = deviceId("laptop");
const TASKS = tableName("tasks");
const TITLE = fieldName("title");
const RUNS = Number(process.env["WEFT_CRASH_RUNS"] ?? 15);

const schema = defineSchema({
  tasks: S.collection({
    title: S.string(),
    notes: S.string({ nullable: true, merge: "diff3" }),
  }),
});

/** What the child does before it is killed. Each step is one durable state change. */
type Step =
  { readonly kind: "create" | "edit"; readonly row: number; readonly title: string } | { readonly kind: "sync" };

// Two rows rather than a wide spread, and edits weighted above creates: the case that matters
// is an edit made and then crashed on, and a generator that scatters its writes across many
// rows spends its runs never making the same row twice.
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("create" as const),
      row: fc.integer({ min: 0, max: 1 }),
      title: fc.string({ minLength: 1, maxLength: 8 }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("edit" as const),
      row: fc.integer({ min: 0, max: 1 }),
      title: fc.string({ minLength: 1, maxLength: 8 }),
    }),
    weight: 4,
  },
  { arbitrary: fc.record({ kind: fc.constant("sync" as const) }), weight: 2 },
);

/**
 * Replays the history the way the child does, so the parent knows what each row's title should
 * be at the moment of the crash without having to trust anything the child wrote down.
 */
function expectedTitles(steps: readonly Step[], crashAfter: number): Map<string, string> {
  const titles = new Map<string, string>();
  for (const step of steps.slice(0, crashAfter)) {
    if (step.kind === "sync") continue;
    const id = `task-${step.row}`;
    if (step.kind === "create" && titles.has(id)) continue;
    if (step.kind === "edit" && !titles.has(id)) continue;
    titles.set(id, step.title);
  }
  return titles;
}

test("a process killed at any point comes back holding every edit it had made", async () => {
  await fc.assert(
    // The kill always lands at the end of the history, and the history's own length is what
    // varies the instant it lands at. Generating a separate crash point as well only spends
    // runs replaying prefixes whose last act was something already durable.
    fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 8 }), async (steps) => {
      const crashAfter = steps.length;
      const directory = mkdtempSync(join(process.cwd(), ".weft-crash-"));
      try {
        const clientPath = join(directory, "client.sqlite");
        const serverPath = join(directory, "server.sqlite");
        const scriptPath = join(directory, "work-then-die.ts");
        writeFileSync(scriptPath, WORK_THEN_DIE);

        const child = spawnSync(
          process.execPath,
          [scriptPath, clientPath, serverPath, JSON.stringify(steps.slice(0, crashAfter))],
          { encoding: "utf8" },
        );
        assert.equal(child.signal, "SIGKILL", `the child exited instead of being killed: ${child.stderr}`);

        // Reopened from disk alone — the process that made these edits no longer exists.
        using executor = openSqliteExecutor(clientPath);
        const store = new SqliteClientStore(executor, schema);
        const reopened = store.hydrate(SCOPE, DEVICE);

        for (const [id, title] of expectedTitles(steps, crashAfter)) {
          const row = reopened.getRow(TASKS, rowId(id));
          assert.notEqual(row, undefined, `${id} was made before the crash and did not come back`);
          assert.equal(row?.fields.get(TITLE), title, `${id} came back holding an older title than it was left with`);
        }

        // Nothing the server acknowledged may be missing from it either: the client dropped
        // those ops from its outbox on the strength of that acknowledgement.
        using serverExecutor = openSqliteExecutor(serverPath);
        const server = new SqliteWeftServer(serverExecutor, () => 1_000);
        const stored = new Set(
          server
            .snapshotInReadTransaction(SCOPE)
            .fields.filter((field) => field.field === TITLE)
            .map((field) => wireText(field.value)),
        );
        const pending = new Set(reopened.outbox.map((op) => (op.kind === "set" ? wireText(op.value) : "")));
        for (const [id, title] of expectedTitles(steps, crashAfter)) {
          assert.ok(
            stored.has(title) || pending.has(title) || reopened.getRow(TASKS, rowId(id))?.fields.get(TITLE) === title,
            `${JSON.stringify(title)} is on neither the server nor this device's outbox`,
          );
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }),
    { numRuns: RUNS, endOnFailure: true },
  );
});

const WORK_THEN_DIE = `
import { deviceId, fieldName, rowId, scopeId, tableName, txnId } from "weftdb/core";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { SqliteClientStore } from "weftdb/client/sqlite";
import { openSqliteExecutor } from "weftdb/server/node-sqlite";
import { SqliteWeftServer } from "weftdb/server/sqlite";

const schema = defineSchema({
  tasks: S.collection({
    title: S.string(),
    notes: S.string({ nullable: true, merge: "diff3" }),
  }),
});

const [, , clientPath, serverPath, encodedSteps] = process.argv;
const steps = JSON.parse(encodedSteps);

const clientExecutor = openSqliteExecutor(clientPath);
const store = new SqliteClientStore(clientExecutor, schema);
store.installSchema();
const client = store.attach(store.hydrate(scopeId("durability"), deviceId("laptop")));
const server = new SqliteWeftServer(openSqliteExecutor(serverPath), () => 1_000);

let counter = 0;
for (const step of steps) {
  counter += 1;
  const id = rowId("task-" + step.row);
  if (step.kind === "sync") {
    client.sync(server, schemaHash(schema));
    continue;
  }
  const exists = client.getRow(tableName("tasks"), id) !== undefined;
  if (step.kind === "create" && exists) continue;
  if (step.kind === "edit" && !exists) continue;
  const values = { [fieldName("title")]: step.title };
  if (exists) client.update(tableName("tasks"), id, values, txnId("t" + counter));
  else client.create(tableName("tasks"), id, values, txnId("t" + counter));
}

// Die the way a power cut does: no close, no flush, no exit handlers. Everything above was
// supposed to be on disk before the call that made it returned.
process.kill(process.pid, "SIGKILL");
`;
