import { defineConfig } from "vitest/config";

// `weftdb`'s exports map points at `.ts` files, so the suite runs against the sources with no
// build step.
export default defineConfig({
  test: {
    include: ["tests/*.test.ts"],
    // A process per file. Several of these files spawn children, open SQLite bindings, or lean on
    // `BroadcastChannel` and Web Locks, which do not all behave like themselves in a thread.
    pool: "forks",
    // Generous because some files legitimately run for half a minute: the crash properties spawn
    // a process per generated history, and the model checkers walk a state space.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
