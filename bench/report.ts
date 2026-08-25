// Renders `bench/RESULTS.md` from the same object that becomes `bench/results.json`, so the
// prose and the machine-readable file cannot disagree about what was measured.
import type { BenchResults, CaseResult, Unit } from "./harness.ts";

/** The numbers worth putting in front of somebody, in the order they should read them. */
const HEADLINE_IDS: readonly string[] = [
  "local.create",
  "local.update.lww",
  "read.query.warm.10000",
  "sync.roundtrip.pushed",
  "sync.roundtrip.http",
  "relay.push.http.10000",
  "snapshot.apply.1000",
  "persist.edit.1000",
];

export function renderMarkdown(results: BenchResults): string {
  const byGroup = new Map<string, CaseResult[]>();
  for (const item of results.cases) {
    byGroup.set(item.group, [...(byGroup.get(item.group) ?? []), item]);
  }
  const headline = HEADLINE_IDS.map((id) => results.cases.find((item) => item.id === id)).filter(
    (item): item is CaseResult => item !== undefined,
  );

  return [
    "# weftdb benchmarks",
    "",
    `Generated ${results.generatedAt} by \`node bench/run.ts${results.mode === "quick" ? " --quick" : ""}\`, in ${(results.runDurationMs / 1000).toFixed(1)}s.`,
    "",
    machineBlock(results),
    "",
    ...(headline.length === 0 ? [] : ["## Headline", "", table(headline), ""]),
    "## Methodology",
    "",
    METHODOLOGY,
    "",
    "## What these numbers do not mean",
    "",
    CAVEATS,
    "",
    "## All results",
    "",
    ...[...byGroup.entries()].flatMap(([group, items]) => [`### ${group}`, "", table(items), ""]),
    "## The file this is generated from",
    "",
    "`bench/results.json` carries the same numbers with one flat object per case: `id`, `group`,",
    "`label`, `unit`, `median`, `p95`, `iterations`, `note`, plus the machine block above.",
    "",
  ].join("\n");
}

function machineBlock(results: BenchResults): string {
  const machine = results.machine;
  return [
    "| Machine | |",
    "| --- | --- |",
    `| CPU | ${machine.cpu} (${machine.cores} logical cores) |`,
    `| Memory | ${(machine.memoryBytes / 1024 ** 3).toFixed(1)} GiB |`,
    `| Platform | ${machine.platform} ${machine.arch} |`,
    `| Node | ${machine.node} (V8 ${machine.v8}) |`,
  ].join("\n");
}

function table(items: readonly CaseResult[]): string {
  return [
    "| Measurement | Median | p95 | Iterations | What is measured |",
    "| --- | ---: | ---: | ---: | --- |",
    ...items.map(
      (item) =>
        `| ${item.label} | ${format(item.unit, item.median)} | ${format(item.unit, item.p95)} | ${item.iterations} | ${item.note} |`,
    ),
  ].join("\n");
}

function format(unit: Unit, value: number): string {
  if (unit === "bytes") return `${value.toLocaleString("en-US")} B`;
  if (unit === "ms") return `${value < 1 ? value.toPrecision(3) : value.toFixed(value < 100 ? 2 : 0)} ms`;
  return `${Math.round(value).toLocaleString("en-US")} ${unit}`;
}

const METHODOLOGY = [
  "Every case times its own critical section with `performance.now()`; whatever it takes to set the",
  "case up — seeding a client, starting a relay, opening a database — happens outside that region and",
  "is not counted. Each case runs a number of warmup samples that are measured and thrown away, then",
  "the sampled iterations reported in the table.",
  "",
  "`median` and `p95` are nearest-rank percentiles of the samples, with no interpolation, so both are",
  "measurements that actually happened rather than an average of two that did. Where the unit is a",
  "rate, the rate is derived from the duration distribution: `median` is the rate at the median",
  "duration and **`p95` is the rate at the 95th-percentile — that is, the slowest — duration**. For a",
  "rate, therefore, p95 is the pessimistic tail and is always the lower of the two numbers.",
  "",
  "There is no benchmarking library here. The repository takes no runtime dependencies, runs its tests",
  "on `node:test` and its storage on `node:sqlite`, and a benchmark suite is not the place to break",
  "that; the run must also work with no network access at all. What a library would have added over",
  "this harness is adaptive sample counts and calibrated subtraction of its own overhead. Instead the",
  "overhead is measured and published — see *Cost of one empty timed region* under Harness. Every",
  "duration reported elsewhere is orders of magnitude above it, so nothing here is the timer.",
  "",
  "The suite is self-contained: no fixture the repository does not carry, and no network traffic that",
  "leaves `127.0.0.1`. Relays are started on an ephemeral loopback port with their keepalive turned",
  "off, so no ping timer can fire inside a timed region. SQLite cases run against real files under the",
  "OS temp directory, which are deleted when the group ends.",
  "",
  "Sizes are sanity checks as much as data points: a case measured at 100, 1,000 and 10,000 rows is one",
  "whose cost can be seen to scale with its input rather than with the harness.",
  "",
  "Running the whole suite twice on this machine moves the typical median by about 5%. The cases whose",
  "sample lasts only a millisecond or two — the smallest relay batches — move by more than that, and",
  "their p95 says more about how the host scheduled the process than about the relay. Quote the median.",
].join("\n");

const CAVEATS = [
  "- **Loopback is not the internet.** Every relay number here was taken over `127.0.0.1`, where a",
  "  round trip costs tens of microseconds. Real devices are separated by tens of milliseconds of",
  "  network that this suite cannot and does not measure. Read the sync numbers as *the cost weftdb",
  "  adds to a round trip*, never as the round trip.",
  "- **One relay process is not a cluster.** The relay measured here is a single Node process serving",
  "  a single scope with no other traffic on it. Nothing here says what happens under concurrent load,",
  "  across several scopes, or behind a load balancer — and the relay is documented as single-process:",
  "  several sharing a database would need the scope advance to travel between them, which is not",
  "  built.",
  "- **In-memory is not durable.** Except in the Durable relay group, the relay keeps its state in",
  "  memory. The durable numbers are the honest ones for a deployment that must survive a power cut,",
  "  and they are much slower, because a push is committed with `synchronous = FULL` before it is",
  "  acknowledged.",
  "- **One machine, one process, one run.** These are medians from one process on the machine named",
  "  above, with V8 warm and garbage collection left to itself. Another machine, another Node version",
  "  or a laptop on battery will produce different numbers.",
  "- **Byte sizes are uncompressed.** Snapshot sizes are the bytes the protocol produces. Nothing here",
  "  measures transfer encoding, and a relay behind gzip or brotli would send considerably less.",
  "- **The dataset is one shape.** Every row is a demo todo: six fields, an eight-line prose note, a",
  "  string rank. A schema with wider rows, larger values or many collections will not match these",
  "  numbers.",
  "- **Convergence excludes startup.** The convergence clock starts at the first edit and stops when",
  "  every device holds identical state; starting the relay and opening the transports is setup and is",
  "  not in the number.",
  "- **Convergence is quantised.** Devices settle in whole sync rounds, so a history that needs one",
  "  more round than the last costs a whole round more. That is why the disjoint convergence cases have",
  "  a much wider median-to-p95 spread than anything else here; it is the shape of the workload, not",
  "  jitter.",
  "- **A 100-op relay batch is too small to time well.** That sample is around two milliseconds, so a",
  "  single scheduling hiccup on the host dominates its p95. It is published because the three sizes",
  "  together show how per-request overhead is amortised, not because its tail means anything.",
].join("\n");
