import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Journal persistence tests write files; run test files one at a time to keep them deterministic.
    fileParallelism: false,
    reporters: ["default"],
  },
});
