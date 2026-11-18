import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpInspector } from "../index.js";

const launcher = vi.hoisted(() => ({
  stop: vi.fn(async () => {}),
  launchInspector: vi.fn(),
}));

vi.mock("../../launcher/index.js", () => ({
  launchInspector: launcher.launchInspector,
}));

const SERVER = { name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" };

/** A Vite dev server as the plugin sees it: only its HTTP server events. */
function devServer() {
  const httpServer = new EventEmitter();
  return { httpServer };
}

function start(plugin: ReturnType<typeof mcpInspector>) {
  const server = devServer();
  const configure = plugin.configureServer as (s: unknown) => void;
  configure(server);
  server.httpServer.emit("listening");
  return server;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("mcpInspector", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    launcher.launchInspector.mockResolvedValue({
      url: "http://localhost:6274/#token=abc",
      stop: launcher.stop,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    // Let go of anything a test left running, so tests stay independent.
    await (mcpInspector({ server: SERVER }).closeBundle as () => Promise<void>)();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("launches with reuse on by default and the Playground tab", async () => {
    start(mcpInspector({ server: SERVER }));
    await flush();

    expect(launcher.launchInspector).toHaveBeenCalledWith(
      expect.objectContaining({ server: SERVER, reuse: true, defaultTab: "playground" }),
    );
  });

  it("passes reuse: false and port options through", async () => {
    start(mcpInspector({ server: SERVER, reuse: false, port: 7000, strictPort: true, open: false }));
    await flush();

    expect(launcher.launchInspector).toHaveBeenCalledWith(
      expect.objectContaining({ reuse: false, port: 7000, strictPort: true, open: false }),
    );
    await (mcpInspector({ server: SERVER, port: 7000 }).closeBundle as () => Promise<void>)();
  });

  it("keeps the launch across a Vite restart in the same process", async () => {
    const first = start(mcpInspector({ server: SERVER }));
    await flush();
    first.httpServer.emit("close");
    // Vite builds a new plugin instance for the restarted server.
    start(mcpInspector({ server: SERVER }));
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(launcher.launchInspector).toHaveBeenCalledTimes(1);
    expect(launcher.stop).not.toHaveBeenCalled();
  });

  it("lets go of MCPJam when the dev server closes for good", async () => {
    const server = start(mcpInspector({ server: SERVER }));
    await flush();
    server.httpServer.emit("close");
    await vi.advanceTimersByTimeAsync(2_500);

    expect(launcher.stop).toHaveBeenCalledTimes(1);
  });

  it("reports a failed launch and tries again on the next start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    launcher.launchInspector.mockRejectedValueOnce(new Error("Port 6274 is in use"));
    start(mcpInspector({ server: SERVER }));
    await flush();
    expect(console.error).toHaveBeenCalledWith(
      "Failed to launch MCP Inspector:",
      expect.any(Error),
    );

    start(mcpInspector({ server: SERVER }));
    await flush();
    expect(launcher.launchInspector).toHaveBeenCalledTimes(2);
  });

  it("does nothing with autoLaunch: false", async () => {
    start(mcpInspector({ server: SERVER, autoLaunch: false }));
    await flush();
    expect(launcher.launchInspector).not.toHaveBeenCalled();
  });
});
