import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

const here = import.meta.dirname;

/**
 * Every workspace package's subpath exports, pointed at the source files beside *this config*.
 *
 * A mutation run copies the project into a sandbox and mutates the copy. The tests import
 * `weftdb/client`, which pnpm links by absolute path back into the real checkout — so without
 * this the sandbox's mutated source is never the source that loads, every mutant survives, and
 * the run reports a confident 0%. Aliasing by the package's own `exports` map means the list
 * cannot drift from the package: it is read from the same file the resolver would have read.
 *
 * `import.meta.dirname` is what makes it work. This config is copied into the sandbox and run
 * from there, so in a sandbox the aliases point at the sandbox — and at the real tree otherwise.
 */
function workspaceAliases(): Array<{ find: RegExp; replacement: string }> {
  const roots = ["packages", "demos"].flatMap((group) =>
    readdirSync(path.join(here, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(group, entry.name)),
  );

  return roots.flatMap((root) => {
    const manifest = path.join(here, root, "package.json");
    let parsed: { name?: string; exports?: Record<string, string> };
    try {
      parsed = JSON.parse(readFileSync(manifest, "utf8")) as typeof parsed;
    } catch {
      return [];
    }
    const { name, exports } = parsed;
    if (name === undefined || exports === undefined) return [];
    return Object.entries(exports)
      .filter(([, target]) => typeof target === "string")
      .map(([subpath, target]) => ({
        find: subpath === "." ? new RegExp(`^${name}$`, "u") : new RegExp(`^${name}/${subpath.slice(2)}$`, "u"),
        replacement: path.join(here, root, target),
      }));
  });
}

// The suite as a mutation run wants it. The differences from the ordinary one are all about the
// answer being trustworthy rather than about speed.
export default mergeConfig(base, {
  resolve: { alias: workspaceAliases() },
  test: {
    exclude: [
      "**/node_modules/**",
      // These assert seeded content and rendered layout, so they fail when a demo's copy changes
      // rather than when the protocol does. A mutation run measures nothing until the baseline is
      // green, so leaving them in means a demo edit stops mutation testing outright.
      "tests/demo-issues.test.ts",
      "tests/todo-seed.test.ts",
      // Checks the TLA+ spec rather than this source, and skips without TLC on PATH.
      "tests/trace-validation.test.ts",
    ],
    // Lower run counts keep a mutant to a few seconds. The seed is pinned for a stronger reason:
    // per-test coverage records which tests reach a line on one run and reuses that on the next,
    // which is only sound if a property test draws the same histories both times.
    env: {
      WEFT_WORLD_RUNS: "40",
      WEFT_SCENARIO_RUNS: "30",
      WEFT_PROPERTY_RUNS: "100",
      WEFT_PROPERTY_SEED: "20260824",
    },
  },
});
