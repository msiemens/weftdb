import { defineConfig } from "vitest/config";

// The suite runs against the workspace sources directly — `weftdb`'s exports map points at
// `.ts` files, so there is no build step here any more than there was under `node --test`.
export default defineConfig({
  test: {
    include: ["tests/*.test.ts"],
    // A process per file rather than a worker thread. Several of these files spawn children,
    // open SQLite bindings, or lean on `BroadcastChannel` and Web Locks — all of which behave
    // like themselves in a process and not always in a thread.
    pool: "forks",
    // `node --test` imposes no deadline, and this suite has files that legitimately run for half
    // a minute: the crash properties spawn a process per generated history, and the model
    // checkers walk a state space. A five-minute ceiling still catches a hang without turning a
    // slow-but-healthy file into a failure.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
