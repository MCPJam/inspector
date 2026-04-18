import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock config for local mode
vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

// mcp-conformance-api's `localPost` uses `authFetch` under the hood, not
// `global.fetch`. Route the mock through the same `fetchMock` so tests can
// configure responses in one place via `fetchMock.mockResolvedValue(...)`.
vi.mock("@/lib/session-token", () => ({
  authFetch: (path: string, init?: RequestInit) =>
    (global.fetch as unknown as (...args: unknown[]) => Promise<Response>)(
      path,
      init,
    ),
}));

// Mock web context
vi.mock("@/lib/apis/web/context", () => ({
  buildHostedServerRequest: vi.fn(() => ({
    workspaceId: "ws-1",
    serverId: "srv-1",
  })),
  isGuestMode: vi.fn(() => false),
}));

vi.mock("@/lib/apis/web/base", () => ({
  webPost: vi.fn(),
}));

// Track fetch calls
const fetchMock = vi.fn();
global.fetch = fetchMock;

import {
  runProtocolConformance,
  runAppsConformance,
  startOAuthConformance,
  submitOAuthConformanceCode,
  completeOAuthConformance,
} from "../mcp-conformance-api";

beforeEach(() => {
  fetchMock.mockReset();
});

describe("runProtocolConformance (local)", () => {
  it("calls local protocol endpoint with serverId", async () => {
    const mockResult = {
      success: true,
      result: {
        passed: true,
        serverUrl: "http://localhost:3000",
        checks: [],
        summary: "0/0 checks passed",
        durationMs: 100,
        categorySummary: {},
      },
    };

    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResult),
    });

    const result = await runProtocolConformance("my-server");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mcp/conformance/protocol",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ serverId: "my-server" }),
      }),
    );

    expect(result.success).toBe(true);
  });

  it("throws on error response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "Server not connected" }),
    });

    await expect(runProtocolConformance("bad-server")).rejects.toThrow(
      "Server not connected",
    );
  });
});

describe("runAppsConformance (local)", () => {
  it("calls local apps endpoint with serverId", async () => {
    const mockResult = {
      success: true,
      result: {
        passed: false,
        target: "http://localhost:3000",
        checks: [],
        summary: "0/0",
        durationMs: 50,
        categorySummary: {},
        discovery: {
          toolCount: 0,
          uiToolCount: 0,
          listedResourceCount: 0,
          listedUiResourceCount: 0,
          checkedUiResourceCount: 0,
        },
      },
    };

    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResult),
    });

    const result = await runAppsConformance("my-server");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mcp/conformance/apps",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ serverId: "my-server" }),
      }),
    );

    expect(result.success).toBe(true);
  });
});

describe("startOAuthConformance (local)", () => {
  it("sends oauth start with profile and options", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          phase: "authorization_needed",
          sessionId: "session-1",
          authorizationUrl: "https://auth.example.com/authorize",
          completedSteps: [],
        }),
    });

    const result = await startOAuthConformance({
      serverNameOrId: "oauth-server",
      oauthProfile: {
        serverUrl: "https://oauth-server.com",
        protocolVersion: "2025-11-25",
      },
      runNegativeChecks: true,
      callbackOrigin: "http://localhost:5173",
    });

    expect(result.phase).toBe("authorization_needed");
    expect(result.sessionId).toBe("session-1");

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.serverId).toBe("oauth-server");
    expect(sentBody.runNegativeChecks).toBe(true);
    expect(sentBody.callbackOrigin).toBe("http://localhost:5173");
  });
});

describe("submitOAuthConformanceCode (local)", () => {
  it("submits code to authorize endpoint", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    await submitOAuthConformanceCode({
      sessionId: "session-1",
      code: "auth-code-123",
      state: "state-abc",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mcp/conformance/oauth/authorize",
      expect.objectContaining({ method: "POST" }),
    );

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.sessionId).toBe("session-1");
    expect(sentBody.code).toBe("auth-code-123");
    expect(sentBody.state).toBe("state-abc");
  });
});

describe("completeOAuthConformance (local)", () => {
  it("polls complete endpoint", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          phase: "pending",
          completedSteps: [{ step: "metadata_discovery", status: "passed" }],
        }),
    });

    const result = await completeOAuthConformance("session-1");

    expect(result.phase).toBe("pending");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mcp/conformance/oauth/complete",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
