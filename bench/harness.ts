// Measurement machinery: how one sample is taken, how a set of samples becomes a published
// number, and the shape every case reports in. Cases time their own critical section with
// `performance.now()` and hand back a duration, so setup and teardown stay outside the clock.

export type Unit = "ms" | "ops/s" | "records/s" | "bytes";

export interface CaseSpec {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly note?: string;
}

export interface CaseResult {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly unit: Unit;
  readonly median: number;
  readonly p95: number;
  readonly iterations: number;
  readonly note: string;
}

/** How many samples a case takes, and how many it throws away before it starts counting. */
export interface Budget {
  readonly iterations: number;
  readonly warmup: number;
}

export interface BenchConfig {
  readonly mode: "quick" | "full";
  /** Cases whose sample is a tight local loop: writes, reads, merges. */
  readonly budget: Budget;
  /** Cases whose sample starts a relay, opens a database, or drives several devices. */
  readonly heavyBudget: Budget;
  /** Round trips, where a useful p95 needs more samples than a mean would. */
  readonly latencyBudget: Budget;
  /** Relay throughput, whose samples are short enough that a p95 wants a wider distribution. */
  readonly relayBudget: Budget;
  readonly readSizes: readonly number[];
  readonly snapshotSizes: readonly number[];
  readonly persistenceSizes: readonly number[];
  /** Outbox sizes, in protocol ops, pushed through the relay in one batch. */
  readonly relayBatchOps: readonly number[];
  /** Unsent-op backlogs a local edit is measured against. */
  readonly backlogOps: readonly number[];
  readonly deviceCounts: readonly number[];
  readonly editsPerDevice: number;
}

export interface BenchGroup {
  readonly name: string;
  run(config: BenchConfig): Promise<readonly CaseResult[]>;
}

export interface Machine {
  readonly node: string;
  readonly v8: string;
  readonly platform: string;
  readonly arch: string;
  readonly cpu: string;
  readonly cores: number;
  readonly memoryBytes: number;
}

/** Exactly what `bench/results.json` holds; `bench/run.ts` documents the shape field by field. */
export interface BenchResults {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly mode: "quick" | "full";
  readonly runDurationMs: number;
  readonly machine: Machine;
  readonly cases: readonly CaseResult[];
}

export function repeat(sample: () => number, budget: Budget): readonly number[] {
  for (let index = 0; index < budget.warmup; index += 1) sample();
  const samples: number[] = [];
  for (let index = 0; index < budget.iterations; index += 1) samples.push(sample());
  return samples;
}

export async function repeatAsync(sample: () => Promise<number>, budget: Budget): Promise<readonly number[]> {
  for (let index = 0; index < budget.warmup; index += 1) await sample();
  const samples: number[] = [];
  for (let index = 0; index < budget.iterations; index += 1) samples.push(await sample());
  return samples;
}

/**
 * The smallest sample at or above the requested fraction of the distribution — nearest-rank,
 * with no interpolation, so every published number is a measurement that actually happened
 * rather than an average of two that did.
 */
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) throw new Error("a case reported no samples");
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

export function duration(spec: CaseSpec, samples: readonly number[]): CaseResult {
  return {
    id: spec.id,
    group: spec.group,
    label: spec.label,
    unit: "ms",
    median: significant(percentile(samples, 0.5)),
    p95: significant(percentile(samples, 0.95)),
    iterations: samples.length,
    note: spec.note ?? "",
  };
}

/**
 * A rate, derived from the duration distribution rather than from a mean. `p95` is the rate at
 * the 95th-percentile *duration*, so it is the slow tail of the throughput — the number a reader
 * should plan against, not the best one observed.
 */
export function throughput(
  spec: CaseSpec,
  operations: number,
  samples: readonly number[],
  unit: "ops/s" | "records/s" = "ops/s",
): CaseResult {
  const rate = (ms: number): number => (ms <= 0 ? 0 : (operations / ms) * 1000);
  return {
    id: spec.id,
    group: spec.group,
    label: spec.label,
    unit,
    median: significant(rate(percentile(samples, 0.5))),
    p95: significant(rate(percentile(samples, 0.95))),
    iterations: samples.length,
    note: spec.note ?? "",
  };
}

/** A size rather than a time: measured once because it is the same every run. */
export function constant(spec: CaseSpec, unit: Unit, value: number): CaseResult {
  return {
    id: spec.id,
    group: spec.group,
    label: spec.label,
    unit,
    median: significant(value),
    p95: significant(value),
    iterations: 1,
    note: spec.note ?? "",
  };
}

function significant(value: number): number {
  return Number(value.toPrecision(4));
}

/**
 * Module state, so a result a case computes but does not otherwise need cannot be discarded as
 * dead along with the work that produced it.
 */
let _sink = 0;

export function consume(value: number): void {
  _sink += value;
}
