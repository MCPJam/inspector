import { defineConfig, Plugin } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";
import { builtinModules } from "module";

// Plugin to copy sandbox proxy HTML files to the Electron main build output
function copySandboxProxy(): Plugin {
  const filesToCopy = [
    {
      src: "server/routes/apps/mcp-apps/sandbox-proxy.html",
      dest: "sandbox-proxy.html",
    },
  ];

  return {
    name: "copy-sandbox-proxy",
    writeBundle(options) {
      const outDir = options.dir || ".vite/build";
      mkdirSync(outDir, { recursive: true });
      for (const file of filesToCopy) {
        copyFileSync(resolve(__dirname, file.src), resolve(outDir, file.dest));
      }
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  plugins: [copySandboxProxy()],
  resolve: {
    alias: {
      "@/shared": resolve(__dirname, "shared"),
    },
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
  build: {
    // Main-process traces need the same symbolication as the renderer;
    // uploaded to `inspector-electron` by the release workflows.
    sourcemap: true,
    lib: {
      entry: "src/main.ts",
      fileName: () => "[name].cjs", // need to use .cjs(other than .js), because the package.json type is set to module
      formats: ["cjs"],
    },
    rollupOptions: {
      external: [
        "electron",
        // `src/main.ts` dynamically imports the WHOLE server, so the server's
        // optional native dep is in this bundle's graph. node-pty must stay
        // external or the main-process build fails outright; at runtime the
        // packaged app has no node_modules (electron-forge's vite plugin packs
        // only `.vite`), so the require fails and the local terminal degrades
        // off by design. Real Electron terminal support (extraResource +
        // custom resolution) is a scoped follow-up.
        "node-pty",
        // Same story for Playwright, reached via `await import("playwright")`
        // / `await import("playwright-core")` in browser-rendering-setup, the
        // MCP App browser harness, and the WebMCP provider. Those literal
        // dynamic imports make Rollup pull all of playwright-core into this
        // bundle, and since 1.62 its inlined chokidar has a bare
        // `require("fsevents")` that the commonjs plugin resolves to a native
        // `.node` binary — which Rollup then tries to parse as JS and dies on
        // ("Unexpected character"), breaking every macOS release build. Keep
        // it external: as with node-pty the packaged app has no node_modules,
        // so the import rejects and the browser-backed paths degrade off,
        // exactly as they already did (a rolled-up playwright-core could never
        // have found its wasm/registry assets at runtime anyway).
        "playwright",
        "playwright-core",
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
      output: {
        // Do NOT inline dynamic imports. main.ts uses `await import(...)`
        // for `../server/app.js` so that `process.env.SERVER_PORT` (set
        // after the port probe) is picked up by `server/config.ts` at
        // module evaluation. With `inlineDynamicImports: true`, Rollup
        // hoists that module to the top of the bundle and evaluates it
        // eagerly at startup — defeating the fix for PR #2418's
        // fallback-port-not-synced regression. Keeping dynamic imports
        // as separate chunks preserves the deferral semantics.
        inlineDynamicImports: false,
        // Pin every emitted JS file to `.cjs`. package.json has
        // `"type": "module"`, so Node treats unknown `.js` files as ESM.
        // The entry is already `.cjs` via `lib.fileName`, and Vite's
        // current lib-mode default happens to give chunks `.cjs` too,
        // but that's implicit. Make it explicit so a future Vite version
        // can't silently emit a `.js` chunk that main.cjs's
        // `require(...)` would then fail to load with "exports is not
        // defined".
        entryFileNames: "[name].cjs",
        chunkFileNames: "[name]-[hash].cjs",
      },
    },
  },
});
