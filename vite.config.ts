import { defineConfig } from "vite";

// Bundles the relay into one file so the runtime image carries no package manager, no
// node_modules and no source tree — just Node and `dist/server.mjs`.
export default defineConfig({
  build: {
    ssr: "packages/weftdb/src/server/main.ts",
    outDir: "dist",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: true,
    rollupOptions: {
      // The SQLite executor stays a separate chunk on purpose: it is imported lazily so an
      // in-memory deployment never loads the binding (which some Node releases keep behind
      // a flag).
      output: { entryFileNames: "server.mjs", format: "esm" },
    },
  },
  ssr: {
    target: "node",
    // Workspace packages are part of the server, not third-party dependencies to resolve at
    // runtime, so they are bundled in. Node builtins stay external.
    noExternal: true,
  },
});
