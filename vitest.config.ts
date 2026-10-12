import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file boots its own Postgres (PGlite, WebAssembly). A cold
    // start under parallel load can take a few seconds, more than vitest's
    // 5-second default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
