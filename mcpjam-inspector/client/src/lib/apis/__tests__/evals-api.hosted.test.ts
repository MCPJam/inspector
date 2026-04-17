import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchResponse } from "@/test";

const authFetchMock = vi.fn();
const listHostedToolsMock = vi.fn();
const buildHostedServerBatchRequestMock = vi.fn();
const buildHostedServerRequestMock = vi.fn();

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
}));

import {
  generateEvalTests,
  generateNegativeEvalTests,
  listEvalTools,
  runEvals,
  runEvalTestCase,
  streamInlineEvalTestCaseGuest,
  streamEvalTestCase,
} from "../evals-api";

describe("evals-api hosted mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    buildHostedServerRequestMock.mockImplementation((serverName: string) => ({
      serverUrl: `https://${serverName.toLowerCase().replace(/\s+/g, "-")}.example.com/mcp`,
      serverHeaders: { Authorization: "Bearer guest-oauth-token" },
      serverName,
    }));
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

  it("uses /api/web/evals/stream-test-case-inline for hosted guest compare streaming", async () => {
    const encoder = new TextEncoder();
    authFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  'data: {"type":"trace_snapshot","turnIndex":0,"snapshotKind":"step_finish","trace":{"traceVersion":1,"messages":[{"role":"user","content":"Hello"}]},"actualToolCalls":[],"usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}',
                  "",
                  'data: {"type":"complete","iteration":{"_id":"guestiter-1"}}',
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
    await streamInlineEvalTestCaseGuest(
      {
        serverNameOrId: "Server A",
        model: "gpt-4",
        provider: "openai",
        compareRunId: "cmp_guest",
        test: {
          title: "Guest compare",
          query: "Hello",
        },
      },
      (event) => {
        events.push(event);
      },
    );

    expect(buildHostedServerRequestMock).toHaveBeenCalledWith("Server A");
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/web/evals/stream-test-case-inline",
      expect.objectContaining({
        method: "POST",
      }),
    );

    const body = JSON.parse(authFetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      serverIds: ["__guest__"],
      serverUrl: "https://server-a.example.com/mcp",
      serverHeaders: { Authorization: "Bearer guest-oauth-token" },
      model: "gpt-4",
      provider: "openai",
      compareRunId: "cmp_guest",
      test: {
        title: "Guest compare",
        query: "Hello",
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "trace_snapshot",
        snapshotKind: "step_finish",
      }),
      expect.objectContaining({
        type: "complete",
        iteration: { _id: "guestiter-1" },
      }),
    ]);
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
