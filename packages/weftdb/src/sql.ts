// SQL helpers shared by the storage adapters. This module is not in the package's exports map, so
// it is reachable from inside `weftdb` and from nowhere else.

/**
 * Splits a DDL script into the statements it contains.
 *
 * `generateClientDdl` and `generateServerDdl` each return one string of `;`-separated statements,
 * and a `SqlExecutor` runs one statement per call, so something has to divide them. Shared by the
 * client and server adapters so the two cannot disagree on what a statement boundary is.
 *
 * Quoting is tracked because a semicolon can appear inside an identifier: `assertUsableName`
 * refuses control characters and nothing else, so a field called `a;b` is legal and the generator
 * quotes it into `"a;b"`. Splitting on every semicolon would cut that `CREATE TABLE` in half
 * inside the identifier and hand both halves to SQLite as statements.
 *
 * Doubling is how SQLite escapes either quote, and a doubled quote does not end the literal, so
 * `"a""b;c"` is one identifier and the semicolon in it is not a boundary either.
 */
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  /** The quote character currently open, or undefined outside a literal. */
  let quote: string | undefined;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];

    if (quote !== undefined) {
      if (character !== quote) continue;
      if (sql[index + 1] === quote) {
        // An escaped quote, not the end of the literal. Step over its second half so the closing
        // check does not see it.
        index += 1;
        continue;
      }
      quote = undefined;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === ";") {
      statements.push(sql.slice(start, index));
      start = index + 1;
    }
  }

  statements.push(sql.slice(start));
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}
