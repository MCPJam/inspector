import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { telemetrySourceCatalogsPlugin } from "../client/vite-telemetry-catalog";
const resolve = (value: string) => path.resolve(__dirname, value);
export default defineConfig({
  root: resolve("fixtures/local-harness-browser"),
  publicDir: resolve("../client/public"),
  plugins: [telemetrySourceCatalogsPlugin(), react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify("local-harness-fixture"),
    __BUILD_SHA__: JSON.stringify("fixture"),
    __BUILD_SURFACE__: JSON.stringify("web"),
    __MCPJAM_SDK_VERSION__: JSON.stringify("fixture"),
    "import.meta.env.VITE_DISABLE_POSTHOG_LOCAL": JSON.stringify("true"),
    "import.meta.env.VITE_DISABLE_SENTRY": JSON.stringify("true"),
  },
  resolve: {
    alias: {
      "@mcpjam/chat-ui/json-tokens": resolve(
        "../../chat-ui/src/json-tokens.ts",
      ),
      "@mcpjam/chat-ui/thread-helpers": resolve(
        "../../chat-ui/src/thread-helpers.ts",
      ),
      "@mcpjam/chat-ui/trace": resolve("../../chat-ui/src/trace.ts"),
      "@mcpjam/chat-ui": resolve("../../chat-ui/src/index.ts"),
      "@mcpjam/widget-react": resolve("../../widget-react/src/index.ts"),
      "@/shared": resolve("../shared"),
      "@": resolve("../client/src"),
      "@app": resolve(".."),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: 6316,
    strictPort: true,
    fs: { allow: [resolve("../..")] },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:6315",
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
