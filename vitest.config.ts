import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Pin the suite to mock mode so it's deterministic regardless of the dev
    // .env (vitest loads .env, so running the app in VITE_MODEL_MODE=live would
    // otherwise flip mode-default assertions). Live paths are covered by tests
    // that call liveRouter directly or pass an explicit modelMode override.
    env: { VITE_MODEL_MODE: "mock" },
  },
  resolve: {
    alias: {
      "@contracts": fileURLToPath(new URL("./contracts", import.meta.url)),
    },
  },
});
