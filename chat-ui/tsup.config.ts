import { defineConfig } from "tsup";

// Tier A: a single public entrypoint. The transcript renderer and its
// supporting types/helpers are all re-exported from `src/index.ts`.
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/thread-helpers.ts",
    "src/trace.ts",
    "src/trace-timeline.ts",
  ],
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  // React / AI SDK are peer deps — never bundle them.
  external: ["react", "react-dom", "react/jsx-runtime", "ai", "@ai-sdk/react"],
});
