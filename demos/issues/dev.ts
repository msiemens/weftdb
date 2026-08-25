// `pnpm dev` — this demo's page, with the shared relay behind it.
import { runDemoDev } from "weftdb-demo-shared/dev";

await runDemoDev({ root: import.meta.dirname, name: "weft issues demo" });
