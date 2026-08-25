// Generated SQL, built from names and values this process did not choose. Two of the three
// generators here are handed data from outside: `weft rehydrate` turns a snapshot from a server
// into SQL an operator then runs against their own database, and the client's store writes rows
// whose field names arrived over the wire. Escaping by hand is correct for SQLite — doubling
// `'` closes a literal and doubling `"` closes an identifier, and there are no backslash
// escapes to work around — but "correct as far as I can reason" is not the same as "checked",
// so the SQL is executed and the database is asked what happened to it.
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import { rehydrateSnapshotNdjson, setSchemaHashSql } from "weftdb-cli";
import { generateClientDdl, generateServerDdl } from "weftdb/codegen";
import { defineSchema, S } from "weftdb/schema";
import { SqliteClientStore } from "weftdb/client/sqlite";
import type { SqlExecutor, SqlRow } from "weftdb/shared";
import { DatabaseSync } from "node:sqlite";

const RUNS = Number(process.env["WEFT_SQL_RUNS"] ?? 200);

/** Written as code points rather than a regex, so no control character sits literally in this file. */
function hasControlCharacter(name: string): boolean {
  return [...name].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

/** The smallest executor that is really SQLite, and really one statement per call. */
function executorOver(database: DatabaseSync): SqlExecutor {
  return {
    all: (statement) =>
      database
        .prepare(statement.sql)
        .all(...statement.parameters)
        .map((row) => statement.decode(row as SqlRow)),
    get: (statement) => {
      const row = database.prepare(statement.sql).get(...statement.parameters);
      return row === undefined ? undefined : statement.decode(row);
    },
    run: (statement) => {
      database.prepare(statement.sql).run(...statement.parameters);
    },
    transaction: (body) => body(),
  };
}

/** The shapes an attacker reaches for, plus the ones that break naive escaping by accident. */
const hostileArb = fc.oneof(
  fc.constantFrom(
    "'; DROP TABLE todos; --",
    '"; DROP TABLE todos; --',
    "') VALUES ('x'); DROP TABLE todos; --",
    '" ); DROP TABLE todos; --',
    "'' OR 1=1 --",
    "a'--",
    'a"--',
    "\\'; DROP TABLE todos; --",
    "'\n; DROP TABLE todos;\n--",
    'todos" , "extra',
    "'||(SELECT name FROM sqlite_master)||'",
    String.fromCharCode(0),
    "‑unicode‑",
  ),
  fc.string({ maxLength: 24 }),
);

/**
 * Runs generated SQL the way an operator does: as a script, parsed by SQLite itself. Splitting
 * it on semicolons here would be the test cutting statements apart at a `;` inside a quoted
 * value — which manufactures the injection it is supposed to be looking for.
 */
function runScript(database: DatabaseSync, sql: string): void {
  try {
    database.exec(sql);
  } catch {
    // Refusing to run is a fine outcome; running something other than what it says is not.
  }
}

/** The tables a database holds, which is what an injected statement would change. */
function tables(database: DatabaseSync): readonly string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => String((row as Record<string, unknown>)["name"]))
    .sort();
}

/** The tables the client DDL creates whatever the schema says: the outbox, quarantine and so on. */
function frameworkTables(): readonly string[] {
  const baseline = defineSchema({ baseline_only: S.collection({ value: S.string() }) });
  using database = new DatabaseSync(":memory:");
  database.exec(generateClientDdl(baseline));
  return tables(database).filter((name) => name !== "baseline_only");
}

function snapshotLine(table: string, row: string, field: string, value: unknown): string {
  return JSON.stringify({
    type: "field",
    record: { scopeId: "s", tableName: table, rowId: row, field, value, hlc: "h", serverSeq: 1, txnId: "t" },
  });
}

test("a hostile snapshot cannot make `weft rehydrate` emit SQL that does something else", () => {
  const schema = defineSchema({ todos: S.collection({ title: S.string() }) });
  fc.assert(
    fc.property(hostileArb, hostileArb, (rowId, title) => {
      using database = new DatabaseSync(":memory:");
      database.exec(generateClientDdl(schema));
      const before = tables(database);

      // A snapshot is a file from a server. Everything in it is that server's choice.
      runScript(database, rehydrateSnapshotNdjson(snapshotLine("todos", rowId, "title", title)));

      assert.deepEqual(tables(database), before, "rehydrating a snapshot changed which tables exist");
      const stored = database
        .prepare("SELECT id, title FROM todos")
        .all()
        .map((row) => ({
          id: String((row as Record<string, unknown>)["id"]),
          title: String((row as Record<string, unknown>)["title"]),
        }));
      for (const row of stored) {
        // Whatever was inserted has to be exactly what the snapshot said, not a fragment of it
        // that stopped at a quote.
        assert.equal(row.id, rowId, "the row id was altered on the way through the generated SQL");
        assert.equal(row.title, JSON.stringify(title), "the value was altered on the way through the generated SQL");
      }
    }),
    { numRuns: RUNS },
  );
});

test("a hostile table or field name in a snapshot cannot reach the database as SQL", () => {
  const schema = defineSchema({ todos: S.collection({ title: S.string() }) });
  fc.assert(
    fc.property(hostileArb, hostileArb, (table, field) => {
      using database = new DatabaseSync(":memory:");
      database.exec(generateClientDdl(schema));
      const before = tables(database);

      // An unknown table or column makes the script fail, which is the right answer.
      runScript(database, rehydrateSnapshotNdjson(snapshotLine(table, "row-1", field, "value")));
      assert.deepEqual(tables(database), before, "a name from a snapshot created or dropped a table");
    }),
    { numRuns: RUNS },
  );
});

test("`weft set-schema-hash` cannot be steered by its arguments", () => {
  fc.assert(
    fc.property(hostileArb, hostileArb, (scope, hash) => {
      using database = new DatabaseSync(":memory:");
      database.exec(generateServerDdl());
      const before = tables(database);

      runScript(database, setSchemaHashSql({ scopeId: scope, schemaHash: hash, schemaVersion: 3 }));

      assert.deepEqual(tables(database), before, "a scope or hash argument changed which tables exist");
      const stored = database
        .prepare("SELECT scope_id, schema_hash FROM scope_state")
        .all()
        .map((row) => ({
          scope: String((row as Record<string, unknown>)["scope_id"]),
          hash: String((row as Record<string, unknown>)["schema_hash"]),
        }));
      for (const row of stored) {
        assert.equal(row.scope, scope, "the scope was altered on the way through the generated SQL");
        assert.equal(row.hash, hash, "the hash was altered on the way through the generated SQL");
      }
    }),
    { numRuns: RUNS },
  );
});

test("a schema written with hostile names generates DDL that means what it says", () => {
  fc.assert(
    fc.property(hostileArb, hostileArb, (table, field) => {
      // The schema is the application's own code rather than anything from outside, so this is
      // a robustness claim rather than a boundary: a name that needs quoting has to survive
      // quoting, and must not silently become two columns or a second statement.
      fc.pre(table.trim().length > 0 && field.trim().length > 0 && !field.startsWith("_weft_"));
      // A name with a control character in it cannot be a column, and the schema says so
      // rather than generating something that quietly means something else.
      // eslint-disable-next-line no-control-regex -- matching control characters is the point
      if (/[\u0000-\u001f\u007f]/u.test(table) || /[\u0000-\u001f\u007f]/u.test(field)) {
        assert.throws(() => defineSchema({ [table]: S.collection({ [field]: S.string() }) }), /control character/u);
        return;
      }
      const schema = defineSchema({ [table]: S.collection({ [field]: S.string() }) });
      using database = new DatabaseSync(":memory:");
      database.exec(generateClientDdl(schema));

      // The declared table plus the framework's own — an outbox, a quarantine, the sync state.
      // What must not appear is anything a name talked the generator into creating.
      assert.deepEqual(
        tables(database),
        [...new Set([...frameworkTables(), table])].sort(),
        "the generated DDL created something other than the declared table and the framework's",
      );
      const columns = database
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all(table)
        .map((row) => String((row as Record<string, unknown>)["name"]));
      assert.ok(columns.includes(field), `${JSON.stringify(field)} did not survive as a column name`);
    }),
    { numRuns: RUNS },
  );
});

test("a name carrying a statement terminator survives the adapter's split", () => {
  fc.assert(
    fc.property(hostileArb, (field) => {
      // The property above runs the whole script through `exec`, which no adapter can do: a
      // `SqlExecutor` takes one statement per call, so the stores divide the script first and
      // that split is what a hostile name actually reaches. It went unchecked, and a semicolon
      // is a legal field name — `defineSchema` refuses control characters and nothing else — so
      // splitting on every semicolon cut `CREATE TABLE` in half inside its own quotes and handed
      // both halves to SQLite as statements.
      // A control character cannot be a column at all, and the property above is where the
      // schema is held to refusing one. This property is about the names that are legal.
      fc.pre(field.trim().length > 0 && !field.startsWith("_weft_") && !hasControlCharacter(field));
      // eslint-disable-next-line no-control-regex -- superseded by hasControlCharacter above
      if (/[ -]/u.test(field)) return;

      const schema = defineSchema({ tasks: S.collection({ [field]: S.string() }) });
      using database = new DatabaseSync(":memory:");
      new SqliteClientStore(executorOver(database), schema).installSchema();

      assert.deepEqual(
        tables(database),
        [...new Set([...frameworkTables(), "tasks"])].sort(),
        "splitting the script created something other than the declared table and the framework's",
      );
      const columns = database
        .prepare("SELECT name FROM pragma_table_info('tasks')")
        .all()
        .map((row) => String((row as Record<string, unknown>)["name"]));
      assert.ok(columns.includes(field), `${JSON.stringify(field)} did not survive the split`);
    }),
    { numRuns: RUNS },
  );
});
