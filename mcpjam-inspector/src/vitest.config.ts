import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
