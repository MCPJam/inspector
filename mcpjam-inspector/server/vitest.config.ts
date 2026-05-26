import { defineConfig } from "vitest/config";
import path from "path";
import tsconfigPaths from "vite-tsconfig-paths";

const rootDir = path.resolve(__dirname, "..");
const sdkIndexEntry = path.resolve(rootDir, "../sdk/src/index.ts");
const sdkOperationsEntry = path.resolve(rootDir, "../sdk/src/operations.ts");
const sdkSkillReferenceEntry = path.resolve(
  rootDir,
  "../sdk/src/skill-reference.ts",
);
const sdkModelFactoryEntry = path.resolve(
  rootDir,
  "../sdk/src/model-factory.ts",
);
const sdkMatchersEntry = path.resolve(rootDir, "../sdk/src/matchers.ts");

export default defineConfig({
  define: {
    __MCPJAM_SDK_VERSION__: JSON.stringify("test"),
  },
  plugins: [
    tsconfigPaths(),
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
    include: ["**/__tests__/**/*.test.ts", "**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    server: {
      deps: {
        inline: [
          "@mcpjam/sdk",
          "@mcpjam/sdk/operations",
          "@mcpjam/sdk/model-factory",
          "@mcpjam/sdk/matchers",
        ],
      },
    },
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
    alias: [
      {
        find: "@mcpjam/sdk/skill-reference",
        replacement: sdkSkillReferenceEntry,
      },
      { find: "@mcpjam/sdk/operations", replacement: sdkOperationsEntry },
      { find: "@mcpjam/sdk/model-factory", replacement: sdkModelFactoryEntry },
      { find: "@mcpjam/sdk/matchers", replacement: sdkMatchersEntry },
      { find: "@mcpjam/sdk", replacement: sdkIndexEntry },
    ],
  },
});
