import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node18",
  banner: {
    js: "#!/usr/bin/env node",
  },
  sourcemap: true,
  clean: true,
  splitting: false,
  minify: false,
  treeshake: true,
});
