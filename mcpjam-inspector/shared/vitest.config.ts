import { defineConfig } from "vitest/config";
import path from "path";

const rootDir = path.resolve(__dirname, "..");
const sdkIndexEntry = path.resolve(rootDir, "../sdk/src/index.ts");
const sdkOperationsEntry = path.resolve(rootDir, "../sdk/src/operations.ts");
const sdkSkillReferenceEntry = path.resolve(
  rootDir,
  "../sdk/src/skill-reference.ts",
);

export default defineConfig({
  define: {
    __MCPJAM_SDK_VERSION__: JSON.stringify("test"),
  },
  plugins: [
    {
      name: "raw-markdown-for-sdk-tests",
      transform(source, id) {
        if (!id.endsWith(".md")) {
          return null;
        }

        return {
          code: `export default ${JSON.stringify(source)};`,
          map: null,
        };
      },
    },
  ],
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
    alias: [
      {
        find: "@mcpjam/sdk/skill-reference",
        replacement: sdkSkillReferenceEntry,
      },
      { find: "@mcpjam/sdk/operations", replacement: sdkOperationsEntry },
      { find: "@mcpjam/sdk", replacement: sdkIndexEntry },
      { find: "@/shared", replacement: path.resolve(__dirname, "./") },
    ],
  },
});
