import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchResponse } from "@/test";

const authFetchMock = vi.fn();
const listHostedToolsMock = vi.fn();
const buildHostedServerBatchRequestMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

vi.mock("@/lib/apis/web/tools-api", () => ({
  listHostedTools: (...args: unknown[]) => listHostedToolsMock(...args),
}));

vi.mock("@/lib/apis/web/context", () => ({
  buildHostedServerBatchRequest: (...args: unknown[]) =>
    buildHostedServerBatchRequestMock(...args),
}));

import {
  generateEvalTests,
  generateNegativeEvalTests,
  listEvalTools,
  runEvals,
  runEvalTestCase,
} from "../evals-api";

describe("evals-api hosted mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildHostedServerBatchRequestMock.mockReturnValue({
      workspaceId: "workspace-1",
      serverIds: ["srv_a", "srv_b"],
      oauthTokens: { srv_a: "oauth-token-a" },
      clientCapabilities: { sampling: true },
    });
    authFetchMock.mockResolvedValue(createFetchResponse({ success: true }));
  });

  it("uses /api/web/evals/run and preserves original suite server names", async () => {
    await runEvals({
      workspaceId: "workspace-1",
      suiteName: "Hosted Suite",
      tests: [{ title: "Test", query: "Hello", runs: 1 }],
      serverIds: ["Server A", "Server B"],
      convexAuthToken: "convex-token",
    });

    expect(buildHostedServerBatchRequestMock).toHaveBeenCalledWith([
      "Server A",
      "Server B",
    ]);
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/web/evals/run",
      expect.objectContaining({
        method: "POST",
      }),
    );

    const body = JSON.parse(authFetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      workspaceId: "workspace-1",
      serverIds: ["srv_a", "srv_b"],
      storageServerIds: ["Server A", "Server B"],
      convexAuthToken: "convex-token",
    });
  });

  it("uses /api/web/evals/generate-tests for hosted test generation", async () => {
    await generateEvalTests({
      workspaceId: "workspace-1",
      serverIds: ["Server A"],
      convexAuthToken: "convex-token",
    });

    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/web/evals/generate-tests",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("uses /api/web/evals/generate-negative-tests for hosted negative generation", async () => {
    await generateNegativeEvalTests({
      workspaceId: "workspace-1",
      serverIds: ["Server A"],
      convexAuthToken: "convex-token",
    });

    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/web/evals/generate-negative-tests",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("uses /api/web/evals/run-test-case for hosted quick runs", async () => {
    await runEvalTestCase({
      workspaceId: "workspace-1",
      testCaseId: "test-case-1",
      model: "openai/gpt-5-mini",
      provider: "openai",
      serverIds: ["Server A"],
      convexAuthToken: "convex-token",
    });

    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/web/evals/run-test-case",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("uses hosted tool listing instead of /api/mcp/list-tools", async () => {
    listHostedToolsMock
      .mockResolvedValueOnce({
        tools: [{ name: "tool_a", description: "Tool A" }],
      })
      .mockResolvedValueOnce({
        tools: [{ name: "tool_b", description: "Tool B" }],
      });

    const result = await listEvalTools({
      workspaceId: "workspace-1",
      serverIds: ["Server A", "Server B"],
    });

    expect(listHostedToolsMock).toHaveBeenCalledTimes(2);
    expect(listHostedToolsMock).toHaveBeenNthCalledWith(1, {
      serverNameOrId: "Server A",
    });
    expect(listHostedToolsMock).toHaveBeenNthCalledWith(2, {
      serverNameOrId: "Server B",
    });
    expect(result.tools.map((tool) => tool.name)).toEqual(["tool_a", "tool_b"]);
    expect(
      authFetchMock.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("/api/mcp/"),
      ),
    ).toBe(false);
  });
});
