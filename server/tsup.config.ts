import { defineConfig } from "tsup";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync } from "node:fs";

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
  async onSuccess() {
    // Copy static assets to dist folder
    // Since the bundle is at dist/server/index.js, __dirname resolves to dist/server/
    // so the HTML file needs to be at dist/server/sandbox-proxy.html
    const distDir = join(rootDir, "dist/server");
    mkdirSync(distDir, { recursive: true });
    copyFileSync(
      join(serverDir, "routes/mcp/sandbox-proxy.html"),
      join(distDir, "sandbox-proxy.html"),
    );
  },
});
