import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "mcp-client-manager/index": "src/mcp-client-manager/index.ts",
    "telemetry/index": "src/telemetry/index.ts",
  },
  format: ["esm", "cjs"],
  sourcemap: true,
  dts: true,
  clean: true,
  splitting: false,
  target: "es2019",
});
