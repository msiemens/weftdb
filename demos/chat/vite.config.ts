import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const RELAY_PORT = Number(process.env["WEFT_DEMO_RELAY_PORT"] ?? 8787);
const PAGE_PORT = Number(process.env["WEFT_DEMO_PORT"] ?? 5174);

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    port: PAGE_PORT,
    // The page talks to the relay at a same-origin path, so the browser needs no CORS and the
    // demo needs no second token for the dev server. `ws` carries the sync socket's upgrade
    // through the same path, which is the transport this demo is about.
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${RELAY_PORT}`,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/api/u, ""),
      },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
