import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  base: "/",
  build: {
    outDir: "dist/widgets",
    assetsDir: "assets",
    rollupOptions: {
      input: path.resolve(__dirname, "widgets/worldcup-widget.html"),
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
        // Ensure HTML is output at the root of dist/widgets
      },
    },
  },
});










