import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 30_000,
    reporters: ["verbose"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "text"],
      // Floors for a fresh clone, which is what CI has: without the supplied rubric
      // the marking tests skip and line coverage is about 35%. With it, about 82%.
      // Raise these when coverage rises; they exist to catch it falling.
      thresholds: {
        lines: 34,
        statements: 34,
        functions: 30,
        branches: 65,
      },
    },
  },
});
