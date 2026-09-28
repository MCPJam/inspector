import { defineConfig } from "vite";
import { hotRestart } from "./vite.dev-plugins";

// https://vitejs.dev/config
export default defineConfig((env) => {
  // `env.command` comes from forge's own `configEnv`: `ViteConfigGenerator` sets
  // `"serve"` for `start` and `"build"` once `prePackage` flips `isProd`. Unlike
  // NODE_ENV it actually distinguishes the two, which is why the hot-restart
  // plugin below is gated on it.
  const isDevRun = env.command === "serve";

  return {
    build: {
      ssr: true,
      // Left as a NODE_ENV read DELIBERATELY, to keep the packaged preload
      // byte-identical. Note what it means, though: neither `electron:package`
      // nor `electron:make` nor any release workflow sets NODE_ENV, and Vite has
      // not set it by the time this config is loaded -- so this is false during
      // packaging and every shipped preload is UNMINIFIED (~3.0KB rather than
      // ~2.1KB). `isDevRun` is the correct expression and forge's own base
      // config already defaults `minify` to `command === "build"`, but switching
      // changes the bytes in a signed artifact, which is a call for whoever owns
      // releases and not a side effect of a DX change.
      minify: process.env.NODE_ENV === "production",
      // outDir: "dist/preload",
      rollupOptions: {
        external: ["electron"],
      },
    },
    // A preload rebuild restarts main as well, rather than only reloading the
    // renderer: a fresh renderer against a stale main-process IPC contract is
    // exactly the half-updated state that produces confusing bugs.
    plugins: isDevRun ? [hotRestart("preload")] : [],
  };
});
