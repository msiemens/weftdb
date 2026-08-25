// The benchmark suite's entry point: `node bench/run.ts`, or `node bench/run.ts --quick` for a
// smoke run at smaller sizes and fewer iterations.
//
// It writes two files beside itself. `bench/RESULTS.md` is the readable table, rendered from the
// same object as the JSON so the two cannot drift. `bench/results.json` is what a landing page
// reads, and its shape is flat and stable:
//
//   {
//     "schemaVersion": 1,
//     "generatedAt":   ISO-8601 timestamp of the run,
//     "mode":          "full" | "quick",
//     "runDurationMs": wall clock for the whole suite,
//     "machine":       { node, v8, platform, arch, cpu, cores, memoryBytes },
//     "cases": [
//       {
//         "id":         stable identifier, safe to key on across runs (e.g. "local.create"),
//         "group":      the heading this case belongs under,
//         "label":      what to call it in front of a person,
//         "unit":       "ms" | "ops/s" | "records/s" | "bytes",
//         "median":     nearest-rank median of the samples, in `unit`,
//         "p95":        nearest-rank 95th percentile — for a rate, the rate at the *slowest*
//                       duration, so it is the pessimistic tail and lower than the median,
//         "iterations": how many samples the two numbers come from, warmup excluded,
//         "note":       what was measured, and the caveat that belongs beside the number
//       }
//     ]
//   }
//
// Case ids are stable; sizes are part of the id (`read.query.warm.10000`), so a run in `--quick`
// mode simply produces fewer of them rather than different ones.
import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { convergence } from "./cases/convergence.ts";
import { localReads } from "./cases/local-reads.ts";
import { localWrites } from "./cases/local-writes.ts";
import { merge } from "./cases/merge.ts";
import { overhead } from "./cases/overhead.ts";
import { persistence } from "./cases/persistence.ts";
import { relayDurable } from "./cases/relay-durable.ts";
import { relayThroughput } from "./cases/relay-throughput.ts";
import { snapshot } from "./cases/snapshot.ts";
import { syncLatency } from "./cases/sync-latency.ts";
import { workerBoundary } from "./cases/worker-boundary.ts";
import { renderMarkdown } from "./report.ts";
import type { BenchConfig, BenchGroup, BenchResults, CaseResult, Machine } from "./harness.ts";

const GROUPS: readonly BenchGroup[] = [
  overhead,
  localWrites,
  localReads,
  merge,
  snapshot,
  persistence,
  workerBoundary,
  syncLatency,
  relayThroughput,
  relayDurable,
  convergence,
];

const FULL: BenchConfig = {
  mode: "full",
  budget: { iterations: 25, warmup: 5 },
  heavyBudget: { iterations: 20, warmup: 3 },
  latencyBudget: { iterations: 200, warmup: 50 },
  relayBudget: { iterations: 30, warmup: 5 },
  readSizes: [100, 1_000, 10_000],
  snapshotSizes: [100, 1_000, 5_000],
  persistenceSizes: [100, 1_000, 5_000],
  relayBatchOps: [100, 1_000, 10_000],
  backlogOps: [0, 1_000, 10_000],
  deviceCounts: [2, 4, 8],
  editsPerDevice: 10,
};

const QUICK: BenchConfig = {
  mode: "quick",
  budget: { iterations: 5, warmup: 2 },
  heavyBudget: { iterations: 5, warmup: 1 },
  latencyBudget: { iterations: 30, warmup: 10 },
  relayBudget: { iterations: 8, warmup: 2 },
  readSizes: [100, 1_000],
  snapshotSizes: [100, 1_000],
  persistenceSizes: [100, 1_000],
  relayBatchOps: [100, 1_000],
  backlogOps: [0, 1_000],
  deviceCounts: [2, 4],
  editsPerDevice: 5,
};

async function main(): Promise<void> {
  const config = process.argv.includes("--quick") ? QUICK : FULL;
  const machine = describeMachine();
  process.stdout.write(
    `weftdb bench — ${config.mode} run on ${machine.cpu} (${machine.cores} cores), Node ${machine.node}\n\n`,
  );

  const started = performance.now();
  const cases: CaseResult[] = [];
  for (const group of GROUPS) {
    const groupStarted = performance.now();
    const produced = await group.run(config);
    cases.push(...produced);
    process.stdout.write(
      `${group.name}: ${produced.length} cases in ${((performance.now() - groupStarted) / 1000).toFixed(1)}s\n`,
    );
    for (const item of produced) process.stdout.write(`  ${item.median} ${item.unit.padEnd(10)} ${item.label}\n`);
    process.stdout.write("\n");
  }

  const results: BenchResults = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: config.mode,
    runDurationMs: Math.round(performance.now() - started),
    machine,
    cases,
  };

  const directory = import.meta.dirname;
  writeFileSync(join(directory, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(directory, "RESULTS.md"), renderMarkdown(results));
  process.stdout.write(
    `wrote bench/results.json and bench/RESULTS.md (${cases.length} cases, ${(results.runDurationMs / 1000).toFixed(1)}s)\n`,
  );
}

function describeMachine(): Machine {
  const cores = cpus();
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cpu: cores[0]?.model.trim() ?? "unknown",
    cores: cores.length,
    memoryBytes: totalmem(),
  };
}

await main();
