import { defineConfig } from "vitest/config";
import path from "path";

const rootDir = path.resolve(__dirname, "..");
// The linked local SDK package can advertise ./browser before dist/browser.* exists.
const sdkBrowserEntry = path.resolve(rootDir, "../sdk/src/browser.ts");
const mcpSdkClientAuthEntry = path.resolve(
  rootDir,
  "node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js",
);
const mcpSdkSharedAuthEntry = path.resolve(
  rootDir,
  "node_modules/@modelcontextprotocol/sdk/dist/esm/shared/auth.js",
);

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx"],
    exclude: ["node_modules", "dist"],
    setupFiles: [path.resolve(__dirname, "src/test/setup.ts")],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["**/__tests__/**", "**/*.test.ts", "**/*.test.tsx"],
    },
  },
  resolve: {
    alias: {
      "@repo/assets": path.resolve(__dirname, "src/assets"),
      "@/shared": path.resolve(__dirname, "../shared"),
      "@": path.resolve(__dirname, "./src"),
      "@mcpjam/sdk/browser": sdkBrowserEntry,
      "@modelcontextprotocol/sdk/client/auth.js": mcpSdkClientAuthEntry,
      "@modelcontextprotocol/sdk/shared/auth.js": mcpSdkSharedAuthEntry,
    },
  },
});
