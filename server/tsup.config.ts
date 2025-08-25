import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "../dist/server",
  clean: true,
  bundle: true,
  minify: false,
  sourcemap: true,
  external: [
    // External packages that should not be bundled
    "@hono/node-server",
    "hono",
    "@mastra/mcp",
    "@mastra/core",
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
  ],
  noExternal: [
    // Force bundling of problematic packages
    "exit-hook",
  ],
  esbuildOptions(options) {
    options.platform = "node";
    options.mainFields = ["module", "main"];
  },
});
