import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/__tests__/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["**/*.ts"],
      exclude: ["**/__tests__/**", "**/*.test.ts", "vitest.config.ts"],
    },
  },
  resolve: {
    alias: {
      "@/shared": path.resolve(__dirname, "./"),
    },
  },
});
