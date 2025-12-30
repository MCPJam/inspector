import { defineConfig } from "tsup";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const libDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(libDir, "..");

export default defineConfig({
  cwd: libDir,
  entry: {
    "lib/launcher/index": join(libDir, "launcher/index.ts"),
    "lib/vite/index": join(libDir, "vite/index.ts"),
  },
  outDir: join(rootDir, "dist"),
  tsconfig: join(libDir, "tsconfig.json"),
  format: ["esm", "cjs"],
  sourcemap: true,
  dts: true,
  clean: false, // Don't clean - other builds output here too
  splitting: false,
  target: "node18",
  shims: true,
});
