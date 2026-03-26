import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mcpClientManagerConstructorMock } = vi.hoisted(() => ({
  mcpClientManagerConstructorMock: vi.fn(),
}));

vi.mock("@mcpjam/sdk", () => ({
  MCPClientManager: mcpClientManagerConstructorMock,
}));

import {
  buildReplayManager,
  fetchReplayConfig,
  storeReplayConfig,
} from "../route-helpers";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;
const ORIGINAL_INSPECTOR_SERVICE_TOKEN = process.env.INSPECTOR_SERVICE_TOKEN;

describe("fetchReplayConfig", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    if (ORIGINAL_INSPECTOR_SERVICE_TOKEN === undefined) {
      delete process.env.INSPECTOR_SERVICE_TOKEN;
    } else {
      process.env.INSPECTOR_SERVICE_TOKEN = ORIGINAL_INSPECTOR_SERVICE_TOKEN;
    }
  });

  it("sends both the user bearer token and inspector service token", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          replayConfig: {
            runId: "run_123",
            suiteId: "suite_123",
            servers: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await fetchReplayConfig("run_123", "user-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://convex.example/internal/v1/evals/runs/replay-config",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer user-token",
          "X-Inspector-Service-Token": "service-token",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

describe("storeReplayConfig", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    if (ORIGINAL_INSPECTOR_SERVICE_TOKEN === undefined) {
      delete process.env.INSPECTOR_SERVICE_TOKEN;
    } else {
      process.env.INSPECTOR_SERVICE_TOKEN = ORIGINAL_INSPECTOR_SERVICE_TOKEN;
    }
  });

  it("sends both the user bearer token and inspector service token", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await storeReplayConfig(
      "run_123",
      [
        {
          serverId: "asana",
          url: "https://example.com/mcp",
          accessToken: "at_123",
        },
      ],
      "user-token",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://convex.example/internal/v1/evals/runs/store-replay-config",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer user-token",
          "X-Inspector-Service-Token": "service-token",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

describe("buildReplayManager", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("constructs an MCP client manager for tokenless replay configs", () => {
    buildReplayManager({
      runId: "run_123",
      suiteId: "suite_123",
      servers: [
        {
          serverId: "excalidraw",
          url: "https://mcp.excalidraw.com",
          preferSSE: true,
        },
      ],
    });

    expect(mcpClientManagerConstructorMock).toHaveBeenCalledWith(
      {
        excalidraw: {
          url: "https://mcp.excalidraw.com",
          timeout: expect.any(Number),
          preferSSE: true,
        },
      },
      {
        defaultTimeout: expect.any(Number),
      },
    );
  });
});
