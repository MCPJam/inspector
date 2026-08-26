import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { resolveClientBuildSurface } from "../shared/sentry-config";

const clientDir = fileURLToPath(new URL(".", import.meta.url));
const rootDir = path.resolve(clientDir, "..");
const clientOutDir = path.resolve(rootDir, "dist/client");
// `sentryVitePlugin` globs its sourcemap paths with no `cwd`, so they resolve
// against `process.cwd()` — `mcpjam-inspector/` under `npm run build:client -w
// @mcpjam/inspector` — and not against the Vite root. The relative globs that
// used to live here (`../dist/client/assets/**`) therefore resolved to the
// REPO root, one level above the real output, and matched nothing. The plugin
// reports that as a warning, not an error, so the build stayed green while
// uploading no maps and deleting none. Absolute, and POSIX-separated because
// glob does not accept Windows separators in a pattern.
const clientOutGlobBase = clientOutDir.replace(/\\/g, "/");
const workspaceNodeModulesDir = path.resolve(rootDir, "../node_modules");
// The linked local SDK package can advertise ./browser before dist/browser.* exists.
const sdkBrowserEntry = path.resolve(rootDir, "../sdk/src/browser.ts");
// Same rationale: @mcpjam/sdk advertises ./host-config/internal via its package
// exports, but a clean checkout has no dist/host-config/internal.* until
// `npm run build -w @mcpjam/sdk` runs. The full `npm run build` chain builds
// the SDK first, but `npm run dev:client` / `build:client` in isolation
// (and Codex's `sdk/dist`-removed repro) fail Rollup resolution without
// this alias.
const sdkHostConfigInternalEntry = path.resolve(
  rootDir,
  "../sdk/src/host-config/internal.ts",
);
// Node-safe host-template seeds. Aliased to source (mirrors the internal alias
// above) so clean checkout builds resolve it without a prior
// `npm run build -w @mcpjam/sdk`.
const sdkHostConfigTemplatesEntry = path.resolve(
  rootDir,
  "../sdk/src/host-config/templates/index.ts",
);
// Host catalog helpers must resolve from source in dev. Otherwise the client
// can use stale SDK dist output and miss newly-derived template fields.
const sdkHostCompatEntry = path.resolve(
  rootDir,
  "../sdk/src/host-compat/index.ts",
);
// Tier B Phase 2: @mcpjam/sdk/widget-runtime resolves to dist via package
// exports; alias it to source so dev:client / build:client resolve it without a
// prior `npm run build -w @mcpjam/sdk` (mirrors the SDK subpath aliases above).
// Versioned evaluation contract: browser-safe by construction (its SHA-256 is
// pure-JS @noble/hashes, not node:crypto and not async Web Crypto), aliased to
// source like its siblings so a clean checkout builds without a prior
// `npm run build -w @mcpjam/sdk`.
const sdkContractEntry = path.resolve(rootDir, "../sdk/src/contract/index.ts");
const sdkWidgetRuntimeEntry = path.resolve(
  rootDir,
  "../sdk/src/widget-runtime/index.ts",
);
// Shared OpenAI plugin-bundle parser (browser-safe by design). Resolved from
// source so dev/build never depend on a prior SDK build (mirrors the SDK
// subpath aliases above).
const sdkPluginBundleEntry = path.resolve(
  rootDir,
  "../sdk/src/plugin-bundle/index.ts",
);
// @mcpjam/chat-ui publishes from dist, but a clean checkout has no
// chat-ui/dist until it is built. Resolve the package from source so the
// inspector's dev/build/typecheck/test never depend on a chat-ui build.
const chatUiEntry = path.resolve(rootDir, "../chat-ui/src/index.ts");
// Focused subpaths resolved from source. They avoid the package's
// renderer/markdown component graph (not React-free — thread-helpers still
// exposes lucide icon components via getToolStateMeta).
const chatUiThreadHelpersEntry = path.resolve(
  rootDir,
  "../chat-ui/src/thread-helpers.ts",
);
const chatUiTraceEntry = path.resolve(rootDir, "../chat-ui/src/trace.ts");
// Tier B Phase 3c: @mcpjam/widget-react publishes from dist, but a clean
// checkout has no widget-react/dist until it is built. Resolve from source so
// the inspector's dev/build/typecheck/test never depend on a widget-react build
// (mirrors the chat-ui / sdk source aliases above).
const widgetReactEntry = path.resolve(rootDir, "../widget-react/src/index.ts");
// Bypass stale Vite optimized deps for MCP SDK auth helpers by resolving
// directly to the installed ESM entrypoints.
const mcpSdkClientAuthEntry = path.resolve(
  workspaceNodeModulesDir,
  "@modelcontextprotocol/sdk/dist/esm/client/auth.js",
);
const mcpSdkSharedAuthEntry = path.resolve(
  workspaceNodeModulesDir,
  "@modelcontextprotocol/sdk/dist/esm/shared/auth.js",
);

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(path.resolve(rootDir, "package.json"), "utf-8"),
);
const appVersion = packageJson.version;

// The SDK's own `define` (see `sdk/tsup.config.ts`), MIRRORED here because
// `@mcpjam/sdk/browser` is aliased to `src/browser.ts` above — this build
// compiles the SDK from source, so nothing else replaces the token. The SDK
// reads it defensively and falls back to "unknown", so a missing define is no
// longer fatal; supplying it is what makes the value truthful rather than a
// placeholder. `sdk/vitest.config.ts` mirrors it for the same reason.
const sdkPackageJson = JSON.parse(
  readFileSync(path.resolve(rootDir, "../sdk/package.json"), "utf-8"),
);
const sdkVersion = sdkPackageJson.version;
// Fail the build rather than ship a placeholder. The token exists so a
// conformance report can name the build that produced it; a define of
// `undefined` would silently land the SDK on its "unknown" fallback, and
// "unknown" in a stamp is worse than a build that stopped and said why.
if (typeof sdkVersion !== "string" || sdkVersion.trim() === "") {
  throw new Error(
    "sdk/package.json has no usable `version`, so __MCPJAM_SDK_VERSION__ cannot be defined",
  );
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, "");

  // Sentry `dist`. Set by whichever pipeline runs this build; a checkout that
  // names no surface is `local`, and an unrecognised one throws — same
  // reasoning as the `sdkVersion` guard above. Only the surfaces that build
  // `dist/client` are accepted; the Electron renderer has its own config.
  const buildSurface = resolveClientBuildSurface(env.MCPJAM_BUILD_SURFACE);

  return {
    root: clientDir,
    envDir: rootDir,
    // Vite would derive this from the nearest package.json, so every dev server
    // started from this package shares one dep cache. The OAuth debugger e2e
    // runs two at once, and the second one's re-optimization answers the first
    // one's in-flight chunk request with `504 (Outdated Optimize Dep)` — the
    // page never mounts. `CLIENT_CACHE_DIR` gives each server its own.
    cacheDir: path.resolve(
      rootDir,
      env.CLIENT_CACHE_DIR || "node_modules/.vite",
    ),
    plugins: [
      react(),
      tailwindcss(),
      sentryVitePlugin({
        org: "mcpjam-gh",
        project: "inspector-client",
        authToken: env.SENTRY_AUTH_TOKEN,
        telemetry: false,
        // Must match the `release` the SDK inits with (`__APP_VERSION__`).
        // Without this the plugin invents its own release name from git and
        // the uploaded source maps never resolve against runtime events.
        release: { name: appVersion, dist: buildSurface },
        sourcemaps: {
          assets: [`${clientOutGlobBase}/assets/**`],
          filesToDeleteAfterUpload: [`${clientOutGlobBase}/assets/**/*.map`],
        },
      }),
    ],
    resolve: {
      alias: {
        "@repo/assets": path.resolve(clientDir, "src/assets"),
        "@/shared": path.resolve(clientDir, "../shared"),
        "@": path.resolve(clientDir, "./src"),
        // More specific subpaths must precede the bare alias (first match wins).
        "@mcpjam/chat-ui/thread-helpers": chatUiThreadHelpersEntry,
        "@mcpjam/chat-ui/trace": chatUiTraceEntry,
        "@mcpjam/chat-ui": chatUiEntry,
        "@mcpjam/widget-react": widgetReactEntry,
        "@mcpjam/sdk/browser": sdkBrowserEntry,
        "@mcpjam/sdk/contract": sdkContractEntry,
        "@mcpjam/sdk/widget-runtime": sdkWidgetRuntimeEntry,
        "@mcpjam/sdk/plugin-bundle": sdkPluginBundleEntry,
        "@mcpjam/sdk/host-compat": sdkHostCompatEntry,
        "@mcpjam/sdk/host-config/templates": sdkHostConfigTemplatesEntry,
        "@mcpjam/sdk/host-config/internal": sdkHostConfigInternalEntry,
        "@modelcontextprotocol/sdk/client/auth.js": mcpSdkClientAuthEntry,
        "@modelcontextprotocol/sdk/shared/auth.js": mcpSdkSharedAuthEntry,
        // Resolve shared frontend deps from the workspace root now that installs
        // are hoisted to a single lockfile-managed node_modules tree.
        react: path.resolve(workspaceNodeModulesDir, "react"),
        "react-dom": path.resolve(workspaceNodeModulesDir, "react-dom"),
        "@mcp-ui/client": path.resolve(
          workspaceNodeModulesDir,
          "@mcp-ui/client",
        ),
      },
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      // Explicitly include React runtimes to ensure proper resolution
      include: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
      exclude: [
        "@modelcontextprotocol/sdk/client/auth.js",
        "@modelcontextprotocol/sdk/shared/auth.js",
        "@mcpjam/sdk/host-compat",
      ],
      // Force re-optimization to clear any cached conflicts
      force: env.FORCE_OPTIMIZE === "true",
    },
    server: {
      // Listen on all interfaces so both localhost and 127.0.0.1 work
      // Required for SEP-1865 different-origin sandbox proxy
      host: true,
      port: env.CLIENT_PORT ? parseInt(env.CLIENT_PORT, 10) : 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: env.VITE_API_BASE_URL || "http://localhost:6274",
          changeOrigin: true,
          secure: false,
          ws: true,
          configure: (proxy, _options) => {
            proxy.on("error", (err, _req, _res) => {
              // proxy error
            });
            proxy.on("proxyReq", (proxyReq, req, _res) => {
              // proxy request
            });
            proxy.on("proxyRes", (_proxyRes, _req, _res) => {
              // no-op
            });
          },
        },
        // Proxy AuthKit calls through the local server so refresh tokens stay
        // in an HttpOnly local session cookie instead of browser storage.
        "/user_management": {
          target: env.VITE_API_BASE_URL || "http://localhost:6274",
          changeOrigin: true,
          secure: false,
        },
        // PostHog same-origin relay (server/routes/relay.ts). In dev the
        // client origin is Vite, not the Hono server, so /relay must be
        // proxied or analytics/flags silently break in dev only.
        "/relay": {
          target: env.VITE_API_BASE_URL || "http://localhost:6274",
          changeOrigin: true,
          secure: false,
        },
        // /tlm is the same relay on its edge-safe alias prefix (see
        // RELAY_MOUNT_PREFIXES in server/routes/relay.ts).
        "/tlm": {
          target: env.VITE_API_BASE_URL || "http://localhost:6274",
          changeOrigin: true,
          secure: false,
        },
        ...(() => {
          const siteUrlFromEnv = env.VITE_CONVEX_SITE_URL;
          const cloudUrl = env.VITE_CONVEX_URL || "";
          const derivedSiteUrl = cloudUrl
            ? cloudUrl.replace(".convex.cloud", ".convex.site")
            : "";
          const target = siteUrlFromEnv || derivedSiteUrl;
          if (!target) return {} as Record<string, any>;
          return {
            "/backend": {
              target,
              changeOrigin: true,
              secure: true,
              rewrite: (path: string) => path.replace(/^\/backend/, ""),
            },
          } as Record<string, any>;
        })(),
      },
      fs: {
        allow: [".."],
      },
    },
    build: {
      outDir: clientOutDir,
      sourcemap: true,
      emptyOutDir: true,
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __BUILD_SURFACE__: JSON.stringify(buildSurface),
      __MCPJAM_SDK_VERSION__: JSON.stringify(sdkVersion),
    },
  };
});
