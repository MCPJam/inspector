import { defineConfig } from "vite";
import { resolve } from "path";

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      "@/sdk": resolve(__dirname, "sdk/index.ts"),
      "@/shared": resolve(__dirname, "shared"),
    },
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
  build: {
    lib: {
      entry: "src/main.ts",
      fileName: () => "[name].cjs", // need to use .cjs(other than .js), because the package.json type is set to module
      formats: ["cjs"],
    },
    rollupOptions: {
      external: [
        // Core Electron & Node modules
        "electron",
        // External runtime dependencies (must be in package.json dependencies)
        "@hono/node-server",
        "hono",
        "@modelcontextprotocol/sdk",
        "fix-path",
        "dotenv",
        "electron-log",
        "update-electron-app",
        "@sentry/electron",
        // @/sdk and @/shared will be bundled (not marked as external)
      ],
    },
  },
});
