import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const PAGE_PORT = Number(process.env["WEFT_DEMO_PORT"] ?? 5173);

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: PAGE_PORT },
  // `@sqlite.org/sqlite-wasm` is imported by the storage worker and loads its own `.wasm` beside
  // it; excluding it from prebundling keeps that relative load pointing at the file Vite serves.
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  build: { outDir: "dist", emptyOutDir: true },
});
