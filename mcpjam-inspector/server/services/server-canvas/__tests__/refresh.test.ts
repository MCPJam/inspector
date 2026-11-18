import { describe, expect, it, vi } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  claimCanvasRefresh,
  runCanvasRefresh,
  type CanvasRefreshTarget,
} from "../refresh.js";
import type { ServerFeatureCapture } from "../capture.js";

const CAPTURE: ServerFeatureCapture = {
  snapshot: { version: 3, capturedAt: 1, servers: [] },
  context: { transport: "streamable-http", era: "legacy" },
  contextHash: "ctx_0123456789abcdef",
};

function fakeManager(partial: Partial<MCPClientManager>): MCPClientManager {
  return partial as MCPClientManager;
}

function target(overrides: Partial<CanvasRefreshTarget> = {}): CanvasRefreshTarget {
  return {
    hosted: true,
    projectId: "prj_1",
    serverId: "srv_1",
    manager: fakeManager({
      getServerConfig: () => ({ url: "https://srv.example.com/mcp" }),
    }),
    managerKey: "srv_1",
    convexBearer: "Bearer user-token",
    accountKey: "cred_1",
    ...overrides,
  };
}

describe("runCanvasRefresh", () => {
  it("captures nothing, probes nothing and writes nothing when the rollout is off", async () => {
    const capture = vi.fn();
    const afterCapture = vi.fn();
    await expect(
      runCanvasRefresh(target(), {
        rollout: async () => false,
        capture,
        afterCapture,
      }),
    ).resolves.toMatchObject({ outcome: "rollout-off" });
    expect(capture).not.toHaveBeenCalled();
    expect(afterCapture).not.toHaveBeenCalled();
  });

  it("captures and hands off to the canvas work with the cadence bypassed", async () => {
    const capture = vi.fn(async () => CAPTURE);
    const afterCapture = vi.fn(async () => undefined);
    const refresh = target();
    await expect(
      runCanvasRefresh(refresh, { rollout: async () => true, capture, afterCapture }),
    ).resolves.toMatchObject({ outcome: "started" });
    expect(capture).toHaveBeenCalledWith(refresh.manager, "srv_1", "srv_1", {
      accountKey: "cred_1",
      logPrefix: "server-canvas-refresh",
    });
    expect(afterCapture).toHaveBeenCalledWith(
      {
        hosted: true,
        projectId: "prj_1",
        serverId: "srv_1",
        managerKey: "srv_1",
        manager: refresh.manager,
        convexBearer: "Bearer user-token",
        serverUrl: "https://srv.example.com/mcp",
        capture: CAPTURE,
      },
      { force: true, onStarted: expect.any(Function) },
    );
  });

  it("exposes when the probes it started are stored", async () => {
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const afterCapture = vi.fn(
      async (
        _event: unknown,
        options?: { onStarted?: (probes: { connectionReleased: Promise<void>; done: Promise<void> }) => void },
      ) => {
        options?.onStarted?.({ connectionReleased: Promise.resolve(), done });
      },
    );
    const run = await runCanvasRefresh(target(), {
      rollout: async () => true,
      capture: vi.fn(async () => CAPTURE),
      afterCapture,
    });
    let stored = false;
    void run.done.then(() => {
      stored = true;
    });
    await Promise.resolve();
    expect(stored).toBe(false);
    finish();
    await run.done;
    expect(stored).toBe(true);
  });

  it("lets one refresh per caller and server run at a time", () => {
    const key = { caller: "user_1", projectId: "prj_1", serverId: "srv_1" };
    const release = claimCanvasRefresh(key);
    expect(release).toBeTypeOf("function");
    expect(claimCanvasRefresh(key)).toBeUndefined();
    const other = claimCanvasRefresh({ ...key, caller: "user_2" });
    expect(other).toBeTypeOf("function");
    release?.();
    release?.();
    const again = claimCanvasRefresh(key);
    expect(again).toBeTypeOf("function");
    again?.();
    other?.();
  });

  it("never throws", async () => {
    await expect(
      runCanvasRefresh(target(), {
        rollout: async () => true,
        capture: vi.fn(async () => {
          throw new Error("capture failed");
        }),
      }),
    ).resolves.toMatchObject({ outcome: "failed" });
  });
});
