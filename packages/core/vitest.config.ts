import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/all.test.ts"],
    testTimeout: 60000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 70,
        branches: 60
      }
    }
  }
});
