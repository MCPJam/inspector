import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const clientDir = fileURLToPath(new URL(".", import.meta.url));
const rootDir = path.resolve(clientDir, "..");
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
// above) so the client's delegating `client-templates.ts` resolves it without a
// prior `npm run build -w @mcpjam/sdk`.
const sdkHostConfigTemplatesEntry = path.resolve(
  rootDir,
  "../sdk/src/host-config/templates/index.ts",
);
// Tier B Phase 2: @mcpjam/sdk/widget-runtime resolves to dist via package
// exports; alias it to source so dev:client / build:client resolve it without a
// prior `npm run build -w @mcpjam/sdk` (mirrors the SDK subpath aliases above).
const sdkWidgetRuntimeEntry = path.resolve(
  rootDir,
  "../sdk/src/widget-runtime/index.ts",
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

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, "");

  return {
    root: clientDir,
    envDir: rootDir,
    plugins: [
      react(),
      tailwindcss(),
      sentryVitePlugin({
        org: "mcpjam-gh",
        project: "inspector-client",
        authToken: env.SENTRY_AUTH_TOKEN,
        telemetry: false,
        sourcemaps: {
          assets: ["../dist/client/assets/**"],
          filesToDeleteAfterUpload: ["../dist/client/assets/**/*.map"],
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
        "@mcpjam/sdk/widget-runtime": sdkWidgetRuntimeEntry,
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
      outDir: path.resolve(rootDir, "dist/client"),
      sourcemap: true,
      emptyOutDir: true,
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
  };
});
