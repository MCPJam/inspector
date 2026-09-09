import { defineConfig } from "vitest/config";
import path from "path";

const rootDir = path.resolve(__dirname, "..");
const sdkIndexEntry = path.resolve(rootDir, "../sdk/src/index.ts");
const sdkOperationsEntry = path.resolve(rootDir, "../sdk/src/operations.ts");
const sdkSkillReferenceEntry = path.resolve(
  rootDir,
  "../sdk/src/skill-reference.ts",
);
const sdkMatchersEntry = path.resolve(rootDir, "../sdk/src/matchers.ts");
const sdkBrowserEntry = path.resolve(rootDir, "../sdk/src/browser.ts");
const sdkPredicatesEntry = path.resolve(
  rootDir,
  "../sdk/src/predicates/index.ts",
);
// The versioned contract — now the canonical home of the step union that
// `shared/steps.ts` re-exports. Needs its own alias BEFORE the bare
// `@mcpjam/sdk` entry below: a string `find` matches by prefix, so without it
// `@mcpjam/sdk/contract` would rewrite to `<sdk index>.ts/contract`.
const sdkContractEntry = path.resolve(rootDir, "../sdk/src/contract/index.ts");

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
      { find: "@mcpjam/sdk/matchers", replacement: sdkMatchersEntry },
      { find: "@mcpjam/sdk/browser", replacement: sdkBrowserEntry },
      { find: "@mcpjam/sdk/predicates", replacement: sdkPredicatesEntry },
      { find: "@mcpjam/sdk/contract", replacement: sdkContractEntry },
      { find: "@mcpjam/sdk", replacement: sdkIndexEntry },
      { find: "@/shared", replacement: path.resolve(__dirname, "./") },
    ],
  },
});
