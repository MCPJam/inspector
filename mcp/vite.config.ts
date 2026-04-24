import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
// @ts-expect-error Local build helper is implemented as plain ESM.
import { bundleMcpAppsHtmlPlugin } from "./scripts/bundle-mcp-app-html.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react(), viteSingleFile(), bundleMcpAppsHtmlPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: mode === "development" ? "inline" : false,
    minify: mode !== "development",
    cssMinify: mode !== "development",
    rollupOptions: {
      input: {
        whoami: resolve(__dirname, "src/ui/whoami.html"),
      },
    },
  },
}));
