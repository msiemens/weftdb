// The harness measuring itself. Nothing below is a claim about weftdb: it is here so a reader can
// see how much of a reported duration could be the timer rather than the system, and so a case
// that ever lands near this number can be recognised as unmeasurable rather than fast.
import { consume, duration, repeat, type BenchConfig, type BenchGroup, type CaseResult } from "../harness.ts";

const GROUP = "Harness";

const PROBES_PER_SAMPLE = 100_000;

export const overhead: BenchGroup = {
  name: GROUP,
  run: async (config: BenchConfig): Promise<readonly CaseResult[]> => [timerOverhead(config)],
};

function timerOverhead(config: BenchConfig): CaseResult {
  const samples = repeat(() => {
    const start = performance.now();
    for (let index = 0; index < PROBES_PER_SAMPLE; index += 1) {
      const inner = performance.now();
      consume(performance.now() - inner);
    }
    return (performance.now() - start) / PROBES_PER_SAMPLE;
  }, config.budget);
  return duration(
    {
      id: "bench.timerOverhead",
      group: GROUP,
      label: "Cost of one empty timed region",
      note: `two performance.now() calls and a subtraction, averaged over ${PROBES_PER_SAMPLE.toLocaleString("en-US")} per sample`,
    },
    samples,
  );
}
