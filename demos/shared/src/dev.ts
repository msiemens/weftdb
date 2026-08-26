// `pnpm dev` inside a demo: Vite, serving that demo's page.
//
// Driven through Vite's API rather than its binary, which keeps this working the same however the
// package manager invokes it.
import { resolve } from "node:path";

export interface DemoDevOptions {
  /** The demo package's directory, normally `import.meta.dirname` of its own `dev.ts`. */
  readonly root: string;
  /** What to print once the page is up. */
  readonly name: string;
}

export async function runDemoDev(options: DemoDevOptions): Promise<void> {
  const { createServer } = await import("vite");
  const page = await createServer({
    configFile: resolve(options.root, "vite.config.ts"),
    root: options.root,
  });

  await page.listen();
  page.printUrls();
  process.stdout.write(`\n${options.name}: open the printed URL in two tabs — each one is a device.\n\n`);
}
