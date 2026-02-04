import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const clientDir = fileURLToPath(new URL(".", import.meta.url));
const rootDir = path.resolve(clientDir, "..");

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(path.resolve(rootDir, "package.json"), "utf-8"),
);
const appVersion = packageJson.version;

// https://vitejs.dev/config/
export default defineConfig({
  root: clientDir,
  envDir: rootDir,
  plugins: [
    react(),
    tailwindcss(),
    sentryVitePlugin({
      org: "mcpjam-gh",
      project: "inspector-client",
      authToken: process.env.SENTRY_AUTH_TOKEN,
      telemetry: false,
      sourcemaps: {
        assets: ["../dist/client/assets/**"],
        filesToDeleteAfterUpload: ["../dist/client/assets/**/*.map"],
      },
    }),
  ],
  resolve: {
    alias: {
      "@/shared": path.resolve(clientDir, "../shared"),
      "@": path.resolve(clientDir, "./src"),
      // Force React resolution to prevent conflicts with @mcp-ui/client
      react: path.resolve(clientDir, "../node_modules/react"),
      "react-dom": path.resolve(clientDir, "../node_modules/react-dom"),
      "@mcp-ui/client": path.resolve(
        clientDir,
        "../node_modules/@mcp-ui/client",
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
    // Force re-optimization to clear any cached conflicts
    force: process.env.FORCE_OPTIMIZE === "true",
  },
  server: {
    // Listen on all interfaces so both localhost and 127.0.0.1 work
    // Required for SEP-1865 different-origin sandbox proxy
    host: true,
    proxy: {
      "/api": {
        target: "http://localhost:6274",
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
      // Proxy WorkOS API calls during local dev to avoid browser CORS errors
      "/user_management": {
        target: "https://api.workos.com",
        changeOrigin: true,
        secure: true,
      },
      ...(() => {
        const siteUrlFromEnv = process.env.VITE_CONVEX_SITE_URL;
        const cloudUrl = process.env.VITE_CONVEX_URL || "";
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
});
