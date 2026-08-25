// `pnpm demo:relay` — the shared relay on its own, for running the docs site or several demos
// against one server.
import { relayPort, startDemoRelay } from "./relay.ts";

const running = await startDemoRelay().catch((error: unknown) => {
  // A second relay fails here, and whatever it was started for then has no server behind it: the
  // page loads, every sync fails, and the socket error in the console says nothing about why.
  if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
    process.stderr.write(
      `weft demo: a relay is already listening on port ${relayPort()}.\n` +
        "  Stop the other one, or start this with WEFT_DEMO_RELAY_PORT set to a free port —\n" +
        "  and point whatever connects to it at the same port.\n",
    );
    process.exit(1);
  }
  throw error;
});

process.stdout.write(`weft demo relay listening on ${running.url}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void running.close().then(() => process.exit(0));
  });
}
