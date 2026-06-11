import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  resolve: {
    alias: {
      "@contracts": fileURLToPath(new URL("./contracts", import.meta.url)),
    },
  },
});
