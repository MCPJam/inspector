import { defineConfig, Plugin } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";

// Plugin to copy sandbox-proxy.html to build output
function copySandboxProxy(): Plugin {
  return {
    name: "copy-sandbox-proxy",
    writeBundle(options) {
      const outDir = options.dir || ".vite/build";
      mkdirSync(outDir, { recursive: true });
      copyFileSync(
        resolve(__dirname, "server/routes/mcp/sandbox-proxy.html"),
        resolve(outDir, "sandbox-proxy.html"),
      );
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  plugins: [copySandboxProxy()],
  resolve: {
    alias: {
      "@/sdk": resolve(__dirname, "sdk/src/index.ts"),
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
        // Native modules that can't be bundled
        "@ngrok/ngrok",
        // Bundle everything else including electron-log, update-electron-app, etc.
      ],
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
