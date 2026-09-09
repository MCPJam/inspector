import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "fs";
import { electronBuildSurface } from "./shared/sentry-config";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8"),
);
const appVersion = packageJson.version || "1.0.0";

// @mcpjam/chat-ui and @mcpjam/widget-react publish from dist, but the release
// workflow builds only `-w @mcpjam/inspector`, so their dist never exists when
// electron-forge runs the renderer build. Resolve them from source so the
// desktop build never depends on a chat-ui / widget-react build (mirrors the
// source aliases in client/vite.config.ts that keep the web build working).
const chatUiEntry = resolve(__dirname, "../chat-ui/src/index.ts");
const chatUiThreadHelpersEntry = resolve(
  __dirname,
  "../chat-ui/src/thread-helpers.ts",
);
const chatUiTraceEntry = resolve(__dirname, "../chat-ui/src/trace.ts");
const widgetReactEntry = resolve(__dirname, "../widget-react/src/index.ts");

// https://vitejs.dev/config
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, __dirname, "");

  return {
    envDir: __dirname, // Load env files from project root (absolute path)
    envPrefix: "VITE_", // Only load VITE_ prefixed vars
    plugins: [react(), tailwindcss()],
    root: "./client",
    resolve: {
      alias: {
        "@repo/assets": resolve(__dirname, "./client/src/assets"),
        "@/shared": resolve(__dirname, "./shared"),
        "@": resolve(__dirname, "./client/src"),
        // More specific subpaths must precede the bare alias (first match wins).
        "@mcpjam/chat-ui/thread-helpers": chatUiThreadHelpersEntry,
        "@mcpjam/chat-ui/trace": chatUiTraceEntry,
        "@mcpjam/chat-ui": chatUiEntry,
        "@mcpjam/widget-react": widgetReactEntry,
      },
    },
    server: {
      fs: {
        allow: [resolve(__dirname, "./client"), resolve(__dirname, "./shared")],
      },
      proxy: {
        "/api": {
          target: "http://localhost:6274",
          changeOrigin: true,
        },
        // Proxy WorkOS API calls during Electron local dev to avoid browser CORS
        // issues and match the web client Vite config behavior.
        "/user_management": {
          target: "https://api.workos.com",
          changeOrigin: true,
          secure: true,
        },
        // PostHog same-origin relay (server/routes/relay.ts) — matches the
        // web client Vite config; without it Electron dev requests to /relay
        // fall through to Vite's SPA fallback and return index.html with 200.
        "/relay": {
          target: "http://localhost:6274",
          changeOrigin: true,
        },
        // /tlm is the same relay on its edge-safe alias prefix (see
        // RELAY_MOUNT_PREFIXES in server/routes/relay.ts).
        "/tlm": {
          target: "http://localhost:6274",
          changeOrigin: true,
        },
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      // Sentry `dist`, matching the `--dist` that forge.config.ts's
      // packageAfterCopy hook uploads `.vite/renderer` under. This config only
      // ever builds the Electron renderer, and forge builds it on the machine
      // that packages it, so the build host's platform IS the target's.
      __BUILD_SURFACE__: JSON.stringify(electronBuildSurface(process.platform)),
    },
    build: {
      // Desktop stack traces were unsymbolicated: the renderer build emitted
      // no source maps at all, so every Electron issue in Sentry showed
      // minified frames. The release workflows upload these to
      // `inspector-client` and the maps are not shipped in the installer.
      sourcemap: true,
    },
  };
});
