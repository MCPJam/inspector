import { defineConfig } from "tsup";

// Tier B widget runtime. Phase 3c ships a single public entrypoint exposing the
// `WidgetHost` React context + `useWidgetHost()` contract that the inspector
// feeds via its adapter. The interactive renderer cluster folds in here in 3d.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  // React is a peer dep — never bundle it. (No `ai`/`@ai-sdk/react`: the widget
  // runtime does not import them — audited in Phase 3c.)
  external: ["react", "react-dom", "react/jsx-runtime"],
});
