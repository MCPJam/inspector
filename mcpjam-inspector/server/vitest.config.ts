import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/__tests__/**/*.test.ts", "**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: [
        "services/**/*.ts",
        "middleware/**/*.ts",
        "utils/**/*.ts",
        "routes/**/*.ts",
      ],
      exclude: ["**/__tests__/**", "**/*.test.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      "@/sdk": path.resolve(__dirname, "../sdk/src"),
      "@/shared": path.resolve(__dirname, "../shared"),
    },
  },
});
