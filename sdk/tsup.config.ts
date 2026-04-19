import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const here = dirname(fileURLToPath(import.meta.url));
const { version: SDK_VERSION } = JSON.parse(
  readFileSync(join(here, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/browser.ts",
    "src/worker.ts",
    "src/operations.ts",
    "src/skill-reference.ts",
  ],
  external: ["@sentry/node"],
  format: ["esm"],
  target: "node20",
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  loader: { '.md': 'text' },
  define: {
    __MCPJAM_SDK_VERSION__: JSON.stringify(SDK_VERSION),
  },
});
