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
        // Core Electron & Node modules only
        "electron",
        // Bundle everything else including electron-log, update-electron-app, etc.
      ],
    },
  },
});
