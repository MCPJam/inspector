import { describe, expect, it, vi } from "vitest";
import { runBrowserProbe, type BrowserProbeDeps, type ProbeClient } from "../browser-debug-probe";
import type { BrowserdHandle, BrowserdSandbox } from "../boot-browserd";
import type { BrowserdCommandResponse } from "../browserd-client";

const fakeBrowserd = {} as BrowserdSandbox;

function okResponse(over: Partial<Extract<BrowserdCommandResponse, { status: "ok" }>> = {}) {
  return {
    status: "ok" as const,
    result: { ok: true, output: { screenshot: "PNGDATA" }, settled: true },
    bootId: "boot-1",
    ...over,
  };
}

function makeDeps(over: {
  reserveDesktop?: BrowserProbeDeps["reserveDesktop"];
  connect?: BrowserProbeDeps["connect"];
  boot?: BrowserProbeDeps["boot"];
  responses?: BrowserdCommandResponse[];
} = {}) {
  const stop = vi.fn(async () => {});
  const disconnect = vi.fn(async () => {});
  const writeBundle = vi.fn(async () => {});
  const handle: BrowserdHandle = {
    bearer: "bearer",
    bootId: "boot-1",
    port: 8791,
    publicOrigin: "https://box-8791.e2b.dev",
    stop,
  };
  const responses = over.responses ?? [okResponse(), okResponse()];
  let call = 0;
  const client: ProbeClient = { sendCommand: vi.fn(async () => responses[call++]) };
  const deps: BrowserProbeDeps = {
    reserveDesktop: over.reserveDesktop ?? vi.fn(async () => ({ computerId: "comp-1" })),
    resolveSandboxId: vi.fn(async () => "sbx-1"),
    connect:
      over.connect ??
      vi.fn(async () => ({ writeBundle, browserd: fakeBrowserd, disconnect })),
    boot: over.boot ?? vi.fn(async () => handle),
    createClient: vi.fn(() => client),
  };
  return { deps, stop, disconnect, writeBundle, client };
}

const INPUT = { url: "https://x.test/", bundle: new Uint8Array([1, 2, 3]) };

describe("runBrowserProbe", () => {
  it("reserves a desktop, boots, navigates, screenshots, and returns proof", async () => {
    const { deps, stop, disconnect, writeBundle } = makeDeps();
    const result = await runBrowserProbe(deps, INPUT);
    expect(result).toEqual({
      computerId: "comp-1",
      bootId: "boot-1",
      url: "https://x.test/",
      settled: true,
      screenshotBytes: "PNGDATA".length,
    });
    expect(writeBundle).toHaveBeenCalledWith("/opt/mcpjam/mcpjam-browserd.mjs", INPUT.bundle);
    // cleanup runs even on the happy path
    expect(stop).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("tears down the daemon AND the connection when boot fails (no orphan)", async () => {
    const { deps, disconnect, stop } = makeDeps({
      boot: vi.fn(async () => {
        throw new Error("browserd exited before listening");
      }),
    });
    await expect(runBrowserProbe(deps, INPUT)).rejects.toThrow(/exited before listening/);
    expect(stop).not.toHaveBeenCalled(); // no handle to stop
    expect(disconnect).toHaveBeenCalledOnce(); // but the connection is released
  });

  it("stops the daemon when navigate is rejected", async () => {
    const { deps, stop, disconnect } = makeDeps({
      responses: [{ status: "busy", bootId: "boot-1" }],
    });
    await expect(runBrowserProbe(deps, INPUT)).rejects.toThrow(/navigate rejected: busy/);
    expect(stop).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("stops the daemon when the screenshot is rejected", async () => {
    const { deps, stop } = makeDeps({
      responses: [okResponse(), { status: "stale_observation", bootId: "boot-1" }],
    });
    await expect(runBrowserProbe(deps, INPUT)).rejects.toThrow(/screenshot rejected: stale_observation/);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("fails when navigate is admitted but the browser operation failed (result.ok=false)", async () => {
    const { deps, stop, disconnect } = makeDeps({
      responses: [
        { status: "ok", result: { ok: false, error: "cdp exploded" }, bootId: "boot-1" },
      ],
    });
    await expect(runBrowserProbe(deps, INPUT)).rejects.toThrow(/navigate failed: cdp exploded/);
    expect(stop).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("fails when the screenshot is admitted but the capture failed (result.ok=false)", async () => {
    const { deps, stop } = makeDeps({
      responses: [
        okResponse(),
        { status: "ok", result: { ok: false, error: "capture boom" }, bootId: "boot-1" },
      ],
    });
    await expect(runBrowserProbe(deps, INPUT)).rejects.toThrow(/screenshot failed: capture boom/);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not release a connection it never opened (connect throws)", async () => {
    const disconnect = vi.fn(async () => {});
    const deps = makeDeps().deps;
    deps.connect = vi.fn(async () => {
      throw new Error("Sandbox.connect failed");
    });
    await expect(runBrowserProbe(deps, INPUT)).rejects.toThrow(/Sandbox.connect failed/);
    expect(disconnect).not.toHaveBeenCalled();
  });
});
