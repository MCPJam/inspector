import { defineConfig } from "vitest/config";
import path from "path";

const rootDir = path.resolve(__dirname, "..");
const workspaceNodeModulesDir = path.resolve(rootDir, "../node_modules");
// The linked local SDK package can advertise ./browser before dist/browser.* exists.
const sdkBrowserEntry = path.resolve(rootDir, "../sdk/src/browser.ts");
const sdkSkillReferenceEntry = path.resolve(
  rootDir,
  "../sdk/src/skill-reference.ts",
);
const sdkMatchersEntry = path.resolve(rootDir, "../sdk/src/matchers.ts");
// Same rationale as sdkBrowserEntry: the workspace-linked @mcpjam/sdk advertises
// ./host-config/internal via its package exports, but a clean checkout has no
// dist/host-config/internal.* until `npm run build -w @mcpjam/sdk` runs. The
// inspector's pretest doesn't build the SDK (root-level `npm test` does), so
// without this alias, `npm test -w @mcpjam/inspector` fails to resolve the
// import in client-config-v2.ts → Failed to resolve import "@mcpjam/sdk/host-config/internal".
const sdkHostConfigInternalEntry = path.resolve(
  rootDir,
  "../sdk/src/host-config/internal.ts",
);
const mcpSdkClientAuthEntry = path.resolve(
  workspaceNodeModulesDir,
  "@modelcontextprotocol/sdk/dist/esm/client/auth.js",
);
const mcpSdkSharedAuthEntry = path.resolve(
  workspaceNodeModulesDir,
  "@modelcontextprotocol/sdk/dist/esm/shared/auth.js",
);

export default defineConfig({
  define: {
    __MCPJAM_SDK_VERSION__: JSON.stringify("test"),
    // Mirrors the Vite build-time constant injected into `client-templates`
    // and `mcp-apps-renderer`. Tests that exercise the host-style seed
    // (e.g. via the render-gate scope wrapper) need this defined or the
    // codex/mcpjam templates throw a `ReferenceError`.
    __APP_VERSION__: JSON.stringify("test"),
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
    alias: [
      {
        find: "@mcpjam/sdk/skill-reference",
        replacement: sdkSkillReferenceEntry,
      },
      { find: "@mcpjam/sdk/browser", replacement: sdkBrowserEntry },
      { find: "@mcpjam/sdk/matchers", replacement: sdkMatchersEntry },
      {
        find: "@mcpjam/sdk/host-config/internal",
        replacement: sdkHostConfigInternalEntry,
      },
      {
        find: "@modelcontextprotocol/sdk/client/auth.js",
        replacement: mcpSdkClientAuthEntry,
      },
      {
        find: "@modelcontextprotocol/sdk/shared/auth.js",
        replacement: mcpSdkSharedAuthEntry,
      },
      { find: "@repo/assets", replacement: path.resolve(__dirname, "src/assets") },
      { find: "@/shared", replacement: path.resolve(__dirname, "../shared") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
});
