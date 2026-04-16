import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  banner: {
    js: "#!/usr/bin/env node",
  },
  sourcemap: true,
  clean: true,
  splitting: false,
  minify: false,
  treeshake: true,
});
