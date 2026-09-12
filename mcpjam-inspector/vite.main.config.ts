import { defineConfig, Plugin } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";
import { builtinModules } from "module";
import { hotRestart } from "./vite.dev-plugins";

/**
 * Module aliases for the main-process graph.
 *
 * Declared once, up here, because `externalizeBareImports` derives its
 * exclusion list from the keys: `@/shared/foo` is shaped exactly like a bare
 * package specifier, and externalizing it would emit a `require("@/shared/...")`
 * that resolves to nothing. There are ~350 of those imports in this graph.
 * Adding an alias below therefore protects it automatically.
 */
const ALIASES = {
  "@/shared": resolve(__dirname, "shared"),
} as const;

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

/**
 * Leave every bare package specifier out of the dev bundle.
 *
 * `src/main.ts` dynamically imports the whole embedded server, so this graph is
 * the server's graph too: 2008 modules and ~35MB of source, re-bundled on every
 * keystroke-triggered rebuild. Roughly 1100 of those modules and two thirds of
 * that source are third-party code that did not change. In dev the app runs
 * from the repo with `node_modules` right there, so a plain `require("ai")`
 * resolves at runtime and the bundler can skip all of it.
 *
 * This is dev-only by construction. The packaged app has no `node_modules` at
 * all -- electron-forge's vite plugin packs `.vite` and nothing else -- so the
 * packaging path must keep bundling dependencies, and does: `isDevRun` below is
 * `env.command === "serve"`, which forge flips to `"build"` in `prePackage`.
 *
 * Implemented as `resolveId` rather than `rollupOptions.external` on purpose.
 * Forge merges our config into its own with Vite's `mergeConfig`, which
 * CONCATENATES arrays; a function placed in `external` would be appended to
 * forge's array as an array element, where Rollup never calls it, and the
 * externalization would silently never happen.
 */
function externalizeBareImports(): Plugin {
  const aliasPrefixes = Object.keys(ALIASES);

  return {
    name: "mcpjam:externalize-bare-imports-in-dev",
    // `enforce: "pre"` is load-bearing, not stylistic. `resolveId` is
    // first-wins, and Vite's core `vite:resolve` plugin runs ahead of
    // normally-ordered user plugins -- it had already resolved every bare
    // specifier to an absolute path in node_modules, so this hook was called
    // with ids it correctly declined and externalization silently did nothing
    // (the dev bundle stayed at ~20MB). "pre" also lands us AFTER the alias
    // plugins, which is what we want: `@/shared/...` arrives already rewritten
    // to an absolute path.
    enforce: "pre",
    resolveId(source, importer) {
      // No importer means this is an entry point. `build.lib.entry` is
      // "src/main.ts", which is shaped like a bare specifier and would
      // otherwise be externalized -- producing an empty bundle.
      if (!importer) return null;
      // Relative and absolute ids are our own source. `../server/app.js` in
      // particular must stay internal: keeping it a real chunk is what defers
      // its evaluation until after the port probe has set `SERVER_PORT`
      // (see `inlineDynamicImports` below).
      if (source.startsWith(".") || source.startsWith("/")) return null;
      // Rollup virtual modules, and Windows absolute paths (`C:\...`, `C:/...`).
      if (source.startsWith("\0") || /^[a-zA-Z]:[\\/]/.test(source))
        return null;
      // Aliases that merely look like packages.
      if (aliasPrefixes.some((p) => source === p || source.startsWith(`${p}/`)))
        return null;
      // `node:`-prefixed builtins and any other protocol-ish id. Builtins are
      // external anyway; other protocols are not ours to claim.
      if (/^[a-zA-Z][a-zA-Z0-9.+-]*:/.test(source)) return null;
      // Node subpath imports. There are none in this graph today, but one is
      // resolved relative to its OWNING package's package.json -- externalizing
      // it would emit a `require("#x")` from `.vite/build/`, where that mapping
      // does not exist. Bundle them instead.
      if (source.startsWith("#")) return null;

      // Everything else is a bare specifier. Externalize ALL of them rather
      // than a curated list: a partial list is a dual-package hazard, where one
      // copy of a package is bundled and another required at runtime. The
      // concrete instance here is `@ai-sdk/provider-utils` (1.53MB), imported
      // directly but not declared as a dependency.
      return { id: source, external: true };
    },
  };
}

/**
 * Report where a rebuild's time actually goes, gated on
 * `MCPJAM_ELECTRON_DEV_TIMING=1`.
 *
 * Kept after the work that motivated it, because it is the only instrument
 * available the next time this gets slow. The split that matters is graph
 * construction (resolve + load + transform, which externalization shrinks)
 * versus render (codegen + sourcemap, which `sourcemap: false` shrinks) --
 * without it you cannot tell which lever moved.
 *
 * `process.stderr.write`, not `console.*`: forge runs these builds inside a
 * Listr task renderer with `logLevel: 'silent'`, which eats stdout writes, and
 * `AGENTS.md` bans bare `console.*` besides.
 */
function buildTiming(label: string): Plugin {
  let startedAt = 0;
  let graphDoneAt = 0;
  let build = 0;

  return {
    name: "mcpjam:build-timing",
    buildStart() {
      startedAt = Date.now();
      build += 1;
    },
    buildEnd() {
      graphDoneAt = Date.now();
      process.stderr.write(
        `[timing:${label}] build #${build} graph done in ${graphDoneAt - startedAt}ms\n`,
      );
    },
    writeBundle() {
      const now = Date.now();
      process.stderr.write(
        `[timing:${label}] build #${build} render+map in ${now - graphDoneAt}ms ` +
          `(total ${now - startedAt}ms)\n`,
      );
    },
  };
}

// https://vitejs.dev/config
export default defineConfig((env) => {
  // Forge passes its full `configEnv` through `loadConfigFromFile`, so this is
  // the authoritative signal and not a guess: `ViteConfigGenerator` sets
  // `command: isProd ? "build" : "serve"`, and `VitePlugin`'s `prePackage` hook
  // sets `isProd = true`. NODE_ENV cannot be used for this -- Vite's own
  // `resolveConfig` sets `NODE_ENV=production` in the forge process whenever it
  // is unset, which is the same trap that produced the blank dev window.
  const isDevRun = env.command === "serve";

  // Escape hatch: take the packaged path verbatim in dev. For bisecting a
  // "works packaged, breaks in dev" report, which is the failure mode
  // externalization can introduce.
  const bundleDepsInDev = process.env.MCPJAM_ELECTRON_DEV_BUNDLE_DEPS === "1";
  const externalizeDeps = isDevRun && !bundleDepsInDev;

  // 47MB of sourcemap was regenerated on every dev rebuild for nothing: maps
  // are consumed only by `forge.config.ts`'s `packageAfterCopy` hook, which
  // runs on package/make, never on start. Shipped symbolication is unaffected.
  // Escape hatch for stepping through main in a debugger.
  const sourcemap =
    !isDevRun || process.env.MCPJAM_ELECTRON_DEV_SOURCEMAP === "1";

  return {
    plugins: [
      copySandboxProxy(),
      ...(externalizeDeps ? [externalizeBareImports()] : []),
      ...(process.env.MCPJAM_ELECTRON_DEV_TIMING === "1"
        ? [buildTiming("main")]
        : []),
      // Forge rebuilds this bundle on save but never restarts the process that
      // is running it; `hotRestart` supplies the missing half.
      ...(isDevRun ? [hotRestart("main")] : []),
    ],
    resolve: {
      alias: { ...ALIASES },
      mainFields: ["module", "jsnext:main", "jsnext"],
    },
    build: {
      // Main-process traces need the same symbolication as the renderer;
      // uploaded to `inspector-electron` by the release workflows.
      sourcemap,
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
          // `ws`'s optional native accelerators. Vite resolves an absent optional
          // peer dep to a stub module whose body THROWS, and Rollup evaluates that
          // module eagerly — outside the `try { require(...) } catch {}` that `ws`
          // wraps around the probe — so the throw escapes and takes down the whole
          // embedded server at import time. Keeping them external restores a real
          // runtime `require()` that `ws` can catch, which is precisely the "no
          // native masker" path `src/ws-native-fallback.ts` already forces.
          "bufferutil",
          "utf-8-validate",
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
          // Required by `externalizeBareImports`, and only meaningful with it.
          // Rollup's default for CJS output is `interop: "default"`, which
          // assumes `require(x)` hands back the default export. For an ESM-only
          // dependency under Node's `require(esm)` it hands back the namespace
          // instead, so `import fixPath from "fix-path"` (server/app.ts) would
          // bind the namespace object and `fixPath()` would throw -- silently
          // breaking PATH repair for every spawned MCP server. "auto" emits the
          // runtime check that picks the right one.
          //
          // Set only on the dev path so the packaged bundle stays
          // byte-identical. It costs nothing there: prod externalizes only
          // `electron`, the native addons and builtins, all of which are CJS
          // where "default" is already correct.
          ...(externalizeDeps ? { interop: "auto" as const } : {}),
        },
      },
    },
  };
});
