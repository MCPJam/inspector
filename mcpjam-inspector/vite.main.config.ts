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
    lib: {
      entry: "src/main.ts",
      fileName: () => "[name].cjs", // need to use .cjs(other than .js), because the package.json type is set to module
      formats: ["cjs"],
    },
    rollupOptions: {
      external: [
        "electron",
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
