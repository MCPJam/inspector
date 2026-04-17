import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const { version: SDK_VERSION } = JSON.parse(
  readFileSync(join(here, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  // Mirror the tsup `define` so __MCPJAM_SDK_VERSION__ resolves when vitest
  // runs src/ directly (tsup's define only applies to the built output).
  define: {
    __MCPJAM_SDK_VERSION__: JSON.stringify(SDK_VERSION),
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
    },
  },
});
