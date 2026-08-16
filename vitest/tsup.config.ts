import { defineConfig } from "tsup";

// A thin wrapper around vitest's globals and `@mcpjam/sdk`'s runner. Both are
// resolved at the CONSUMER — vitest because it is a peer dep (bundling a copy
// would give the wrapper a different `describe` than the one running the file,
// and the tests would register into nothing), the SDK because a bundled copy
// would carry its own EvalTest class and break `instanceof` against the
// caller's.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  external: ["vitest", /^@mcpjam\/sdk/],
});
