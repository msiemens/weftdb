// The two ways a field can be reconciled: the prose merge that runs on the client when the
// server refuses a stale ancestor, and the last-writer-wins comparison every other field write
// goes through on the server.
import { HlcClock, diff3, txnId, type SetOp, type WeftOp } from "weftdb/core";
import { WeftServer, fieldKey } from "weftdb/server";
import { HASH, SCOPE, TITLE, TODOS, benchClient, seedRows, todoId } from "../fixtures.ts";
import { consume, repeat, throughput, type BenchConfig, type BenchGroup, type CaseResult } from "../harness.ts";

const GROUP = "Merge";

const MERGES_PER_SAMPLE = 2_000;
const WRITES_PER_SAMPLE = 2_000;
const DOCUMENT_LINES = 20;

export const merge: BenchGroup = {
  name: GROUP,
  run: async (config: BenchConfig): Promise<readonly CaseResult[]> => [
    diff3Case(config, "disjoint"),
    diff3Case(config, "conflicting"),
    lwwFieldWrite(config),
  ],
};

function diff3Case(config: BenchConfig, kind: "disjoint" | "conflicting"): CaseResult {
  const base = document();
  const local = replaceLine(base, 3, "the local device rewrote this line");
  const remote = replaceLine(base, kind === "disjoint" ? 12 : 3, "the remote device rewrote this line");
  const samples = repeat(() => {
    const start = performance.now();
    for (let index = 0; index < MERGES_PER_SAMPLE; index += 1) consume(diff3(base, local, remote).value.length);
    return performance.now() - start;
  }, config.budget);
  const conflicted = diff3(base, local, remote).conflicted;
  if (conflicted !== (kind === "conflicting")) throw new Error(`the ${kind} diff3 case did not merge as described`);
  return throughput(
    {
      id: `merge.diff3.${kind}`,
      group: GROUP,
      label: `diff3 prose merge, ${kind} edits`,
      note: `${DOCUMENT_LINES}-line document, one line changed on each side, ${MERGES_PER_SAMPLE} merges per sample`,
    },
    MERGES_PER_SAMPLE,
    samples,
  );
}

/**
 * One field write as the server sees it: validated, compared against the stamp already stored,
 * applied, and given a sequence. In process, so nothing here is network or disk.
 */
function lwwFieldWrite(config: BenchConfig): CaseResult {
  const server = new WeftServer();
  const client = benchClient("device-0");
  seedRows(client, 1);
  client.sync(server, HASH);
  const row = todoId(0);
  const key = fieldKey({ scopeId: SCOPE, tableName: TODOS, rowId: row, field: TITLE });
  const clock = new HlcClock(client.deviceId);
  const stored = server.fields.get(key);
  if (stored === undefined) throw new Error("the seeded field never reached the server");
  // Every measured write has to win its comparison, or half the samples would be timing the
  // branch that discards the op instead of the one that stores it.
  clock.observe(stored.hlc);

  let counter = 0;
  const samples = repeat(() => {
    counter += 1;
    const batches: WeftOp[][] = Array.from({ length: WRITES_PER_SAMPLE }, (_unused, index) => [
      {
        scopeId: SCOPE,
        tableName: TODOS,
        rowId: row,
        kind: "set",
        field: TITLE,
        value: `title ${counter}-${index}`,
        hlc: clock.next(),
        txnId: txnId(`bench-${counter}-${index}`),
      } satisfies SetOp,
    ]);
    const start = performance.now();
    for (const batch of batches) server.push(SCOPE, batch);
    const elapsed = performance.now() - start;
    if (server.fields.get(key)?.value !== `title ${counter}-${WRITES_PER_SAMPLE - 1}`) {
      throw new Error("the last measured write did not win its comparison");
    }
    return elapsed;
  }, config.budget);

  return throughput(
    {
      id: "merge.lww.serverField",
      group: GROUP,
      label: "Last-writer-wins field write through the server",
      note: `${WRITES_PER_SAMPLE} single-op pushes per sample against an in-process server, no network`,
    },
    WRITES_PER_SAMPLE,
    samples,
  );
}

function document(): string {
  return Array.from(
    { length: DOCUMENT_LINES },
    (_unused, line) => `line ${line}: what the note said before either device touched it`,
  ).join("\n");
}

function replaceLine(text: string, line: number, replacement: string): string {
  const lines = text.split("\n");
  lines[line] = replacement;
  return lines.join("\n");
}
