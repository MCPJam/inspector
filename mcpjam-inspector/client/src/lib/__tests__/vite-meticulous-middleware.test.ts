import path from "node:path";
import { TextEncoder } from "node:util";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type PluginModule = typeof import("../../../vite-meticulous-middleware");

const recorderTag =
  '<script data-recording-token="tok" data-is-production-environment="false" src="https://snippet.meticulous.ai/v1/meticulous.js"></script>';

let plugin: PluginModule;

// esbuild checks on load that TextEncoder yields a Uint8Array of the global
// realm, and jsdom splits the two. The plugin only ever runs under Node, so
// the module is imported after Node's own pair is restored.
beforeAll(async () => {
  vi.stubGlobal("TextEncoder", TextEncoder);
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  plugin = await import("../../../vite-meticulous-middleware");
});
afterAll(() => vi.unstubAllGlobals());

describe("injectAfterRecorder", () => {
  it("places the tag right after the recorder, before anything else in head", () => {
    const html = `<head>${recorderTag}<meta charset="UTF-8" /></head>`;
    expect(plugin.injectAfterRecorder(html, "<script src=x></script>")).toBe(
      `<head>${recorderTag}<script src=x></script><meta charset="UTF-8" /></head>`,
    );
  });

  it("leaves html without a recorder tag untouched", () => {
    const html = '<head><meta charset="UTF-8" /></head>';
    expect(plugin.injectAfterRecorder(html, "<script src=x></script>")).toBe(
      html,
    );
  });
});

describe("compileMeticulousMiddleware", () => {
  it("builds a classic script that installs a working middleware", async () => {
    const code = await plugin.compileMeticulousMiddleware(
      path.resolve(__dirname, "../meticulous-middleware.ts"),
    );
    expect(code).not.toMatch(/\b(import|export)\b/);
    const sandbox: { window: Record<string, unknown> } = { window: {} };
    vm.runInNewContext(code, sandbox);
    const installed = sandbox.window.METICULOUS_RECORDER_MIDDLEWARE_V1;
    expect(Array.isArray(installed) && installed.length).toBe(1);
    const middleware = (installed as Array<Record<string, unknown>>)[0];
    const transform = middleware.transformNetworkRequest;
    if (typeof transform !== "function") throw new Error("missing hook");
    expect(
      transform({
        url: "https://x",
        method: "GET",
        headers: [{ name: "authorization", value: "Bearer t" }],
      }).headers,
    ).toEqual([{ name: "authorization", value: "********" }]);
  });
});
