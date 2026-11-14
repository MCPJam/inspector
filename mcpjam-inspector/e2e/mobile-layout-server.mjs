import { createServer, loadConfigFromFile } from "vite";
import { fileURLToPath } from "node:url";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const { config } = await loadConfigFromFile(
  { command: "serve", mode: "development" },
  `${packageRoot}/client/vite.config.ts`,
);
const server = await createServer({
  ...config,
  configFile: false,
  server: {
    ...config.server,
    host: "localhost",
    port: 5375,
    strictPort: true,
    hmr: false,
    // Fonts and workspace source live above the inspector package.
    fs: { allow: [repo] },
  },
});
await server.listen();
