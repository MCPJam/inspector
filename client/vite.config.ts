import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { Plugin } from 'vite';

// Create a plugin to handle history fallbacks for SPA routing
function historyFallback(): Plugin {
  return {
    name: 'spa-history-fallback',
    configureServer(server) {
      return () => {
        server.middlewares.use((req, res, next) => {
          // Check if the request is for a static asset
          if (
            req.url && 
            !req.url.startsWith('/api') && 
            !req.url.includes('.') && 
            !req.headers.accept?.includes('text/event-stream')
          ) {
            // Rewrite to index.html for SPA routing
            req.url = '/';
          }
          next();
        });
      };
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), historyFallback()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@/shared": path.resolve(__dirname, "../shared"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
    // Add history API fallback for client-side routing
    fs: {
      strict: true,
    },
  },
  preview: {
    port: 3000,
  },
  build: {
    outDir: "../dist/client",
    sourcemap: true,
    emptyOutDir: true,
  },
});
