// Flat config for ESLint 10. Type-aware rules are on for the TypeScript sources, which is what the
// strict tsconfig already assumes; the two hand-written .js/.mjs files opt back out below.
import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier/flat";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist",
      "states",
      "spec",
      ".weftdb-cli-test-*",
      ".weft-durability-*",
      "packages/*/src/generated",
      "demos/*/src/generated",
      // Astro's generated ambient types. Flat config does not skip dot-directories on its own,
      // and these are written by `astro sync`, not by hand.
      "docs/.astro",
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Not covered by tsconfig.json's `include`, but still worth linting.
          allowDefaultProject: ["vite.config.ts", "vitest.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `_` marks a binding that is deliberately unused — a positional argument that is skipped,
      // or the discarded half of a destructure.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // Interfaces the runtime hands us are frequently `void`-returning, and passing a
      // promise-returning handler to one is idiomatic rather than a mistake.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      // Vitest collects the promise a top-level `test(...)` returns and reports on it, so those
      // calls are not the unattended promises the rule is looking for.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "vitest",
              name: ["afterAll", "afterEach", "beforeAll", "beforeEach", "describe", "it", "suite", "test"],
            },
          ],
        },
      ],
      // `async` here is usually about conforming to an interface — a bench case's `run`, a
      // transport method with one synchronous implementation — not about awaiting something.
      "@typescript-eslint/require-await": "off",
      // §3.2: "no raw SQL in application code" is the point of routing every query through
      // Kysely's typed builder. `sql` is Kysely's own escape hatch back into raw strings, so
      // importing it would reopen exactly the hole the builder exists to close.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "kysely",
              importNames: ["sql"],
              message: "Raw SQL is banned (DESIGN.md §3.2) — build the query with Kysely's typed builder instead.",
            },
          ],
        },
      ],
    },
  },

  // The demos are the only React surface in the workspace.
  {
    files: ["demos/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // Node-side code: the CLI, the server, the test suite, the benchmarks, the build scripts.
  {
    files: [
      "bench/**",
      "scripts/**",
      "tests/**",
      "packages/weftdb-cli/**",
      "packages/weftdb/src/server/**",
      "packages/weftdb/src/codegen/**",
      "demos/*/dev.ts",
      "demos/shared/src/{dev,relay,relay-main}.ts",
      "*.config.{ts,js,mjs}",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Some tests assert that a call does *not* compile: an uncalled arrow under a
  // `@ts-expect-error` is the assertion, and evaluating it is beside the point.
  {
    files: ["tests/**"],
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },

  // Browser-side code: the client and the React binding. `src/shared` is in neither list because
  // it runs on both sides and may assume the globals of neither.
  {
    files: ["packages/weftdb/src/client/**", "packages/weftdb-react/**"],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // The docs site. Its config and data modules run in the build; what it ships to the browser is
  // bundled by Astro, so — unlike the old hand-served `site/` — it is modules throughout.
  {
    files: ["docs/**/*.{js,mjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["docs/src/scripts/**/*.js", "docs/src/demos/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // Plain JavaScript has no program to type-check against.
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Last, so it wins: turns off every rule that has an opinion about layout, which is Prettier's
  // job now. ESLint is left to say what the code means rather than what it looks like.
  prettier,
);
