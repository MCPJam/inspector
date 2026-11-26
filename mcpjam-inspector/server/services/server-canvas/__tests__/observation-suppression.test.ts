import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  startProbes: vi.fn(),
  exportV2: vi.fn(),
  rollout:
    vi.fn<(authorization: string | null | undefined) => Promise<boolean>>(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth = vi.fn();
    mutation = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock("../../../env.js", () => ({
  getInspectorClientRuntimeConfig: () => ({ convexUrl: undefined }),
}));
vi.mock("../../../utils/export-helpers.js", () => ({
  exportSingleServerForInspection: mocks.exportV2,
}));
vi.mock("../../../utils/server-canvas-rollout.js", () => ({
  resolveServerCanvasRollout: mocks.rollout,
}));
vi.mock("../capture.js", () => ({ captureServerFeatures: mocks.capture }));
vi.mock("../canvas-probes.js", () => ({
  startCanvasProbes: mocks.startProbes,
}));

import { isFeatureObservationPaused, type MCPClientManager } from "@mcpjam/sdk";
import { validateServerCore } from "../../../routes/web/servers.js";
import {
  onCanvasConnect,
  recordConnectInspection,
  type CanvasConnectEvent,
} from "../connect-hook.js";
import { runCanvasRefresh } from "../refresh.js";

const CAPTURE = {
  snapshot: { version: 3, capturedAt: 1, servers: [] },
  context: { transport: "streamable-http" },
  contextHash: "ctx_0123456789abcdef",
};

type FakeManager = Pick<
  MCPClientManager,
  "getServerConfig" | "getInitializationInfo" | "getToolsForAiSdk"
>;

function manager(
  getToolsForAiSdk: FakeManager["getToolsForAiSdk"] = async () => ({}),
): MCPClientManager {
  const fake: FakeManager = {
    getServerConfig: () => undefined,
    getInitializationInfo: () => undefined,
    getToolsForAiSdk,
  };
  return fake as MCPClientManager;
}

/** The probes' handle, with the connection released when the test says. */
function heldProbes() {
  let release = () => {};
  const connectionReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.startProbes.mockReturnValue({
    connectionReleased,
    done: connectionReleased,
  });
  return release;
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rollout.mockResolvedValue(true);
  mocks.exportV2.mockResolvedValue({ version: 2, capturedAt: 1, servers: [] });
  mocks.startProbes.mockReturnValue({
    connectionReleased: Promise.resolve(),
    done: Promise.resolve(),
  });
});

describe("MCPJam's own traffic is not observed use", () => {
  it("captures at connect with the connection's observation paused", async () => {
    const target = manager();
    const pausedDuringCapture: boolean[] = [];
    mocks.capture.mockImplementation(
      async (m: MCPClientManager, key: string) => {
        pausedDuringCapture.push(isFeatureObservationPaused(m, key));
        return CAPTURE;
      },
    );
    await recordConnectInspection({
      hosted: false,
      projectId: "prj_1",
      serverId: "srv_1",
      managerKey: "My Server",
      manager: target,
      convexBearer: undefined,
      canvasRollout: Promise.resolve(true),
      logPrefix: "connect-inspection",
    });
    await settle();
    expect(pausedDuringCapture).toEqual([true]);
    expect(isFeatureObservationPaused(target, "My Server")).toBe(false);
  });

  it("keeps observation paused until the probes release the connection", async () => {
    const target = manager();
    const release = heldProbes();
    const event: CanvasConnectEvent = {
      hosted: false,
      projectId: "prj_1",
      serverId: "srv_1",
      managerKey: "My Server",
      manager: target,
      convexBearer: undefined,
      capture: CAPTURE,
    };
    await onCanvasConnect(event);
    expect(isFeatureObservationPaused(target, "My Server")).toBe(true);
    expect(isFeatureObservationPaused(target, "Other Server")).toBe(false);
    release();
    await settle();
    expect(isFeatureObservationPaused(target, "My Server")).toBe(false);
  });

  it("captures on Refresh with the connection's observation paused", async () => {
    const target = manager();
    const pausedDuringCapture: boolean[] = [];
    const { outcome } = await runCanvasRefresh(
      {
        hosted: false,
        projectId: "prj_1",
        serverId: "srv_1",
        manager: target,
        managerKey: "My Server",
        convexBearer: "Bearer t",
      },
      {
        rollout: async () => true,
        capture: async (m, key) => {
          pausedDuringCapture.push(isFeatureObservationPaused(m, key));
          return CAPTURE;
        },
        afterCapture: async () => {},
      },
    );
    expect(outcome).toBe("started");
    expect(pausedDuringCapture).toEqual([true]);
    expect(isFeatureObservationPaused(target, "My Server")).toBe(false);
  });

  it("lists the hosted Connect's tools with observation paused", async () => {
    mocks.rollout.mockResolvedValue(false);
    const pausedDuringListing: boolean[] = [];
    const target = manager(async () => {
      pausedDuringListing.push(isFeatureObservationPaused(target, "srv_1"));
      return {};
    });
    const c = { req: { header: () => "Bearer t" } };
    await validateServerCore(c, target, {
      projectId: "prj_1",
      serverId: "srv_1",
    });
    expect(pausedDuringListing).toEqual([true]);
    expect(isFeatureObservationPaused(target, "srv_1")).toBe(false);
  });
});
