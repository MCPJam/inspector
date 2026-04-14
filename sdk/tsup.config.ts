import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    browser: "src/browser.ts",
    operations: "src/operations.ts",
    "skill-reference": "src/skill-reference.ts",
    auth: "src/auth/index.ts",
  },
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
