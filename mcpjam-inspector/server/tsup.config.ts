import { defineConfig } from "tsup";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const serverDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(serverDir, "..");

// Baked at build time so the bundled server can tag Sentry events with a
// release. There is no package.json next to `dist/server/index.js` at runtime,
// and in dev (tsx, no bundler) the define is absent — `server/sentry.ts` falls
// back to `npm_package_version`.
const packageVersion = JSON.parse(
  readFileSync(join(rootDir, "package.json"), "utf8"),
).version as string;

export default defineConfig({
  entry: ["server/index.ts"],
  define: {
    "process.env.MCPJAM_INSPECTOR_VERSION": JSON.stringify(packageVersion),
  },
  format: ["esm"],
  target: "node22",
  outDir: join(rootDir, "dist/server"),
  clean: true,
  bundle: true,
  minify: false,
  sourcemap: true,
  external: [
    // External packages that should not be bundled
    "@hono/node-server",
    "hono",
    "ai",
    // The AI SDK *harness* packages bundle their own `ai@7-canary` (a regular
    // dependency, so it installs nested and never collides with the server's
    // top-level `ai@6`). Keep them external so they're required from
    // node_modules at runtime — bundling them would make esbuild rewrite their
    // internal `import "ai"` to the external (v6) `ai` above and break the v7
    // harness.
    "@ai-sdk/harness",
    "@ai-sdk/harness-claude-code",
    "@ai-sdk/anthropic",
    "@ai-sdk/openai",
    "@ai-sdk/deepseek",
    "ollama-ai-provider",
    "zod",
    "clsx",
    "tailwind-merge",
    // Keep environment PATH fixers external (these may use CJS internals and dynamic requires)
    "fix-path",
    "shell-path",
    "execa",
    // Sentry packages with native modules must remain external
    "@sentry/node",
    // node-pty (local computer terminal) is an OPTIONAL dependency with a
    // native addon: it may be absent entirely (no build toolchain on an npx
    // install) and can never be bundled. Keep it external so the runtime
    // `import("node-pty")` resolves from node_modules — and cleanly fails to,
    // degrading the terminal off, when it isn't there. See utils/computers/local-pty.ts.
    "node-pty",
    // evals-cli dependencies
    "posthog-node",
    "@openrouter/ai-sdk-provider",
    // Packages with dynamic requires
    "chalk",
    "supports-color",
    // XML-DSig stack for the XAA SAML mock IdP (transitive via @mcpjam/sdk).
    // These are CommonJS with dynamic `require()` calls, so bundling them into
    // the ESM server output makes esbuild emit a throwing `__require` shim
    // ("Dynamic require of \"util\" is not supported"). Keep them external so
    // they're required from node_modules at runtime, like chalk/supports-color.
    "xml-crypto",
    "@xmldom/xmldom",
    "xpath",
    // Headless-browser harness deps (eval browser-render): resolved at runtime,
    // never bundled. `playwright` is a direct dep (auto-external); `playwright-core`
    // is its transitive fallback (`await import("playwright-core")`) and must be
    // listed explicitly, otherwise esbuild follows it into `bidiOverCdp` and
    // fails on the optional `chromium-bidi` dependency.
    "playwright",
    "playwright-core",
    // Reached only from `webmcp-inspector/electron-webview-provider.ts`, and
    // only through a runtime `await import("electron")` gated on ELECTRON_APP.
    // Inside the desktop app the server runs in the Electron main process, so
    // the import resolves; this bundle is the STANDALONE server, where it never
    // runs — but esbuild would still try to follow the specifier and fail the
    // build outright. External keeps the specifier intact for the one runtime
    // that can satisfy it.
    "electron",
  ],
  noExternal: [
    // Force bundling of problematic packages
    "exit-hook",
    "@mcpjam/sdk",
    "@mcpjam/sdk/browser",
    "@mcpjam/sdk/operations",
    "@mcpjam/sdk/model-factory",
    "@mcpjam/sdk/matchers",
    "@mcpjam/sdk/predicates",
    "@mcpjam/sdk/contract",
    "@mcpjam/sdk/host-config/internal",
    "@mcpjam/sdk/host-config/templates",
    "@mcpjam/sdk/platform",
    "@mcpjam/sdk/public-api",
    "@mcpjam/sdk/host-compat",
    "@mcpjam/sdk/plugin-bundle",
    "@mcpjam/sdk/oauth/node",
    "@mcpjam/sdk/widget-runtime",
  ],
  esbuildOptions(options) {
    options.platform = "node";
    options.mainFields = ["module", "main"];
    // Configure path aliases for local SDK build outputs, including subpaths.
    options.alias = {
      // Specific subpaths BEFORE the bare alias — shared/xaa.ts re-exports XAA
      // primitives from the browser entry, so the server bundle must resolve it.
      "@mcpjam/sdk/browser": join(rootDir, "../sdk/dist/browser.js"),
      // Node-only SSRF guard + DNS-pinned transport, used by the connection
      // flow's discovery and validation steps.
      //
      // MUST be listed before the bare alias, like every subpath here: the bare
      // entry is a PREFIX replacement, so without its own line this specifier
      // rewrites to `sdk/dist/index.js/oauth/node` and fails to resolve. The
      // failure only appears once something actually IMPORTS the module —
      // esbuild never resolves an unreferenced file, so this stayed invisible
      // while the discovery preflight was dead code.
      "@mcpjam/sdk/oauth/node": join(rootDir, "../sdk/dist/oauth/node.js"),
      "@mcpjam/sdk": join(rootDir, "../sdk/dist/index.js"),
      "@mcpjam/sdk/operations": join(rootDir, "../sdk/dist/operations.js"),
      "@mcpjam/sdk/model-factory": join(rootDir, "../sdk/dist/model-factory.js"),
      "@mcpjam/sdk/matchers": join(rootDir, "../sdk/dist/matchers.js"),
      "@mcpjam/sdk/predicates": join(rootDir, "../sdk/dist/predicates/index.js"),
      "@mcpjam/sdk/contract": join(rootDir, "../sdk/dist/contract/index.js"),
      "@mcpjam/sdk/host-config/internal": join(
        rootDir,
        "../sdk/dist/host-config/internal.js",
      ),
      "@mcpjam/sdk/host-config/templates": join(
        rootDir,
        "../sdk/dist/host-config/templates/index.js",
      ),
      "@mcpjam/sdk/platform": join(rootDir, "../sdk/dist/platform/index.js"),
      "@mcpjam/sdk/public-api": join(
        rootDir,
        "../sdk/dist/public-api/index.js",
      ),
      "@mcpjam/sdk/host-compat": join(
        rootDir,
        "../sdk/dist/host-compat/index.js",
      ),
      "@mcpjam/sdk/plugin-bundle": join(
        rootDir,
        "../sdk/dist/plugin-bundle/index.js",
      ),
      "@mcpjam/sdk/widget-runtime": join(
        rootDir,
        "../sdk/dist/widget-runtime/index.js",
      ),
    };
  },
});
