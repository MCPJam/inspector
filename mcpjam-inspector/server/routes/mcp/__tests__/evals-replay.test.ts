import { Hono } from "hono";
import { getFunctionName } from "convex/server";
import { MCPClientManager } from "@mcpjam/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  convexQueryMock,
  captureToolSnapshotForEvalAuthoringMock,
  fetchReplayConfigMock,
  storeReplayConfigMock,
  startSuiteRunWithRecorderMock,
  runEvalSuiteWithAiSdkMock,
  disconnectAllServersMock,
} = vi.hoisted(() => ({
  convexQueryMock: vi.fn(),
  captureToolSnapshotForEvalAuthoringMock: vi.fn(),
  fetchReplayConfigMock: vi.fn(),
  storeReplayConfigMock: vi.fn(),
  startSuiteRunWithRecorderMock: vi.fn(),
  runEvalSuiteWithAiSdkMock: vi.fn(),
  disconnectAllServersMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    // A constructor: a local replay builds its manager with `new`.
    MCPClientManager: vi.fn(function (configs?: Record<string, unknown>) {
      return {
        disconnectAllServers: disconnectAllServersMock,
        listServers: () => Object.keys(configs ?? {}),
      };
    }),
  };
});

vi.mock("../../../services/evals/route-helpers.js", () => ({
  buildReplayManager: vi.fn(() => ({
    disconnectAllServers: disconnectAllServersMock,
    connectToServer: vi.fn().mockResolvedValue(undefined),
    getConnectionStatus: vi.fn(() => "connected"),
    getToolsForAiSdk: vi.fn().mockResolvedValue({}),
  })),
  connectReplayManagerServers: vi.fn().mockResolvedValue(undefined),
  createConvexClient: vi.fn(() => ({
    query: convexQueryMock,
  })),
  captureToolSnapshotForEvalAuthoring: (...args: unknown[]) =>
    captureToolSnapshotForEvalAuthoringMock(...args),
  fetchReplayConfig: (...args: unknown[]) => fetchReplayConfigMock(...args),
  requireConvexHttpUrl: vi.fn(() => "https://convex.example"),
  storeReplayConfig: (...args: unknown[]) => storeReplayConfigMock(...args),
}));

vi.mock("../../../services/evals/recorder", () => ({
  startSuiteRunWithRecorder: (...args: unknown[]) =>
    startSuiteRunWithRecorderMock(...args),
}));

vi.mock("../../../services/evals-runner", () => ({
  runEvalSuiteWithAiSdk: (...args: unknown[]) =>
    runEvalSuiteWithAiSdkMock(...args),
}));

import evalsRoutes from "../evals";
import { buildReplayManager } from "../../../services/evals/route-helpers.js";

function createApp() {
  const app = new Hono();
  app.route("/api/mcp/evals", evalsRoutes);
  return app;
}

describe("mcp replay route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convexQueryMock.mockResolvedValue({
      suiteId: "suite-1",
      hasServerReplayConfig: true,
      environment: { servers: ["srv_asana"] },
    });
    fetchReplayConfigMock.mockResolvedValue({
      runId: "source-run",
      suiteId: "suite-1",
      servers: [
        {
          serverId: "excalidraw",
          url: "https://mcp.excalidraw.com",
        },
      ],
    });
    captureToolSnapshotForEvalAuthoringMock.mockResolvedValue({
      toolSnapshot: {
        version: 1,
        capturedAt: 123,
        servers: [
          {
            serverId: "excalidraw",
            tools: [
              {
                name: "search",
                description: "Find drawings.",
                inputSchema: { type: "object" },
              },
            ],
          },
        ],
      },
      toolSnapshotDebug: {
        captureResult: {
          status: "complete",
          serverCount: 1,
          toolCount: 1,
          failedServerCount: 0,
          failedServerIds: [],
        },
        promptSection: "# Available MCP Tools",
        promptSectionTruncated: false,
        promptSectionMaxChars: 30000,
        fallbackReason: null,
        fullSnapshot: null,
      },
    });
    startSuiteRunWithRecorderMock.mockResolvedValue({
      runId: "replay-run",
      recorder: null,
      config: {
        tests: [],
        environment: { servers: ["excalidraw"] },
      },
      hostConfig: {},
    });
    runEvalSuiteWithAiSdkMock.mockResolvedValue(undefined);
    storeReplayConfigMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores replay config on the new run and executes with replay-config server ids", async () => {
    const response = await createApp().request("/api/mcp/evals/replay-run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runId: "source-run",
        convexAuthToken: "token-123",
      }),
    });

    expect(response.status).toBe(200);
    expect(startSuiteRunWithRecorderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverIds: ["excalidraw"],
        replayedFromRunId: "source-run",
        toolSnapshot: expect.objectContaining({
          servers: [
            expect.objectContaining({
              serverId: "excalidraw",
            }),
          ],
        }),
        toolSnapshotDebug: expect.objectContaining({
          captureResult: expect.objectContaining({
            status: "complete",
          }),
        }),
      }),
    );
    expect(storeReplayConfigMock).toHaveBeenCalledWith(
      "replay-run",
      [
        {
          serverId: "excalidraw",
          url: "https://mcp.excalidraw.com",
        },
      ],
      "token-123",
    );
    expect(runEvalSuiteWithAiSdkMock).toHaveBeenCalledTimes(1);
    expect(disconnectAllServersMock).toHaveBeenCalledTimes(1);
  });

  /** The backend's answers for a replay of a local run on project-1. */
  function stubLocalProject(
    authorizeRequests: Array<Record<string, unknown>>,
    serverUrl = "https://mcp.excalidraw.com",
  ) {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith("/web/authorize-batch")) {
          throw new Error(`Unexpected fetch ${String(input)}`);
        }
        authorizeRequests.push(JSON.parse(String(init?.body)));
        return Response.json({
          results: {
            srv_excalidraw: {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: {
                transportType: "http",
                url: serverUrl,
                useOAuth: true,
              },
              oauthAccessToken: "fresh-token",
              oauthCredentialId: "acct_a",
            },
          },
        });
      }),
    );
    convexQueryMock.mockImplementation(
      async (ref: string | Parameters<typeof getFunctionName>[0]) => {
        switch (typeof ref === "string" ? ref : getFunctionName(ref)) {
          case "testSuites:getRunReplayMetadata":
            return {
              suiteId: "suite-1",
              projectId: "project-1",
              hasServerReplayConfig: true,
              environment: { servers: ["excalidraw"] },
            };
          case "servers:getProjectServers":
            return [
              { _id: "srv_excalidraw", name: "excalidraw", url: serverUrl },
            ];
          default:
            return null;
        }
      },
    );
  }

  function replayRun() {
    return createApp().request("/api/mcp/evals/replay-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: "source-run",
        convexAuthToken: "token-123",
      }),
    });
  }

  it("runs a run recorded under server names on the ids its servers are authorized under", async () => {
    const authorizeRequests: Array<Record<string, unknown>> = [];
    stubLocalProject(authorizeRequests);
    // Recorded before servers were keyed by id: names, linked to names.
    startSuiteRunWithRecorderMock.mockResolvedValue({
      runId: "replay-run",
      recorder: null,
      config: {
        tests: [],
        environment: {
          servers: ["excalidraw"],
          serverBindings: [
            { serverName: "excalidraw", projectServerId: "excalidraw" },
          ],
        },
      },
      hostConfig: {},
    });
    const { resolveConfiguredServerIds } = await vi.importActual<
      typeof import("../../../services/evals-runner")
    >("../../../services/evals-runner");

    const response = await replayRun();

    expect(response.status).toBe(200);
    expect(startSuiteRunWithRecorderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountsAtRun: [
          { serverId: "srv_excalidraw", connectionIds: ["acct_a"] },
        ],
      }),
    );
    const [{ config, mcpClientManager }] =
      runEvalSuiteWithAiSdkMock.mock.calls[0];
    expect(
      resolveConfiguredServerIds({
        environment: config.environment,
        mcpClientManager,
      }),
    ).toEqual(["srv_excalidraw"]);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["only by a trailing slash", "https://mcp.excalidraw.com/", 200],
    ["to another host", "https://draw.example.com", 409],
  ])(
    "treats a stored address that differs %s as the right status",
    async (_label, storedUrl, status) => {
      const authorizeRequests: Array<Record<string, unknown>> = [];
      stubLocalProject(authorizeRequests);
      fetchReplayConfigMock.mockResolvedValue({
        runId: "source-run",
        suiteId: "suite-1",
        servers: [
          {
            serverId: "excalidraw",
            url: storedUrl,
            accessToken: "stored-token",
          },
        ],
      });

      const response = await replayRun();

      expect(response.status).toBe(status);
      if (status === 409) {
        await expect(response.json()).resolves.toMatchObject({
          error:
            "excalidraw has moved to a different address since this run was recorded, so the run can't be replayed. Run the suite again to test the new address.",
        });
        // Never dialed with the stored token, and no run was started.
        expect(buildReplayManager).not.toHaveBeenCalled();
        expect(authorizeRequests).toHaveLength(0);
        expect(startSuiteRunWithRecorderMock).not.toHaveBeenCalled();
      } else {
        expect(authorizeRequests).toEqual([
          expect.objectContaining({ serverIds: ["srv_excalidraw"] }),
        ]);
      }
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    },
  );

  it("authorizes the run's project servers again, with the suite's chosen account, instead of the stored token", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    const authorizeRequests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith("/web/authorize-batch")) {
          throw new Error(`Unexpected fetch ${String(input)}`);
        }
        authorizeRequests.push(JSON.parse(String(init?.body)));
        return Response.json({
          results: {
            srv_excalidraw: {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: {
                transportType: "http",
                url: "https://mcp.excalidraw.com",
                useOAuth: true,
              },
              oauthAccountSet: "applied",
              oauthAccessToken: "fresh-token",
              oauthCredentialId: "acct_b",
              oauthConnections: [
                {
                  connectionId: "acct_b",
                  isDefault: false,
                  accessToken: "fresh-token",
                },
              ],
            },
          },
        });
      }),
    );
    fetchReplayConfigMock.mockResolvedValue({
      runId: "source-run",
      suiteId: "suite-1",
      servers: [
        {
          serverId: "excalidraw",
          url: "https://mcp.excalidraw.com",
          accessToken: "stored-token",
        },
      ],
    });
    convexQueryMock.mockImplementation(
      async (ref: string | Parameters<typeof getFunctionName>[0]) => {
        switch (typeof ref === "string" ? ref : getFunctionName(ref)) {
          case "testSuites:getRunReplayMetadata":
            return {
              suiteId: "suite-1",
              projectId: "project-1",
              hasServerReplayConfig: true,
              environment: { servers: ["excalidraw"] },
            };
          case "testSuiteAccountSelections:getPersonalSuiteAccountChoices":
            return [{ serverId: "srv_excalidraw", connectionIds: ["acct_b"] }];
          case "servers:getProjectServers":
            return [
              {
                _id: "srv_excalidraw",
                name: "excalidraw",
                url: "https://mcp.excalidraw.com",
              },
            ];
          default:
            return null;
        }
      },
    );

    const response = await createApp().request("/api/mcp/evals/replay-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: "source-run",
        convexAuthToken: "token-123",
      }),
    });

    expect(response.status).toBe(200);
    expect(authorizeRequests).toEqual([
      expect.objectContaining({
        projectId: "project-1",
        serverIds: ["srv_excalidraw"],
        connectionIdSets: { srv_excalidraw: ["acct_b"] },
      }),
    ]);
    expect(buildReplayManager).not.toHaveBeenCalled();
    const [configs] = vi.mocked(MCPClientManager).mock.calls.at(-1)!;
    expect(
      new Headers(
        (configs as Record<string, { requestInit?: { headers?: HeadersInit } }>)
          .srv_excalidraw?.requestInit?.headers,
      ).get("authorization"),
    ).toBe("Bearer fresh-token");
    expect(startSuiteRunWithRecorderMock).toHaveBeenCalledWith(
      expect.objectContaining({ serverIds: ["srv_excalidraw"] }),
    );
    expect(runEvalSuiteWithAiSdkMock).toHaveBeenCalledTimes(1);
    expect(disconnectAllServersMock).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // `passCriteria` here was a bare, unbounded `z.object({ minimumPassRate:
  // z.number() })`: it STRIPPED the canonical `minimumPassRatePercent` — a
  // replay silently losing the one override it was sent to apply — and
  // accepted any number, so `0.8` meant 0.8% and produced a gate that could
  // not fail. Both are the defects this PR fixes on the other write surfaces.
  describe("the pass-criteria override", () => {
    async function replay(passCriteria: unknown): Promise<Response> {
      return createApp().request("/api/mcp/evals/replay-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: "source-run",
          convexAuthToken: "token-123",
          passCriteria,
        }),
      });
    }

    it("carries the canonical spelling through instead of dropping it", async () => {
      const response = await replay({ minimumPassRatePercent: 80 });

      expect(response.status).toBe(200);
      expect(startSuiteRunWithRecorderMock).toHaveBeenCalledWith(
        expect.objectContaining({
          // Normalized to the stored name, and PRESENT — a strip would leave
          // this undefined and the replay would run on the suite default.
          passCriteria: { minimumPassRate: 80 },
        }),
      );
    });

    it("still carries the deprecated spelling", async () => {
      const response = await replay({ minimumPassRate: 80 });

      expect(response.status).toBe(200);
      expect(startSuiteRunWithRecorderMock).toHaveBeenCalledWith(
        expect.objectContaining({ passCriteria: { minimumPassRate: 80 } }),
      );
    });

    it("refuses a fraction, which would make the replay's gate unfailable", async () => {
      const response = await replay({ minimumPassRate: 0.8 });

      expect(response.status).toBe(400);
      expect(startSuiteRunWithRecorderMock).not.toHaveBeenCalled();
    });

    it("refuses a percent above 100", async () => {
      const response = await replay({ minimumPassRate: 8000 });

      expect(response.status).toBe(400);
      expect(startSuiteRunWithRecorderMock).not.toHaveBeenCalled();
    });
  });
});
