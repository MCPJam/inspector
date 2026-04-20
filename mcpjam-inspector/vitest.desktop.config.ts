import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["node_modules", "dist", "client", "server", "shared"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
