import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../moneygraph/web",
    emptyOutDir: true,
    rollupOptions: { output: { manualChunks: { graph: ["cytoscape"] } } },
  },
  server: { proxy: { "/api": "http://127.0.0.1:8765" } },
});
