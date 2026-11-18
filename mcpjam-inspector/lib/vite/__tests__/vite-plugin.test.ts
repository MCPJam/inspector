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
const GRACE_MS = 5_000;

type Plugin = ReturnType<typeof mcpInspector>;

/** A Vite dev server as the plugin sees it: only its HTTP server events. */
function devServer() {
  return { httpServer: new EventEmitter() };
}

/** Vite builds a plugin instance and configures its server; `listening` follows. */
function configure(plugin: Plugin) {
  const server = devServer();
  (plugin.configureServer as (s: unknown) => void)(server);
  return {
    listen: () => server.httpServer.emit("listening"),
    /** What Vite does when it closes a dev server: the event, then the hook. */
    close: () => {
      server.httpServer.emit("close");
      (plugin.closeBundle as () => void)();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function launches() {
  return (globalThis as Record<symbol, unknown>)[
    Symbol.for("mcpjam.vitePluginLaunches")
  ] as Map<string, unknown> | undefined;
}

describe("mcpInspector", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    launcher.launchInspector.mockResolvedValue({
      url: "http://localhost:6274/#token=abc",
      stop: launcher.stop,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    launches()?.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("launches with reuse on by default and the Playground tab", async () => {
    configure(mcpInspector({ server: SERVER })).listen();
    await flush();

    expect(launcher.launchInspector).toHaveBeenCalledWith(
      expect.objectContaining({ server: SERVER, reuse: true, defaultTab: "playground" }),
    );
  });

  it("passes reuse: false and port options through", async () => {
    configure(
      mcpInspector({ server: SERVER, reuse: false, port: 7000, strictPort: true, open: false }),
    ).listen();
    await flush();

    expect(launcher.launchInspector).toHaveBeenCalledWith(
      expect.objectContaining({ reuse: false, port: 7000, strictPort: true, open: false }),
    );
  });

  it("does nothing with autoLaunch: false", async () => {
    configure(mcpInspector({ server: SERVER, autoLaunch: false })).listen();
    await flush();
    expect(launcher.launchInspector).not.toHaveBeenCalled();
  });

  describe("a Vite restart", () => {
    it("keeps the launch when the new server listens before the old one closes", async () => {
      const first = configure(mcpInspector({ server: SERVER }));
      first.listen();
      await flush();

      // Vite creates the new server, then closes the old one.
      const second = configure(mcpInspector({ server: SERVER }));
      second.listen();
      first.close();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 3);

      expect(launcher.launchInspector).toHaveBeenCalledTimes(1);
      expect(launcher.stop).not.toHaveBeenCalled();
    });

    it("keeps the launch when the old server closes, closeBundle included, before the new one listens", async () => {
      const first = configure(mcpInspector({ server: SERVER }));
      first.listen();
      await flush();

      first.close();
      // closeBundle ran and the grace timer is armed, not yet expired.
      await vi.advanceTimersByTimeAsync(GRACE_MS - 1_000);
      expect(launcher.stop).not.toHaveBeenCalled();

      configure(mcpInspector({ server: SERVER })).listen();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 3);

      expect(launcher.launchInspector).toHaveBeenCalledTimes(1);
      expect(launcher.stop).not.toHaveBeenCalled();
    });

    it("counts a dev server once however many times Vite reports it closing", async () => {
      const first = configure(mcpInspector({ server: SERVER }));
      first.listen();
      await flush();
      const second = configure(mcpInspector({ server: SERVER }));
      second.listen();

      // The old server is reported closed twice (the event and the hook).
      first.close();
      first.close();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 3);

      expect(launcher.stop).not.toHaveBeenCalled();
    });
  });

  it("lets go of MCPJam once, after the grace period, when the last dev server closes for good", async () => {
    const server = configure(mcpInspector({ server: SERVER }));
    server.listen();
    await flush();

    server.close();
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1_000);
    expect(launcher.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(launcher.stop).toHaveBeenCalledTimes(1);
  });

  it("reports a failed launch and tries again on the next start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    launcher.launchInspector.mockRejectedValueOnce(new Error("Port 6274 is in use"));
    configure(mcpInspector({ server: SERVER })).listen();
    await flush();
    expect(console.error).toHaveBeenCalledWith(
      "Failed to launch MCP Inspector:",
      expect.any(Error),
    );

    configure(mcpInspector({ server: SERVER })).listen();
    await flush();
    expect(launcher.launchInspector).toHaveBeenCalledTimes(2);
  });

  it("a failed launch does not remove a newer one started under the same key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail!: (error: Error) => void;
    launcher.launchInspector.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    // A slow first launch; its dev server closes and the grace period passes.
    const first = configure(mcpInspector({ server: SERVER }));
    first.listen();
    first.close();
    await vi.advanceTimersByTimeAsync(GRACE_MS + 1_000);

    // A newer launch takes the key while the first is still pending.
    configure(mcpInspector({ server: SERVER })).listen();
    await flush();
    expect(launcher.launchInspector).toHaveBeenCalledTimes(2);

    // The first one now fails. It must not delete the newer launch.
    fail(new Error("too late"));
    await flush();
    configure(mcpInspector({ server: SERVER })).listen();
    await flush();

    expect(launcher.launchInspector).toHaveBeenCalledTimes(2);
  });

  it("launches separately for servers that differ in what they point at", async () => {
    configure(mcpInspector({ server: SERVER })).listen();
    configure(mcpInspector({ server: { ...SERVER, url: "http://127.0.0.1:9999/mcp" } })).listen();
    await flush();

    expect(launcher.launchInspector).toHaveBeenCalledTimes(2);
  });
});
