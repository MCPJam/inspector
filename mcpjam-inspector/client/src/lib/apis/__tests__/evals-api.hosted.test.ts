import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchResponse } from "@/test";

const authFetchMock = vi.fn();
const listHostedToolsMock = vi.fn();
const buildHostedServerBatchRequestMock = vi.fn();
const buildHostedServerRequestMock = vi.fn();
const isGuestModeMock = vi.fn(() => false);

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
  buildHostedServerRequest: (...args: unknown[]) =>
    buildHostedServerRequestMock(...args),
  isGuestMode: () => isGuestModeMock(),
}));

import {
  generateEvalTests,
  generateNegativeEvalTests,
  listEvalTools,
  runEvals,
  runEvalTestCase,
  streamEvalTestCase,
} from "../evals-api";

describe("evals-api hosted mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isGuestModeMock.mockReturnValue(false);
    buildHostedServerBatchRequestMock.mockImplementation(
      (serverNames: string[]) => {
        const serverIds = serverNames.map((serverName) =>
          serverName === "Server A"
            ? "srv_a"
            : serverName === "Server B"
              ? "srv_b"
              : serverName,
        );

        return {
          workspaceId: "workspace-1",
          serverIds,
          oauthTokens: serverIds.includes("srv_a")
            ? { srv_a: "oauth-token-a" }
            : undefined,
          clientCapabilities: { sampling: true },
        };
      },
    );
    buildHostedServerRequestMock.mockReturnValue({
      serverUrl: "https://guest.example.com/mcp",
      serverName: "Guest Server",
      serverHeaders: { "X-Guest": "yes" },
      oauthAccessToken: "guest-oauth-token",
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
    });
    expect(body).not.toHaveProperty("convexAuthToken");
  });

  it("rejects direct guest full-suite runs before workspace lookup", async () => {
    isGuestModeMock.mockReturnValue(true);

    await expect(
      runEvals({
        workspaceId: null,
        suiteName: "Guest Suite",
        tests: [],
        serverIds: ["Guest Server"],
        convexAuthToken: "guest-convex-token",
      }),
    ).rejects.toThrow("Not available for guests yet. Sign in to use this.");

    expect(buildHostedServerBatchRequestMock).not.toHaveBeenCalled();
    expect(authFetchMock).not.toHaveBeenCalled();
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

    const body = JSON.parse(authFetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      workspaceId: "workspace-1",
      serverIds: ["srv_a"],
    });
    expect(body).not.toHaveProperty("convexAuthToken");
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

    const body = JSON.parse(authFetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      workspaceId: "workspace-1",
      serverIds: ["srv_a"],
    });
    expect(body).not.toHaveProperty("convexAuthToken");
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

    const body = JSON.parse(authFetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      workspaceId: "workspace-1",
      serverIds: ["srv_a"],
      testCaseId: "test-case-1",
      model: "openai/gpt-5-mini",
      provider: "openai",
    });
    expect(body).not.toHaveProperty("convexAuthToken");
  });

  it("posts direct guest quick runs with the guest server payload", async () => {
    isGuestModeMock.mockReturnValue(true);

    await runEvalTestCase({
      workspaceId: null,
      testCaseId: "guest-case-1",
      model: "openai/gpt-5-mini",
      provider: "openai",
      serverIds: ["Guest Server"],
      convexAuthToken: "guest-convex-token",
    });

    expect(buildHostedServerRequestMock).toHaveBeenCalledWith("Guest Server");
    expect(buildHostedServerBatchRequestMock).not.toHaveBeenCalled();

    const body = JSON.parse(authFetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      serverUrl: "https://guest.example.com/mcp",
      serverName: "Guest Server",
      serverHeaders: { "X-Guest": "yes" },
      oauthAccessToken: "guest-oauth-token",
      clientCapabilities: { sampling: true },
      testCaseId: "guest-case-1",
      model: "openai/gpt-5-mini",
      provider: "openai",
    });
    expect(body).not.toHaveProperty("workspaceId");
    expect(body).not.toHaveProperty("serverIds");
    expect(body).not.toHaveProperty("convexAuthToken");
  });

  it("posts direct guest generation with the guest server payload", async () => {
    isGuestModeMock.mockReturnValue(true);

    await generateEvalTests({
      workspaceId: null,
      serverIds: ["Guest Server"],
      convexAuthToken: "guest-convex-token",
    });

    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/web/evals/generate-tests",
      expect.objectContaining({
        method: "POST",
      }),
    );

    const body = JSON.parse(authFetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      serverUrl: "https://guest.example.com/mcp",
      serverName: "Guest Server",
      serverHeaders: { "X-Guest": "yes" },
      oauthAccessToken: "guest-oauth-token",
      clientCapabilities: { sampling: true },
    });
    expect(body).not.toHaveProperty("workspaceId");
    expect(body).not.toHaveProperty("serverIds");
    expect(body).not.toHaveProperty("convexAuthToken");
  });

  it("posts direct guest negative generation with the guest server payload", async () => {
    isGuestModeMock.mockReturnValue(true);

    await generateNegativeEvalTests({
      workspaceId: null,
      serverIds: ["Guest Server"],
      convexAuthToken: "guest-convex-token",
    });

    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/web/evals/generate-negative-tests",
      expect.objectContaining({
        method: "POST",
      }),
    );

    const body = JSON.parse(authFetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      serverUrl: "https://guest.example.com/mcp",
      serverName: "Guest Server",
    });
    expect(body).not.toHaveProperty("workspaceId");
    expect(body).not.toHaveProperty("serverIds");
    expect(body).not.toHaveProperty("convexAuthToken");
  });

  it("uses /api/web/evals/stream-test-case and parses SSE events", async () => {
    const encoder = new TextEncoder();
    authFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  'data: {"type":"trace_snapshot","turnIndex":0,"snapshotKind":"step_finish","trace":{"traceVersion":1,"messages":[{"role":"user","content":"Hello"}],"spans":[{"id":"step-1","name":"Step 1","type":"step","startMs":0,"endMs":1,"status":"ok","stepIndex":0}]},"actualToolCalls":[],"usage":{"inputTokens":3,"outputTokens":2,"totalTokens":5}}',
                  "",
                  'data: {"type":"complete","iteration":{"_id":"iter-1"}}',
                  "",
                ].join("\n"),
              ),
            );
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    const events: unknown[] = [];
    await streamEvalTestCase(
      {
        workspaceId: "workspace-1",
        testCaseId: "test-case-1",
        model: "openai/gpt-5-mini",
        provider: "openai",
        serverIds: ["Server A"],
        convexAuthToken: "convex-token",
      },
      (event) => {
        events.push(event);
      },
    );

    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/web/evals/stream-test-case",
      expect.objectContaining({
        method: "POST",
      }),
    );

    const body = JSON.parse(authFetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      workspaceId: "workspace-1",
      serverIds: ["srv_a"],
      testCaseId: "test-case-1",
      model: "openai/gpt-5-mini",
      provider: "openai",
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "trace_snapshot",
        snapshotKind: "step_finish",
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
        },
      }),
      expect.objectContaining({
        type: "complete",
        iteration: { _id: "iter-1" },
      }),
    ]);
  });

  it("posts direct guest compare streams with the guest server payload", async () => {
    isGuestModeMock.mockReturnValue(true);
    const encoder = new TextEncoder();
    authFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"type":"complete"}\n\n'),
            );
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    await streamEvalTestCase(
      {
        workspaceId: null,
        testCaseId: "guest-case-1",
        model: "openai/gpt-5-mini",
        provider: "openai",
        serverIds: ["Guest Server"],
        convexAuthToken: "guest-convex-token",
        compareRunId: "cmp_guest",
      },
      () => {},
    );

    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/web/evals/stream-test-case",
      expect.objectContaining({
        method: "POST",
      }),
    );

    const body = JSON.parse(authFetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      serverUrl: "https://guest.example.com/mcp",
      serverName: "Guest Server",
      testCaseId: "guest-case-1",
      model: "openai/gpt-5-mini",
      provider: "openai",
      compareRunId: "cmp_guest",
    });
    expect(body).not.toHaveProperty("workspaceId");
    expect(body).not.toHaveProperty("serverIds");
    expect(body).not.toHaveProperty("convexAuthToken");
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
