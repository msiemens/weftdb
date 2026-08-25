// Measurement machinery for the browser harness, kept deliberately in step with `bench/harness.ts`:
// a case takes warmup samples and throws them away, takes `iterations` real ones, and publishes a
// median and a p95 picked by nearest rank. Nothing here interpolates, so every number in the table
// is a duration that actually happened rather than an average of two that did.

export interface Budget {
  readonly iterations: number;
  readonly warmup: number;
}

/**
 * The smallest sample at or above the requested fraction of the distribution — nearest-rank, with
 * no interpolation, the same rule `bench/harness.ts` publishes under.
 */
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) throw new Error("a case reported no samples");
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank] ?? 0;
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

/** Four significant figures, because the fifth is jitter in every one of these cases. */
export function significant(value: number): number {
  return Number(value.toPrecision(4));
}

export interface CaseRow {
  readonly id: string;
  /** Rows in the database the case ran against, or null for cases that have no size. */
  readonly size: number | null;
  readonly median: number | null;
  readonly p95: number | null;
  readonly samples: number;
  readonly status: "ok" | "failed";
  readonly note: string;
}

export function duration(id: string, size: number | null, note: string, samples: readonly number[]): CaseRow {
  return {
    id,
    size,
    median: significant(percentile(samples, 0.5)),
    p95: significant(percentile(samples, 0.95)),
    samples: samples.length,
    status: "ok",
    note,
  };
}

/** The same distribution divided through — a burst's implied cost per message in it. */
export function perOperation(
  id: string,
  size: number | null,
  note: string,
  samples: readonly number[],
  operations: number,
): CaseRow {
  return duration(
    id,
    size,
    note,
    samples.map((sample) => sample / operations),
  );
}

export function failure(id: string, size: number | null, message: string): CaseRow {
  return { id, size, median: null, p95: null, samples: 0, status: "failed", note: message };
}

/** Whatever a thrown value turns out to be, said in one line. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
