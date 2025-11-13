import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// https://vitejs.dev/config
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, __dirname, "");

  return {
    envDir: __dirname, // Load env files from project root (absolute path)
    envPrefix: "VITE_", // Only load VITE_ prefixed vars
    plugins: [react(), tailwindcss()],
    root: "./client",
    resolve: {
      alias: {
        "@/shared": resolve(__dirname, "./shared"),
        "@": resolve(__dirname, "./client/src"),
      },
    },
    server: {
      proxy: {
        "/api": {
          target: "http://localhost:6274", // Server port 6275
          changeOrigin: true,
        },
      },
    },
  };
});
