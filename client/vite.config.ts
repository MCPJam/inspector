import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  envDir: "..",
  plugins: [react()],
  resolve: {
    alias: {
      "@/shared": path.resolve(__dirname, "../shared"),
      "@": path.resolve(__dirname, "./src"),
      // Force React resolution to prevent conflicts with @mcp-ui/client
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
      "@mcp-ui/client": path.resolve(__dirname, "node_modules/@mcp-ui/client"),
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
    proxy: {
      "/api": {
        target: "http://localhost:3000",
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
    outDir: "../dist/client",
    sourcemap: true,
    emptyOutDir: true,
  },
});
