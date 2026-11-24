import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchInspector } from "../index.js";

const engine = vi.hoisted(() => {
  const inspector = {
    url: "http://localhost:6274/#token=abc",
    baseUrl: "http://localhost:6274",
    port: 6274,
    started: true,
    process: { pid: 1 } as { pid: number } | undefined,
    connect: vi.fn(async () => ({ status: "pending" })),
    stop: vi.fn(async () => {}),
  };
  return { inspector, embedInspector: vi.fn(async () => inspector) };
});

vi.mock("@mcpjam/sdk/internal/inspector", () => ({
  embedInspector: engine.embedInspector,
}));

type EmbedCall = {
  start: { command: string; args: string[] };
  port?: number;
  strictPort?: boolean;
  reuse?: boolean;
  silent?: boolean;
  tab?: string;
  open?: boolean;
  onWarning?: (message: string) => void;
  env: Record<string, string>;
};
const embedCall = () =>
  (engine.embedInspector.mock.calls[0] as unknown as [EmbedCall])[0];

describe("launchInspector", () => {
  const isTTY = process.stdout.isTTY;
  const ci = process.env.CI;

  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    delete process.env.CI;
    engine.inspector.started = true;
    engine.inspector.process = { pid: 1 };
  });

  afterEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
    if (ci === undefined) delete process.env.CI;
    else process.env.CI = ci;
  });

  it("starts bin/start.js through the engine and returns its link and process", async () => {
    const instance = await launchInspector();

    expect(embedCall().start.command).toBe("node");
    expect(embedCall().start.args).toHaveLength(1);
    expect(embedCall().start.args[0]).toMatch(/bin[\\/]start\.js$/);
    expect(embedCall().open).toBe(true);
    expect(instance).toEqual({
      url: engine.inspector.url,
      port: 6274,
      process: engine.inspector.process,
      stop: engine.inspector.stop,
    });
  });

  it("passes port, strictPort, silent and the inspector's settings through", async () => {
    await launchInspector({
      port: 7000,
      strictPort: true,
      silent: true,
      verbose: true,
      cspMode: "widget-declared",
    });

    expect(embedCall()).toMatchObject({
      port: 7000,
      strictPort: true,
      silent: true,
      env: { VERBOSE_LOGS: "true", MCP_CSP_MODE: "widget-declared" },
    });
  });

  it("opens no browser with open: false, in CI, or without a terminal", async () => {
    await launchInspector({ open: false });
    process.env.CI = "true";
    await launchInspector();
    delete process.env.CI;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    await launchInspector();

    for (const [call] of engine.embedInspector.mock.calls as unknown as [EmbedCall][]) {
      expect(call.open).toBe(false);
    }
  });

  it("prints the engine's warnings, unless the launch is silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await launchInspector();
    embedCall().onWarning?.("Could not share MCPJam");
    expect(warn).toHaveBeenCalledWith("Could not share MCPJam");

    engine.embedInspector.mockClear();
    await launchInspector({ silent: true });
    expect(embedCall().onWarning).toBeUndefined();
    warn.mockRestore();
  });

  it("passes a current tab through unchanged and maps old names to Playground", async () => {
    await launchInspector({ defaultTab: "tools" });
    await launchInspector({ defaultTab: "chat" });
    await launchInspector({ defaultTab: "#app-builder" });

    const tabs = (engine.embedInspector.mock.calls as unknown as [EmbedCall][]).map(
      ([call]) => call.tab,
    );
    expect(tabs).toEqual(["tools", "playground", "playground"]);
  });

  it("rejects a tab the Inspector does not have, before starting it", async () => {
    await expect(launchInspector({ defaultTab: "nope" })).rejects.toThrow(
      'defaultTab "nope" is not a tab',
    );
    expect(engine.embedInspector).not.toHaveBeenCalled();
  });

  it("hands an HTTP server to the open tab instead of the launch config", async () => {
    await launchInspector({
      server: {
        name: "billing-mcp",
        url: "http://127.0.0.1:7102/mcp",
        headers: { Authorization: "Bearer x" },
        useOAuth: true,
      },
    });

    expect(engine.inspector.connect).toHaveBeenCalledWith({
      name: "billing-mcp",
      url: "http://127.0.0.1:7102/mcp",
      headers: { Authorization: "Bearer x" },
      useOAuth: true,
    });
    expect(embedCall().env).not.toHaveProperty("MCP_CONFIG_DATA");
  });

  it("accepts a stdio server", async () => {
    await launchInspector({
      server: { name: "local", command: "node", args: ["server.js"], env: { A: "1" } },
    });

    expect(engine.inspector.connect).toHaveBeenCalledWith({
      name: "local",
      command: "node",
      args: ["server.js"],
      env: { A: "1" },
    });
  });

  it("stops what it started when MCPJam refuses the server", async () => {
    engine.inspector.connect.mockRejectedValueOnce(new Error("MCPJam did not add billing-mcp"));
    await expect(
      launchInspector({ server: { name: "billing-mcp", url: "http://127.0.0.1:1/mcp" } }),
    ).rejects.toThrow("MCPJam did not add billing-mcp");
    expect(engine.inspector.stop).toHaveBeenCalled();
  });

  it("with reuse, reports whether MCPJam was started and has no process when reused", async () => {
    engine.inspector.started = false;
    engine.inspector.process = undefined;

    const instance = await launchInspector({ reuse: true });

    expect(embedCall().reuse).toBe(true);
    expect(instance.started).toBe(false);
    expect(instance).not.toHaveProperty("process");
  });
});
