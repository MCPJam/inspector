import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { realpathSync } from "node:fs";
export default defineConfig({
  root: path.resolve(__dirname, "fixtures/swarm-reporting"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@/shared": path.resolve(__dirname, "../shared"),
      "@": path.resolve(__dirname, "../client/src"),
      "@mcpjam/sdk/contract": path.resolve(
        __dirname,
        "../../sdk/src/contract/index.ts",
      ),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: 6289,
    strictPort: true,
    fs: {
      allow: [
        path.resolve(__dirname, "../.."),
        path.dirname(realpathSync(path.resolve(__dirname, "../node_modules"))),
      ],
    },
  },
});
