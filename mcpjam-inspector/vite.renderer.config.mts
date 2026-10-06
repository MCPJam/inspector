import { defineConfig, loadEnv, type Plugin } from "vite";
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
const chatUiJsonTokensEntry = resolve(
  __dirname,
  "../chat-ui/src/json-tokens.ts",
);
const widgetReactEntry = resolve(__dirname, "../widget-react/src/index.ts");

const NO_RENDERER_ENTRY = "virtual:mcpjam-no-renderer";

/**
 * Resolves the packaging build's only input to an empty module.
 *
 * forge's renderer list is a fixed array and its builds have no off switch, so
 * the cheapest way to not build the client is to hand it one empty chunk.
 */
function emptyRendererEntry(): Plugin {
  const resolved = `\0${NO_RENDERER_ENTRY}`;
  return {
    name: "mcpjam:empty-renderer-entry",
    resolveId: (source) => (source === NO_RENDERER_ENTRY ? resolved : null),
    load: (id) => (id === resolved ? "export {};" : null),
  };
}

// https://vitejs.dev/config
export default defineConfig(({ command, mode }) => {
  // `electron-forge package` / `make` run this config with command "build",
  // and nothing it produces is ever used. The packaged window loads the
  // embedded server, which serves `dist/client` from `npm run build`
  // (`createMainWindow` in src/main.ts), and this output lands under
  // `client/.vite/renderer` (root is ./client), outside the `.vite` folder
  // forge packs. Rebuilding the whole client here ran alongside the main bundle
  // and starved it: locally the main build went from 39s to 12s without it,
  // and the packed `.vite` is byte-identical either way.
  // Dev (`electron-forge start`) is command "serve" and is unaffected.
  if (command === "build") {
    return {
      root: "./client",
      plugins: [emptyRendererEntry()],
      build: {
        copyPublicDir: false,
        rollupOptions: { input: NO_RENDERER_ENTRY },
      },
    };
  }

  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, __dirname, "");

  // The embedded server this window talks to. `scripts/electron-dev.mjs` picks
  // a free port once (6274, or the next free one when another Inspector holds
  // it) and passes it to BOTH this renderer dev server and the main process
  // through SERVER_PORT, so the window always reaches its own server rather
  // than whichever `npm run dev` happens to own 6274.
  const serverPort = /^\d+$/.test(process.env.SERVER_PORT ?? "")
    ? process.env.SERVER_PORT
    : "6274";
  const serverOrigin = `http://localhost:${serverPort}`;

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
        // A subpath missing here does NOT fail to resolve — it falls through to
        // the bare alias and becomes `chat-ui/src/index.ts/<subpath>`, which
        // only breaks at `vite build`. This map is a fourth copy (client's
        // vite/vitest configs and tsconfig hold the others); every subpath
        // belongs in all four.
        "@mcpjam/chat-ui/json-tokens": chatUiJsonTokensEntry,
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
          target: serverOrigin,
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
          target: serverOrigin,
          changeOrigin: true,
        },
        // /tlm is the same relay on its edge-safe alias prefix (see
        // RELAY_MOUNT_PREFIXES in server/routes/relay.ts).
        "/tlm": {
          target: serverOrigin,
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
  };
});
