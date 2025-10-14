import { defineConfig } from "vite";
import { resolve } from "path";

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      "@/sdk": resolve(__dirname, "sdk/dist/index.js"),
      "@/shared": resolve(__dirname, "shared"),
    },
    // Some libs that can run in both Web and Node.js, such as `axios`, we need to tell Vite to build them in Node.js.
    browserField: false,
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
        // Mark SDK as external so it's not bundled, will be resolved at runtime
        "@/sdk",
      ],
    },
  },
});
