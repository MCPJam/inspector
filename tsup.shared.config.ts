import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "shared/ci-runner.ts",
    "shared/config-schema.ts",
    "shared/junit-reporter.ts",
    "shared/mcp-utils.ts",
  ],
  format: ["esm"],
  target: "node20",
  outDir: "dist/shared",
  clean: true,
  bundle: true,
  minify: false,
  sourcemap: true,
  external: [
    "@mastra/mcp",
    "@mastra/core",
    "@ai-sdk/anthropic",
    "@ai-sdk/openai",
    "fast-xml-parser",
    "zod",
    "which",
  ],
  esbuildOptions(options) {
    options.platform = "node";
    options.mainFields = ["module", "main"];
  },
});

