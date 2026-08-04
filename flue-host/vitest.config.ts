import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The golden test boots the real Flue runtime (sqlite + local sandbox).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
