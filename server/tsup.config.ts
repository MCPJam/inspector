import { defineConfig } from "tsup";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(serverDir, "..");

export default defineConfig({
  entry: ["server/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: join(rootDir, "dist/server"),
  clean: true,
  bundle: true,
  minify: false,
  sourcemap: true,
  external: [
    // External packages that should not be bundled
    "@hono/node-server",
    "hono",
    "@mastra/mcp",
    "@modelcontextprotocol/sdk",
    "ai",
    "@ai-sdk/anthropic",
    "@ai-sdk/openai",
    "@ai-sdk/deepseek",
    "ollama-ai-provider",
    "zod",
    "zod-to-json-schema",
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
  ],
  noExternal: [
    // Force bundling of problematic packages
    "exit-hook",
  ],
  esbuildOptions(options) {
    options.platform = "node";
    options.mainFields = ["module", "main"];
    // Configure path alias for @/sdk
    options.alias = {
      "@/sdk": join(rootDir, "sdk/dist/index.js"),
    };
  },
});
