import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import configuration from "../../vite.main.config";

describe("Electron main dependency externalization", () => {
  it("bundles import-only packages instead of emitting invalid CommonJS requires", () => {
    vi.stubEnv("MCPJAM_ELECTRON_DEV_BUNDLE_DEPS", "0");
    try {
      const config = (configuration as Function)({
        command: "serve",
        mode: "development",
      });
      const plugin = config.plugins.find(
        (p: any) => p.name === "mcpjam:externalize-bare-imports-in-dev",
      );
      const resolve =
        typeof plugin.resolveId === "function"
          ? plugin.resolveId
          : plugin.resolveId.handler;
      for (const specifier of [
        "@openai/mcp-extensions/server",
        "@openai/mcp-extensions/app",
        "@mcpjam/evaluators",
      ]) {
        expect(resolve.call({}, specifier, "/src/main.ts")).toBeNull();
      }
      expect(resolve.call({}, "zod", "/src/main.ts")).toEqual({
        id: "zod",
        external: true,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

it("transforms JSX with Forge's Vite 7 instead of requiring Vite 8 internals", async () => {
  const { createServer, version } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react-electron");
  expect(version).toMatch(/^7\./);
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "electron-react-")),
  );
  fs.writeFileSync(
    path.join(dir, "App.jsx"),
    "export default function App() { return <div>Ready</div>; }",
  );
  const server = await createServer({
    root: dir,
    optimizeDeps: { noDiscovery: true },
    configFile: false,
    plugins: [react({ jsxRuntime: "classic" })],
    server: { middlewareMode: true, hmr: false, fs: { allow: [dir] } },
    appType: "custom",
  });
  try {
    const result = await server.transformRequest("/App.jsx");
    expect(result?.code).toContain("Ready");
    expect(result?.code).not.toContain("<div>");
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
