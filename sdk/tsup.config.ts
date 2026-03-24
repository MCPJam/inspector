import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/skill-reference.ts"],
  external: ["@sentry/node"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  loader: { '.md': 'text' },
});
