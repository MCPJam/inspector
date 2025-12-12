import { defineConfig } from "tsup";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sdkDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  cwd: sdkDir,
  entry: {
    index: join(sdkDir, "src/index.ts"),
    "mcp-client-manager/index": join(sdkDir, "src/mcp-client-manager/index.ts"),
    "telemetry/index": join(sdkDir, "src/telemetry/index.ts"),
    "launcher/index": join(sdkDir, "src/launcher/index.ts"),
    "vite/index": join(sdkDir, "src/vite/index.ts"),
  },
  outDir: join(sdkDir, "dist"),
  tsconfig: join(sdkDir, "tsconfig.json"),
  format: ["esm", "cjs"],
  sourcemap: true,
  dts: true,
  clean: true,
  splitting: false,
  target: "node18",
  shims: true, // Adds ESM shims for CJS (import.meta polyfill)
});
