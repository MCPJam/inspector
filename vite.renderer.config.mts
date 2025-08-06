import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  root: "./client",
  build: {
    outDir: "../dist/renderer",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./client/src"),
    },
  },
  server: {
    port: 8080,
  },
});
