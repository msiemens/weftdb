// Vite is here for two reasons only: it resolves the workspace `weftdb` package and the demo schema
// from source, and it serves the page under the headers a synchronous OPFS database wants.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** The repository root, which is where the workspace packages and node_modules actually live. */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: import.meta.dirname,
  server: {
    port: Number(process.env["WEFT_BENCH_PORT"] ?? 5180),
    // The page imports `weftdb` and `weftdb-demo-todo/schema` from outside this directory, and
    // Vite refuses to serve a file above its root unless the root is named here.
    fs: { allow: [ROOT] },
    // Cross-origin isolation is not strictly required for the SAH pool VFS, but asking for it
    // costs nothing here and buys two things worth having: the widest browser compatibility for
    // OPFS, and a `performance.now()` that is not deliberately coarsened — which matters when the
    // number being published is a sub-millisecond round trip.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    // The SQLite build locates its `.wasm` relative to its own module URL, and prebundling moves
    // the module without moving the file it looks for.
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
});
