import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  root: "./client",
  resolve: {
    alias: {
      "@/shared": resolve(__dirname, "./shared"),
      "@": resolve(__dirname, "./client/src"),
    },
  },
  server: {
    port: 8080,
    hmr: {
      port: 8081,
    },
    proxy: {
      "/api": {
        target: "http://localhost:3000", // the port need to be the same as the server port
        changeOrigin: true,
      },
    },
  },
});
