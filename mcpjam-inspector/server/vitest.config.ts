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
        inline: ["@mcpjam/sdk", "@mcpjam/sdk/operations"],
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
      { find: "@mcpjam/sdk", replacement: sdkIndexEntry },
    ],
  },
});
