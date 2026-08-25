// Mutation testing for the packages the protocol actually lives in.
//
// Stryker's sandbox is the wrong shape for this workspace: there is no build step, so the
// tests import `weftdb` subpaths through pnpm's `node_modules` links, and those links
// are absolute paths back into `packages/`. A copied sandbox would therefore keep loading the
// unmutated originals and every mutant would "survive". Mutating in place is the only way the
// change is visible to the suite, so this harness edits the real file, runs the suite, and
// restores it — with the restore wired to process exit so an interrupt cannot leave a mutation
// behind.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

// The three files the protocol's decisions live in, then the modules around them that decide
// what is accepted, what is stored, and what is generated. The second group was added after a
// bug hunt found defects in every one of them — an unmeasured module is one where nobody knows
// whether the tests would notice, and "the harness never looked there" is not an answer.
//
// `--only` takes a substring, so `--only server/` or `--only client/index` narrows a run to one
// group without editing this list.
const TARGETS = [
  "packages/weftdb/src/shared/index.ts",
  "packages/weftdb/src/client/index.ts",
  "packages/weftdb/src/server/index.ts",
  "packages/weftdb/src/schema/index.ts",
  "packages/weftdb/src/codegen/index.ts",
  "packages/weftdb/src/client/sqlite.ts",
  "packages/weftdb/src/client/subscriptions.ts",
  "packages/weftdb/src/client/multitab.ts",
  "packages/weftdb/src/server/relay.ts",
  "packages/weftdb/src/server/serve.ts",
  "packages/weftdb/src/server/jwt.ts",
  "packages/weftdb/src/server/snapshot.ts",
  "packages/weftdb/src/server/websocket.ts",
  "packages/weftdb/src/server/websocket-frames.ts",
];

// The suite runs in waves, cheapest first, and a wave that kills the mutant means the next one
// is never started. Everything in the first wave finishes in about a second; the later waves hold
// the files that dominate the wall clock, so a mutant most tests can see costs a second rather
// than a minute.
//
// The waves decide accuracy as well as speed. A mutant only a test outside them would catch is
// reported as a survivor, which reads as "no test notices this" when the truth is "the harness
// never ran the test that does" — and a survivor list nobody trusts is worse than none. Because
// a wave is only reached by a mutant everything before it missed, a slow test file placed last
// costs nothing for the mutants that die early and is paid for only by survivors, which is
// exactly where the accuracy is needed. So every test file that exercises a target belongs in
// some wave, however slow: the ordering is what makes that affordable.
// Membership and order are both taken from measurement, not from which file looks cheap. The
// seconds below are one isolated run of each file under TEST_ENV; around half a second of each is
// process start, so a file marked 6s is doing five seconds of work.
//
// Two things decide a wave. Its cost is its slowest member, because a wave's files run at once.
// Its *size* matters as well: fifteen files spawned together measured 132s against 82s for the
// same fifteen in one process, because fifteen module graphs on sixteen cores thrash. So a wave
// holds at most eight files even where a ninth would be free on cost alone.
//
// A survivor pays every wave, which is the point of putting the expensive files last: only a
// mutant that nothing cheaper could see gets there.
const TEST_WAVES = [
  // ~2s. Small, and enough to kill a mutant in the configuration, JWT and codegen targets before
  // anything expensive starts.
  [
    "tests/jwt.test.ts", // 0s
    "tests/sha256.test.ts", // 1s
    "tests/cli.test.ts", // 1s
    "tests/property-codegen.test.ts", // 1s
    "tests/property-jwt.test.ts", // 1s
    "tests/serve.test.ts", // 2s
  ],
  // ~7s, and where most of `shared`, `client` and `server` dies: the model checkers and the
  // protocol's own unit tests.
  [
    "tests/core.test.ts", // 6s
    "tests/server.test.ts", // 6s
    "tests/client-integration.test.ts", // 6s
    "tests/exhaustive-model.test.ts", // 6s
    "tests/property-persistence.test.ts", // 6s
    "tests/http-transport.test.ts", // 6s
    "tests/property-convergence.test.ts", // 7s
    "tests/property-rejection.test.ts", // 7s
  ],
  // ~8s. The rest of the generated-history properties, plus the merge and facade paths.
  [
    "tests/property-conflict-reactivity.test.ts", // 7s
    "tests/property-row-lifecycle.test.ts", // 7s
    "tests/property-primitives.test.ts", // 7s
    "tests/diff3-queue.test.ts", // 7s
    "tests/property-scope-schema.test.ts", // 8s
    "tests/property-sql-safety.test.ts", // 8s
    "tests/property-world-model.test.ts", // 8s
    "tests/facade.test.ts", // 8s
    "tests/sqlite-adapter.test.ts", // 9s
  ],
  // ~15s. Transports, storage ports and durability.
  [
    "tests/worker-multitab.test.ts", // 7s
    "tests/web-storage.test.ts", // 7s
    "tests/typed-queries.test.ts", // 7s
    "tests/partial-push.test.ts", // 8s
    "tests/property-wasm-sqlite.test.ts", // 8s, and skips without a WebAssembly SQLite build
    "tests/websocket.test.ts", // 10s
    "tests/property-incremental-persistence.test.ts", // 10s
    "tests/durability.test.ts", // 15s
  ],
  // Half a minute or more each, reached only by a mutant every cheaper test missed.
  //
  // `property-crash.test.ts` spawns a process per generated history and is the only thing that
  // checks durability across a kill; `react.test.ts` and `demo.test.ts` drive the bindings and a
  // whole application over the client.
  //
  // `demo-issues.test.ts` and `todo-seed.test.ts` are deliberately absent. They assert seeded
  // content and rendered layout, so they fail when a demo's copy changes rather than when the
  // protocol does — and because the harness refuses to measure anything until the baseline is
  // green, a demo edit would stop mutation testing outright. `demo.test.ts` earns its place by
  // exercising sync itself rather than what the page happens to say. `trace-validation.test.ts`
  // checks the TLA+ spec rather than this source, and skips without TLC on PATH.
  [
    "tests/demo.test.ts", // 24s
    "tests/property-render.test.ts", // 25s
    "tests/react.test.ts", // 27s
    "tests/codegen.test.ts", // 27s
    "tests/property-socket.test.ts", // 33s
    "tests/property-ws-subscribe.test.ts", // 17s
    "tests/property-crash.test.ts", // 30s and up; spawns a process per history
  ],
];
const TEST_FILES = TEST_WAVES.flat();

// Resolved rather than shelled out to, so a wave costs one process and no shell.
const VITEST_BIN = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");

// Small run counts keep a mutant under a few seconds; the seed is pinned so a survivor list is
// reproducible rather than a function of whichever histories fast-check happened to draw.
const TEST_ENV = {
  WEFT_WORLD_RUNS: "40",
  WEFT_SCENARIO_RUNS: "30",
  WEFT_PROPERTY_RUNS: "100",
  WEFT_PROPERTY_SEED: "20260824",
};

// A mutant can turn a bounded loop into an unbounded one, so a wave gets a wall-clock budget.
//
// Per wave, not per run. A timeout is scored as a detection — the mutant changed behaviour
// enough to hang the suite — so a budget that a healthy run can exhaust on its own turns every
// survivor into a false detection and quietly inflates the score. Only a survivor reaches the
// last wave, so a whole-run budget is spent precisely where the answer matters most.
//
// It is generous against the slowest wave because sharded runs contend for the same cores, and a
// mutant timing out for want of a core rather than for want of a fixed point is not a detection
// either.
const WAVE_TIMEOUT_MS = 300_000;

const BINARY_REPLACEMENTS = new Map([
  ["<", [">=", "<="]],
  ["<=", [">", "<"]],
  [">", ["<=", ">="]],
  [">=", ["<", ">"]],
  ["===", ["!=="]],
  ["!==", ["==="]],
  ["==", ["!="]],
  ["!=", ["=="]],
  ["&&", ["||"]],
  ["||", ["&&"]],
  ["+", ["-"]],
  ["-", ["+"]],
  ["*", ["/"]],
  ["/", ["*"]],
  ["%", ["*"]],
  ["+=", ["-="]],
  ["-=", ["+="]],
]);

const METHOD_REPLACEMENTS = new Map([
  ["max", "min"],
  ["min", "max"],
  ["some", "every"],
  ["every", "some"],
  ["startsWith", "endsWith"],
  ["endsWith", "startsWith"],
]);

function collectMutants(file) {
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const mutants = [];

  const add = (node, replacement, operator, start = node.getStart(tree), end = node.getEnd()) => {
    const original = source.slice(start, end);
    if (original === replacement) return;
    const { line, character } = tree.getLineAndCharacterOfPosition(start);
    mutants.push({
      file,
      line: line + 1,
      column: character + 1,
      start,
      end,
      original,
      replacement,
      operator,
    });
  };

  const visit = (node) => {
    // Type positions and imports carry no runtime behaviour, so mutating them only produces
    // mutants the runtime cannot tell apart (or that fail to parse).
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;

    if (ts.isBinaryExpression(node)) {
      const token = node.operatorToken;
      for (const replacement of BINARY_REPLACEMENTS.get(token.getText(tree)) ?? []) {
        add(token, replacement, "binary-operator", token.getStart(tree), token.getEnd());
      }
      // `a ?? b` collapsed to `a` is how a missing default gets caught.
      if (token.kind === ts.SyntaxKind.QuestionQuestionToken) {
        add(node, node.left.getText(tree), "nullish-default");
      }
    }

    if (node.kind === ts.SyntaxKind.TrueKeyword) add(node, "false", "boolean-literal");
    if (node.kind === ts.SyntaxKind.FalseKeyword) add(node, "true", "boolean-literal");

    // `!x` -> `x` catches a guard that is never exercised in the negative.
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      add(node, node.operand.getText(tree), "negation-removal");
    }

    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      add(node, value === 0 ? "1" : "0", "numeric-literal");
      if (value !== 0) add(node, String(value + 1), "numeric-literal");
    }

    if (ts.isPropertyAccessExpression(node)) {
      const replacement = METHOD_REPLACEMENTS.get(node.name.text);
      if (replacement !== undefined) {
        add(node.name, replacement, "method-swap", node.name.getStart(tree), node.name.getEnd());
      }
    }

    // Forcing a branch either way is the highest-signal mutation there is: it asks whether the
    // condition is load-bearing at all, not merely whether its boundary is right.
    if (ts.isIfStatement(node)) {
      add(node.expression, "true", "condition-forced", node.expression.getStart(tree), node.expression.getEnd());
      add(node.expression, "false", "condition-forced", node.expression.getStart(tree), node.expression.getEnd());
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(tree, visit);
  mutants.sort((left, right) => left.start - right.start || left.replacement.localeCompare(right.replacement));
  return { source, mutants };
}

/**
 * One runner process per wave rather than one per file. Vitest runs the files it is given
 * concurrently itself, so spawning a process each only pays for a second startup per file, and
 * `--bail=1` reproduces what the old per-file `AbortController` did: the first failure ends the
 * wave instead of waiting the rest out.
 */
function runWave(wave, signal) {
  return new Promise((resolve) => {
    // `--silent=true` rather than a bare `--silent`: the flag takes an optional value, so the
    // bare form swallows the first test path after it as its argument.
    const child = spawn(process.execPath, [VITEST_BIN, "run", "--bail=1", "--silent=true", ...wave], {
      env: { ...process.env, ...TEST_ENV },
      stdio: "ignore",
      signal,
    });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Resolves as soon as one wave fails; the waves behind it are never started. */
async function runSuite() {
  const start = Date.now();
  for (const [index, wave] of TEST_WAVES.entries()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WAVE_TIMEOUT_MS);
    const waveStart = Date.now();
    try {
      const code = await runWave(wave, controller.signal);
      if (code !== 0) {
        const timedOut = Date.now() - waveStart >= WAVE_TIMEOUT_MS;
        return { killedBy: `wave ${index + 1}`, timedOut, ms: Date.now() - start };
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return { killedBy: undefined, timedOut: false, ms: Date.now() - start };
}

function parseArgs(argv) {
  const options = { list: false, limit: Infinity, only: undefined, shard: 1, shards: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") options.list = true;
    else if (arg === "--limit") options.limit = Number(argv[(index += 1)]);
    else if (arg === "--only") options.only = argv[(index += 1)];
    else if (arg === "--shard") {
      const [shard, shards] = argv[(index += 1)].split("/").map(Number);
      if (!shard || !shards || shard > shards) throw new Error("--shard wants k/n, 1-based");
      Object.assign(options, { shard, shards });
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/**
 * Refuses to run in a checkout whose workspace links point somewhere else. pnpm links workspace
 * packages by absolute path, at the root and again under each package, so a copied checkout goes
 * on resolving `weftdb/shared` back to the original tree: the mutation is written, the tests never
 * load it, every mutant "survives", and the score is a confident zero. Nothing about that failure
 * shows up in the output, which is why it is checked rather than assumed.
 */
function assertWorkspaceLinksAreLocal() {
  const root = realpathSync(process.cwd());
  const packages = readdirSync("packages");
  const scopes = ["node_modules", ...packages.map((name) => path.join("packages", name, "node_modules"))];
  const escaped = scopes.filter(existsSync).flatMap((scope) =>
    readdirSync(scope)
      .filter((entry) => packages.includes(entry))
      .map((entry) => ({ link: path.join(scope, entry), target: realpathSync(path.join(scope, entry)) }))
      .filter(({ target }) => !target.startsWith(root + path.sep)),
  );
  if (escaped.length > 0) {
    const detail = escaped.map(({ link, target }) => `  ${link} -> ${target}`).join("\n");
    throw new Error(`workspace links escape this checkout, so mutants would never be loaded:\n${detail}`);
  }
}

/**
 * Refuses to start beside another run in the same checkout.
 *
 * `--shard k/n` divides the mutant list; it does not divide the working tree, and the tree is
 * what a run mutates. Two shards started here would take turns rewriting the same files and
 * scoring each other's mutations, and the result would look like an ordinary survivor list
 * rather than nonsense. Shards belong in separate copies of the checkout, one run each.
 *
 * The lock names the process holding it, and a stale one from a run that was killed outright is
 * reported rather than silently cleared: whoever clears it should know a run ended badly, since
 * a killed run can also leave a mutated file behind.
 */
function claimCheckout() {
  const lock = path.join(process.cwd(), ".mutate-lock");
  if (existsSync(lock)) {
    throw new Error(
      `${lock} exists, so another mutation run owns this checkout.\n` +
        `It holds: ${readFileSync(lock, "utf8").trim()}\n` +
        "Shards need a copy of the checkout each — see Mutation Testing in TESTING.md.\n" +
        "If no run is active, check `git status` for a file left mutated, then delete the lock.",
    );
  }
  writeFileSync(lock, `pid ${process.pid} started ${new Date().toISOString()}\n`);
  return () => {
    if (existsSync(lock)) rmSync(lock);
  };
}

const options = parseArgs(process.argv.slice(2));
const targets = TARGETS.filter((file) => options.only === undefined || file.includes(options.only));
assertWorkspaceLinksAreLocal();
const releaseCheckout = options.list ? () => undefined : claimCheckout();
const originals = new Map(targets.map((file) => [file, readFileSync(file, "utf8")]));

const restoreAll = () => {
  for (const [file, source] of originals) writeFileSync(file, source);
  releaseCheckout();
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restoreAll();
    process.exit(1);
  });
}
process.on("uncaughtException", (error) => {
  restoreAll();
  throw error;
});

const all = targets.flatMap((file) => {
  const { mutants } = collectMutants(file);
  return mutants;
});

// Shards are interleaved rather than sliced into blocks: mutants are in source order, survivors
// cluster (a whole region the tests never look at), and contiguous blocks would hand one shard
// every expensive mutant while the others idled.
const planned = all.filter((_, index) => index % options.shards === options.shard - 1).slice(0, options.limit);
const shardLabel = options.shards === 1 ? "" : ` (shard ${options.shard}/${options.shards} of ${all.length})`;

if (options.list) {
  for (const mutant of planned) {
    console.log(
      `${mutant.file}:${mutant.line}:${mutant.column} ${mutant.operator} ${mutant.original} -> ${mutant.replacement}`,
    );
  }
  console.log(`${planned.length} mutants${shardLabel}`);
  process.exit(0);
}

console.log(
  `${planned.length} mutants${shardLabel} across ${targets.length} files, ${TEST_FILES.length} test files, ${availableParallelism()} cpus`,
);

const baseline = await runSuite();
if (baseline.killedBy !== undefined) {
  console.error(`baseline suite is not green (${baseline.killedBy}); fix that before measuring mutants`);
  process.exit(1);
}
console.log(`baseline green in ${(baseline.ms / 1000).toFixed(1)}s\n`);

const survived = [];
let killed = 0;
let timedOut = 0;

for (const [index, mutant] of planned.entries()) {
  const source = originals.get(mutant.file);
  writeFileSync(mutant.file, source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end));
  let result;
  try {
    result = await runSuite();
  } finally {
    writeFileSync(mutant.file, source);
  }

  const label = `${mutant.file}:${mutant.line}:${mutant.column} ${mutant.original} -> ${mutant.replacement}`;
  if (result.timedOut) {
    timedOut += 1;
    console.log(`[${index + 1}/${planned.length}] TIMEOUT  ${label}`);
  } else if (result.killedBy !== undefined) {
    killed += 1;
    console.log(`[${index + 1}/${planned.length}] killed   ${label}  (${result.killedBy})`);
  } else {
    survived.push(mutant);
    console.log(`[${index + 1}/${planned.length}] SURVIVED ${label}`);
  }
}

restoreAll();

// A timeout means the mutant changed behaviour enough to hang the suite, which is a detection,
// so it counts towards the score alongside outright failures.
const detected = killed + timedOut;
console.log(
  `\n${planned.length} mutants: ${detected} detected (${killed} killed, ${timedOut} timed out), ${survived.length} survived`,
);
console.log(`mutation score: ${((detected / planned.length) * 100).toFixed(1)}%\n`);
for (const mutant of survived) {
  console.log(
    `survivor ${mutant.file}:${mutant.line}:${mutant.column} [${mutant.operator}] ${mutant.original} -> ${mutant.replacement}`,
  );
}
