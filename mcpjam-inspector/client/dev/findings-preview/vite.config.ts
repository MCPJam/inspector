/**
 * Vite config for the offline findings preview.
 *
 * Deliberately minimal and deliberately SEPARATE from the app's config: the
 * preview must start with no Convex URL, no auth, no Sentry token and no SDK
 * build. The three aliases below are the whole dependency surface — `@` for
 * the shared components, the SDK's platform types resolved from SOURCE (they
 * are type-only, so nothing of the SDK reaches the bundle), and React
 * deduped out of the workspace root.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, "../..");
const repoRoot = path.resolve(clientDir, "../..");

export default defineConfig({
  root: here,
  // `replay.json` is written next to this file by scripts/findings-preview.mjs
  // and served from the Vite root, so nothing has to be imported at build time
  // and the preview starts even before an artifact exists (it says so).
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify("findings-preview") },
  resolve: {
    alias: {
      "@/shared": path.resolve(clientDir, "../shared"),
      "@": path.resolve(clientDir, "src"),
      "@mcpjam/sdk/platform": path.resolve(
        repoRoot,
        "sdk/src/platform/index.ts",
      ),
      react: path.resolve(repoRoot, "node_modules/react"),
      "react-dom": path.resolve(repoRoot, "node_modules/react-dom"),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    // LOCALHOST ONLY. This server is unauthenticated and `/replay.json` can
    // carry excerpts, identifiers and contract data exported from a real run.
    // `host: true` binds every interface, LAN and public alike, which would
    // hand that file to anyone who can reach the workstation. Opt in
    // deliberately with FINDINGS_PREVIEW_HOST if you need it off-box.
    host: process.env.FINDINGS_PREVIEW_HOST ?? "127.0.0.1",
    port: Number(process.env.FINDINGS_PREVIEW_PORT ?? 5175),
    strictPort: false,
  },
  build: {
    outDir: path.resolve(here, "dist"),
    emptyOutDir: true,
  },
});
