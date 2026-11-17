import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutation: vi.fn(),
  setAuth: vi.fn(),
  exportV2: vi.fn(),
  captureV3: vi.fn(),
  startProbes: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth = mocks.setAuth;
    mutation = mocks.mutation;
  },
}));
vi.mock("../../../env.js", () => ({
  getInspectorClientRuntimeConfig: () => ({
    convexUrl: "https://example.convex.cloud",
  }),
}));
vi.mock("../../../utils/export-helpers.js", () => ({
  exportSingleServerForInspection: mocks.exportV2,
}));
vi.mock("../capture.js", () => ({ captureServerFeatures: mocks.captureV3 }));
vi.mock("../canvas-probes.js", () => ({ startCanvasProbes: mocks.startProbes }));

import type { MCPClientManager, OAuthFlowSummary } from "@mcpjam/sdk";
import { setManagerConnections } from "../../../utils/mcp-connections.js";
import { recordConnectInspection } from "../connect-hook.js";
import { doctorState } from "./probe-fixtures.js";

const V2_SNAPSHOT = {
  version: 2,
  capturedAt: 1,
  servers: [{ serverId: "srv_1", tools: [{ name: "search" }] }],
};
const CAPTURE = {
  snapshot: { version: 3, capturedAt: 2, servers: [{ serverId: "srv_1", tools: [] }] },
  context: { transport: "streamable-http", era: "legacy" },
  contextHash: "ctx_0123456789abcdef",
};
const SUMMARY: OAuthFlowSummary = {
  completedAt: 3,
  resourceIndicatorSent: true,
  scopesRequested: ["read"],
  scopesGranted: ["read"],
  issReturned: false,
  issValidated: false,
  refreshTokenIssued: true,
};

function input(canvas: boolean | Promise<boolean>, manager = {} as MCPClientManager) {
  return {
    hosted: false,
    projectId: "prj_1",
    serverId: "srv_1",
    managerKey: "Fixture",
    manager,
    convexBearer: "Bearer user-token",
    canvasRollout: Promise.resolve(canvas),
    oauthFlow: SUMMARY,
    logPrefix: "connect-inspection",
  };
}

async function flushWrites() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exportV2.mockResolvedValue(V2_SNAPSHOT);
  mocks.captureV3.mockResolvedValue(CAPTURE);
  mocks.mutation.mockResolvedValue({ status: "ok" });
  mocks.startProbes.mockReturnValue({
    connectionReleased: Promise.resolve(),
    done: Promise.resolve(),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recordConnectInspection", () => {
  it("writes exactly the v2 snapshot, and nothing else, when the rollout is off", async () => {
    const manager = {} as MCPClientManager;

    await expect(recordConnectInspection(input(false, manager))).resolves.toEqual({
      canvas: false,
    });
    await flushWrites();

    expect(mocks.exportV2).toHaveBeenCalledWith(manager, "Fixture", "srv_1", {
      logPrefix: "connect-inspection",
    });
    expect(mocks.captureV3).not.toHaveBeenCalled();
    expect(mocks.setAuth).toHaveBeenCalledWith("user-token");
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
    expect(mocks.mutation.mock.calls[0]?.[1]).toStrictEqual({
      projectId: "prj_1",
      snapshot: V2_SNAPSHOT,
    });
  });

  it("writes the v3 snapshot with its capture context when the rollout is on", async () => {
    const manager = {} as MCPClientManager;
    setManagerConnections(manager, {
      Fixture: [
        { serverId: "srv_1", connectionId: "conn_default", key: "Fixture", label: "a", isDefault: true },
      ],
    });

    await expect(recordConnectInspection(input(true, manager))).resolves.toEqual({
      canvas: true,
    });
    await flushWrites();

    expect(mocks.exportV2).not.toHaveBeenCalled();
    expect(mocks.captureV3).toHaveBeenCalledWith(manager, "Fixture", "srv_1", {
      accountKey: "conn_default",
      logPrefix: "connect-inspection",
    });
    expect(mocks.mutation.mock.calls[0]?.[1]).toStrictEqual({
      projectId: "prj_1",
      snapshot: CAPTURE.snapshot,
      captureContext: CAPTURE.context,
      captureContextHash: CAPTURE.contextHash,
    });
  });

  it("starts the background probes after a v3 capture, and none when the rollout is off", async () => {
    await recordConnectInspection(input(false));
    expect(mocks.startProbes).not.toHaveBeenCalled();

    await recordConnectInspection(input(true));
    expect(mocks.startProbes).toHaveBeenCalledTimes(1);
    expect(mocks.startProbes.mock.calls[0]?.[0]).toMatchObject({
      hosted: false,
      projectId: "prj_1",
      serverId: "srv_1",
      managerKey: "Fixture",
      capture: CAPTURE,
      oauthFlow: SUMMARY,
    });
  });

  it("holds a hosted connect until the probes release the connection", async () => {
    // UI resources to read, named in the tools' `_meta` the capture keeps apart.
    mocks.captureV3.mockResolvedValue({ ...CAPTURE, doctor: doctorState() });
    let release: () => void = () => undefined;
    mocks.startProbes.mockReturnValue({
      connectionReleased: new Promise<void>((resolve) => {
        release = resolve;
      }),
      done: Promise.resolve(),
    });
    let settled = false;
    const pending = recordConnectInspection({ ...input(true), hosted: true }).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    await flushWrites();
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toEqual({ canvas: true });
  });

  it("does not hold a hosted connect with nothing to read on the connection", async () => {
    mocks.startProbes.mockReturnValue({
      connectionReleased: new Promise<void>(() => undefined),
      done: Promise.resolve(),
    });
    const ok = { status: "ok" as const, detail: "" };
    mocks.captureV3.mockResolvedValue({
      ...CAPTURE,
      doctor: {
        initInfo: null,
        capabilities: null,
        tools: [{ name: "search", inputSchema: { type: "object" } }],
        toolsMetadata: {},
        resources: [],
        resourceTemplates: [],
        prompts: [],
        skills: [],
        checks: {
          initialization: ok,
          capabilities: ok,
          tools: ok,
          resources: ok,
          resourceTemplates: ok,
          prompts: ok,
          skills: { status: "skipped", detail: "" },
        },
        errors: [],
      },
    });
    const partial: Partial<MCPClientManager> = {
      getEventsSupport: () => ({ handshakeObserved: true, declared: false, listChanged: false }),
    };
    const manager = partial as MCPClientManager;
    await expect(
      recordConnectInspection({ ...input(true, manager), hosted: true }),
    ).resolves.toEqual({ canvas: true });
    expect(mocks.startProbes).toHaveBeenCalledTimes(1);
  });

  it("takes the off path when the rollout answer does not arrive in time", async () => {
    vi.useFakeTimers();
    const pending = recordConnectInspection({
      ...input(true),
      canvasRollout: new Promise<boolean>(() => undefined),
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({ canvas: false });
    expect(mocks.exportV2).toHaveBeenCalled();
  });

  it("skips the write for a connect cancelled during capture", async () => {
    const controller = new AbortController();
    mocks.captureV3.mockImplementation(async () => {
      controller.abort();
      return CAPTURE;
    });

    await recordConnectInspection({ ...input(true), signal: controller.signal });
    await flushWrites();

    // The capture gets the connect's signal, so cancelling also ends its lists.
    expect(mocks.captureV3).toHaveBeenCalledWith(
      expect.anything(),
      "Fixture",
      "srv_1",
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("never fails the connect when the write fails", async () => {
    mocks.mutation.mockRejectedValue(new Error("convex down"));

    await expect(recordConnectInspection(input(true))).resolves.toEqual({
      canvas: true,
    });
    await expect(recordConnectInspection(input(false))).resolves.toEqual({
      canvas: false,
    });
    await flushWrites();
  });

  it("writes nothing without a bearer", async () => {
    await recordConnectInspection({ ...input(true), convexBearer: undefined });
    await flushWrites();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
