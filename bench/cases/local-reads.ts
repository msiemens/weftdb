// Reading a list back out. The subscription engine is what a React binding calls on every
// render, so its cost per query — not per row — is the number that decides whether a list feels
// instant at a given size.
import { SubscriptionEngine, queryKey, WeftClient, type QueryKey } from "weftdb/client";
import { TITLE, TODOS, schema, syncedClient, todoId, updateTxn } from "../fixtures.ts";
import {
  consume,
  duration,
  repeat,
  repeatAsync,
  type BenchConfig,
  type BenchGroup,
  type CaseResult,
} from "../harness.ts";

const GROUP = "Local reads";

export const localReads: BenchGroup = {
  name: GROUP,
  run: async (config: BenchConfig): Promise<readonly CaseResult[]> => {
    const results: CaseResult[] = [];
    for (const rows of config.readSizes) {
      const key = queryKey(schema, "todos", { orderBy: "rank" });
      // One dataset for all four cases at this size, so what separates them is the read path
      // rather than which rows they happened to be given.
      const client = await syncedClient(rows);
      results.push(
        warmQuery(config, rows, key, client),
        coldQuery(config, rows, key, client),
        await queryAfterEdit(config, rows, key, client),
        listRows(config, rows, client),
      );
    }
    return results;
  },
};

/** The render path: the same query asked again with nothing changed underneath it. */
function warmQuery(config: BenchConfig, rows: number, key: QueryKey, client: WeftClient): CaseResult {
  const engine = new SubscriptionEngine();
  const samples = repeat(() => {
    const start = performance.now();
    const snapshot = engine.getSnapshot(key, client.rows.values());
    const elapsed = performance.now() - start;
    consume(snapshot.rows.length);
    return elapsed;
  }, config.budget);
  return duration(
    {
      id: `read.query.warm.${rows}`,
      group: GROUP,
      label: `Query ${rows.toLocaleString("en-US")} rows, unchanged (cached result)`,
      note: "the subscription engine still filters and sorts every row before it can tell the result is unchanged",
    },
    samples,
  );
}

/** The first query of a session: nothing is cached, so every row is materialized. */
function coldQuery(config: BenchConfig, rows: number, key: QueryKey, client: WeftClient): CaseResult {
  const samples = repeat(() => {
    const engine = new SubscriptionEngine();
    const start = performance.now();
    const snapshot = engine.getSnapshot(key, client.rows.values());
    const elapsed = performance.now() - start;
    consume(snapshot.rows.length);
    return elapsed;
  }, config.budget);
  return duration(
    {
      id: `read.query.cold.${rows}`,
      group: GROUP,
      label: `Query ${rows.toLocaleString("en-US")} rows, cold engine`,
      note: "a fresh subscription engine per sample, so every row is filtered, sorted and materialized",
    },
    samples,
  );
}

/** What a list costs to re-read after one row in it changed, which is what an edit triggers. */
async function queryAfterEdit(
  config: BenchConfig,
  rows: number,
  key: QueryKey,
  client: WeftClient,
): Promise<CaseResult> {
  const engine = new SubscriptionEngine();
  const row = todoId(0);
  let counter = 0;
  consume(engine.getSnapshot(key, client.rows.values()).rows.length);
  const samples = await repeatAsync(async () => {
    counter += 1;
    // Editing is setup; the edit itself is measured under Local writes.
    await client.update(TODOS, row, { [TITLE]: `title ${counter}` }, updateTxn(row));
    const start = performance.now();
    const snapshot = engine.getSnapshot(key, client.rows.values());
    const elapsed = performance.now() - start;
    consume(snapshot.delta.changed.length);
    return elapsed;
  }, config.budget);
  return duration(
    {
      id: `read.query.afterEdit.${rows}`,
      group: GROUP,
      label: `Re-query ${rows.toLocaleString("en-US")} rows after one row changed`,
      note: "the cached result no longer matches, so the engine rebuilds the result and computes the delta against it",
    },
    samples,
  );
}

/** The direct read: no subscription, no ordering, just every row of one table. */
function listRows(config: BenchConfig, rows: number, client: WeftClient): CaseResult {
  const samples = repeat(() => {
    const start = performance.now();
    const listed = client.listRows(TODOS);
    const elapsed = performance.now() - start;
    consume(listed.length);
    return elapsed;
  }, config.budget);
  return duration(
    {
      id: `read.listRows.${rows}`,
      group: GROUP,
      label: `listRows over ${rows.toLocaleString("en-US")} rows`,
      note: "every row is copied into a fresh materialized row, with no identity cache in the way",
    },
    samples,
  );
}
