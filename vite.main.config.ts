import { defineConfig, Plugin } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";

// Plugin to copy sandbox proxy HTML files to the Electron main build output
function copySandboxProxy(): Plugin {
  const filesToCopy = [
    {
      src: "server/routes/mcp/sandbox-proxy.html",
      dest: "sandbox-proxy.html",
    },
    {
      src: "server/routes/apps/chatgpt-sandbox-proxy.html",
      dest: "chatgpt-sandbox-proxy.html",
    },
  ];

  return {
    name: "copy-sandbox-proxy",
    writeBundle(options) {
      const outDir = options.dir || ".vite/build";
      mkdirSync(outDir, { recursive: true });
      for (const file of filesToCopy) {
        copyFileSync(resolve(__dirname, file.src), resolve(outDir, file.dest));
      }
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
