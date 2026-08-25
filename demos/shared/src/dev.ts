// `pnpm dev` inside a demo — the relay and that demo's page together, because a demo is only
// interesting when there is something for the tabs to sync through.
//
// Both run in this one process, and Vite is driven through its API rather than its binary, which
// keeps this working the same however the package manager invokes it.
import { resolve } from "node:path";
import { relayPort, startDemoRelay } from "./relay.ts";

export interface DemoDevOptions {
  /** The demo package's directory, normally `import.meta.dirname` of its own `dev.ts`. */
  readonly root: string;
  /** What to print once the page is up. */
  readonly name: string;
}

export async function runDemoDev(options: DemoDevOptions): Promise<void> {
  await startDemoRelay().catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
      process.stderr.write(
        `weft demo: a relay is already listening on port ${relayPort()}.\n` +
          "  That is fine if it is the shared one — this page will use it. Stop the other\n" +
          "  `dev` if it is a second demo serving its own page on this port.\n",
      );
      return;
    }
    throw error;
  });

  const { createServer } = await import("vite");
  const page = await createServer({
    configFile: resolve(options.root, "vite.config.ts"),
    root: options.root,
  });

  await page.listen();
  page.printUrls();
  process.stdout.write(`\n${options.name}: open the printed URL in two tabs — each one is a device.\n\n`);
}
