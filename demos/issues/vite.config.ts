import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// A port of its own, so this page and the other demos can be served at the same time.
const PAGE_PORT = Number(process.env["WEFT_DEMO_PORT"] ?? 5175);

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: PAGE_PORT },
  // `wa-sqlite` is imported by the storage worker and loads its own `.wasm` beside it;
  // excluding it from prebundling keeps that relative load pointing at the file Vite serves.
  optimizeDeps: { exclude: ["wa-sqlite"] },
  worker: { format: "es" },
  build: { outDir: "dist", emptyOutDir: true },
});
