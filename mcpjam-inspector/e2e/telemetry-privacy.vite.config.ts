import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { realpathSync } from "node:fs";

/**
 * Serves the telemetry privacy harness (fixtures/telemetry-privacy) with
 * telemetry ON, as the hosted bundle has it: hosted mode, PostHog enabled,
 * Sentry enabled. Nothing reaches a vendor — the spec intercepts both
 * transports in the browser.
 */
export default defineConfig({
  root: path.resolve(__dirname, "fixtures/telemetry-privacy"),
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify("0.0.0-telemetry-harness"),
    __BUILD_SHA__: JSON.stringify("telemetry-harness"),
    __BUILD_SURFACE__: JSON.stringify("web"),
    __MCPJAM_SDK_VERSION__: JSON.stringify("0.0.0"),
    "import.meta.env.VITE_MCPJAM_HOSTED_MODE": JSON.stringify("true"),
    "import.meta.env.VITE_DISABLE_POSTHOG_LOCAL": JSON.stringify("false"),
    "import.meta.env.VITE_DISABLE_SENTRY": JSON.stringify("false"),
  },
  resolve: {
    alias: {
      "@/shared": path.resolve(__dirname, "../shared"),
      "@": path.resolve(__dirname, "../client/src"),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: 6291,
    strictPort: true,
    fs: {
      allow: [
        path.resolve(__dirname, "../.."),
        path.dirname(realpathSync(path.resolve(__dirname, "../node_modules"))),
      ],
    },
  },
});
