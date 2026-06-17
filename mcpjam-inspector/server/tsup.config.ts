import { defineConfig } from "tsup";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(serverDir, "..");

export default defineConfig({
  entry: ["server/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: join(rootDir, "dist/server"),
  clean: true,
  bundle: true,
  minify: false,
  sourcemap: true,
  external: [
    // External packages that should not be bundled
    "@hono/node-server",
    "hono",
    "ai",
    // The AI SDK *harness* packages bundle their own `ai@7-canary` (a regular
    // dependency, so it installs nested and never collides with the server's
    // top-level `ai@6`). Keep them external so they're required from
    // node_modules at runtime — bundling them would make esbuild rewrite their
    // internal `import "ai"` to the external (v6) `ai` above and break the v7
    // harness.
    "@ai-sdk/harness",
    "@ai-sdk/harness-claude-code",
    "@ai-sdk/anthropic",
    "@ai-sdk/openai",
    "@ai-sdk/deepseek",
    "ollama-ai-provider",
    "zod",
    "clsx",
    "tailwind-merge",
    // Keep environment PATH fixers external (these may use CJS internals and dynamic requires)
    "fix-path",
    "shell-path",
    "execa",
    // Sentry packages with native modules must remain external
    "@sentry/node",
    // evals-cli dependencies
    "posthog-node",
    "@openrouter/ai-sdk-provider",
    // Packages with dynamic requires
    "chalk",
    "supports-color",
    // Headless-browser harness deps (eval browser-render): resolved at runtime,
    // never bundled. `playwright` is a direct dep (auto-external); `playwright-core`
    // is its transitive fallback (`await import("playwright-core")`) and must be
    // listed explicitly, otherwise esbuild follows it into `bidiOverCdp` and
    // fails on the optional `chromium-bidi` dependency.
    "playwright",
    "playwright-core",
  ],
  noExternal: [
    // Force bundling of problematic packages
    "exit-hook",
    "@mcpjam/sdk",
    "@mcpjam/sdk/operations",
    "@mcpjam/sdk/model-factory",
    "@mcpjam/sdk/matchers",
    "@mcpjam/sdk/predicates",
    "@mcpjam/sdk/host-config/internal",
    "@mcpjam/sdk/platform",
  ],
  esbuildOptions(options) {
    options.platform = "node";
    options.mainFields = ["module", "main"];
    // Configure path aliases for local SDK build outputs, including subpaths.
    options.alias = {
      "@mcpjam/sdk": join(rootDir, "../sdk/dist/index.js"),
      "@mcpjam/sdk/operations": join(rootDir, "../sdk/dist/operations.js"),
      "@mcpjam/sdk/model-factory": join(rootDir, "../sdk/dist/model-factory.js"),
      "@mcpjam/sdk/matchers": join(rootDir, "../sdk/dist/matchers.js"),
      "@mcpjam/sdk/predicates": join(rootDir, "../sdk/dist/predicates/index.js"),
      "@mcpjam/sdk/host-config/internal": join(
        rootDir,
        "../sdk/dist/host-config/internal.js",
      ),
      "@mcpjam/sdk/platform": join(rootDir, "../sdk/dist/platform/index.js"),
    };
  },
});
