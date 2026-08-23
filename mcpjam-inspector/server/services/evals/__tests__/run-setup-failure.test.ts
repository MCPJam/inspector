import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Non-vacuity: a run-level connect failure must persist
 * `stageResults[0].reason === "connectFailed"` when the canary is ok.
 * Reverting the observer → finalize threading fails this test.
 */

const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());
const pinnedFetchMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
    streamText: (...args: unknown[]) => streamTextMock(...args),
    stepCountIs: vi.fn(() => undefined),
  };
});

vi.mock("../../../utils/chat-helpers", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-helpers")
  >("../../../utils/chat-helpers");
  return {
    ...actual,
    createLlmModel: vi.fn(() => ({ id: "mock-model" })),
  };
});

vi.mock("../../../utils/mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

vi.mock("@/shared/http-tool-calls", () => ({
  hasUnresolvedToolCalls: vi.fn().mockReturnValue(false),
  executeToolCallsFromMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../utils/chat-v2-orchestration", () => ({
  prepareChatV2: vi.fn(async (options: any) => ({
    allTools: {},
    enhancedSystemPrompt: options?.systemPrompt ?? "",
    resolvedTemperature: options?.temperature,
    scrubMessages: (msgs: unknown[]) => msgs,
    progressivePlan: { enabled: false },
    discoveryState: {
      loadedToolIds: new Set<string>(),
      catalogVersion: 0,
    },
  })),
}));

vi.mock("../../../utils/pinned-fetch", () => ({
  createPinnedFetch: () => pinnedFetchMock,
}));

import { runEvalSuiteWithAiSdk } from "../../evals-runner";

describe("run-level connect failure — D6 non-vacuity", () => {
  const convexClient = {
    mutation: vi.fn(),
    query: vi.fn(),
    action: vi.fn(),
  };
  const mcpClientManager = {
    getToolsForAiSdk: vi.fn(),
    listTools: vi.fn(),
    getConnectionStatus: vi.fn(),
    listServers: vi.fn(),
    getAllToolsMetadata: vi.fn().mockReturnValue({}),
    executeTool: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    convexClient.mutation.mockResolvedValue({ iterationId: "iter-1" });
    convexClient.action.mockResolvedValue(undefined);
    mcpClientManager.listServers.mockReturnValue(["srv-1"]);
    mcpClientManager.getToolsForAiSdk.mockResolvedValue({});
    pinnedFetchMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    delete process.env.CONVEX_HTTP_URL;
  });

  it("persists connectFailed on a theirs-shaped refused connect with a verified canary", async () => {
    mcpClientManager.getConnectionStatus.mockReturnValue("disconnected");
    const refused = new Error("connect ECONNREFUSED 203.0.113.10:443");
    (refused as Error & { code: string }).code = "ECONNREFUSED";
    // Connect and tools/list are ONE round trip now: `getToolsForAiSdk`
    // ensures the session before listing, so a connect miss surfaces
    // as a rejection from it while `getConnectionStatus` stays
    // disconnected — that pairing is what marks the connection phase.
    mcpClientManager.getToolsForAiSdk.mockRejectedValue(refused);

    let detailsCalls = 0;
    convexClient.query.mockImplementation(async (ref: string) => {
      if (ref === "testSuites:getTestSuiteRunDetails") {
        detailsCalls += 1;
        // First read (and the retry read if the write is treated as
        // unacked) still sees pending; after finishIteration the next
        // re-read is empty so the sweep never strips stage metadata.
        if (detailsCalls <= 1) {
          return {
            iterations: [
              {
                _id: "iter-pending",
                status: "pending",
                testCaseId: "case-1",
                testCaseSnapshot: {
                  query: "Hello",
                  expectedToolCalls: [],
                },
              },
            ],
          };
        }
        return { iterations: [] };
      }
      return { status: "running" };
    });

    const recorder = {
      runId: "run-1",
      suiteId: "suite-1",
      startIteration: vi.fn(),
      finishIteration: vi.fn(),
      finalize: vi.fn(),
    };

    await expect(
      runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: "run-1",
        recorder,
        config: {
          tests: [
            {
              title: "Case",
              query: "Hello",
              runs: 1,
              model: "gpt-4-turbo",
              provider: "openai",
              expectedToolCalls: [],
              promptTurns: [
                { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
              ],
              testCaseId: "case-1",
            },
          ],
          environment: { servers: ["srv-1"] },
        },
        modelApiKeys: { openai: "sk-test" },
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: mcpClientManager as any,
        testCaseId: "case-1",
      } as any)
    ).rejects.toThrow("is not connected");

    expect(pinnedFetchMock).toHaveBeenCalled();
    expect(recorder.finishIteration).toHaveBeenCalled();
    const finish = recorder.finishIteration.mock.calls[0]![0] as {
      metadata?: {
        stageResults?: Array<{ stage: string; state: string; reason?: string }>;
      };
      spans?: Array<{ id: string; category: string }>;
    };
    expect(finish.metadata?.stageResults?.[0]).toMatchObject({
      stage: "connection",
      state: "failed",
      reason: "connectFailed",
    });
    expect(finish.spans?.some((s) => s.category === "connection")).toBe(true);
    expect(recorder.finalize).toHaveBeenCalledWith({
      status: "failed",
      summary: undefined,
    });
    expect(convexClient.mutation).not.toHaveBeenCalledWith(
      "testSuites:markSetupPendingIterationsFailed",
      expect.anything()
    );
  });

  it("does not guess a connectFailed when the canary itself fails", async () => {
    mcpClientManager.getConnectionStatus.mockReturnValue("disconnected");
    const refused = new Error("connect ECONNREFUSED 203.0.113.10:443");
    (refused as Error & { code: string }).code = "ECONNREFUSED";
    // Connect and tools/list are ONE round trip now: `getToolsForAiSdk`
    // ensures the session before listing, so a connect miss surfaces
    // as a rejection from it while `getConnectionStatus` stays
    // disconnected — that pairing is what marks the connection phase.
    mcpClientManager.getToolsForAiSdk.mockRejectedValue(refused);
    pinnedFetchMock.mockResolvedValue({ ok: false });

    convexClient.query.mockImplementation(async (ref: string) => {
      if (ref === "testSuites:getTestSuiteRunDetails") {
        return {
          iterations: [
            {
              _id: "iter-pending",
              status: "pending",
              testCaseId: "case-1",
            },
          ],
        };
      }
      return { status: "running" };
    });

    const recorder = {
      runId: "run-1",
      suiteId: "suite-1",
      startIteration: vi.fn(),
      finishIteration: vi.fn().mockImplementation(async () => {
        // Leave the row pending so we exercise retry; the assertion is
        // the reason, not the sweep.
      }),
      finalize: vi.fn(),
    };

    await expect(
      runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: "run-1",
        recorder,
        config: {
          tests: [
            {
              title: "Case",
              query: "Hello",
              runs: 1,
              model: "gpt-4-turbo",
              provider: "openai",
              expectedToolCalls: [],
              promptTurns: [
                { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
              ],
              testCaseId: "case-1",
            },
          ],
          environment: { servers: ["srv-1"] },
        },
        modelApiKeys: { openai: "sk-test" },
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: mcpClientManager as any,
        testCaseId: "case-1",
      } as any)
    ).rejects.toThrow("is not connected");

    const finish = recorder.finishIteration.mock.calls[0]![0] as {
      metadata?: {
        stageResults?: Array<{ reason?: string; state?: string }>;
      };
    };
    expect(finish.metadata?.stageResults?.[0]).toMatchObject({
      state: "notMeasured",
      reason: "egressUnverified",
    });
  });

  it("finalizes even when pending-row reads throw", async () => {
    mcpClientManager.getConnectionStatus.mockReturnValue("disconnected");
    const refused = new Error("connect ECONNREFUSED 203.0.113.10:443");
    (refused as Error & { code: string }).code = "ECONNREFUSED";
    // Connect and tools/list are ONE round trip now: `getToolsForAiSdk`
    // ensures the session before listing, so a connect miss surfaces
    // as a rejection from it while `getConnectionStatus` stays
    // disconnected — that pairing is what marks the connection phase.
    mcpClientManager.getToolsForAiSdk.mockRejectedValue(refused);

    convexClient.query.mockImplementation(async (ref: string) => {
      if (ref === "testSuites:getTestSuiteRunDetails") {
        throw new Error("convex unavailable");
      }
      return { status: "running" };
    });

    const recorder = {
      runId: "run-1",
      suiteId: "suite-1",
      startIteration: vi.fn(),
      finishIteration: vi.fn(),
      finalize: vi.fn(),
    };

    await expect(
      runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: "run-1",
        recorder,
        config: {
          tests: [
            {
              title: "Case",
              query: "Hello",
              runs: 1,
              model: "gpt-4-turbo",
              provider: "openai",
              expectedToolCalls: [],
              promptTurns: [
                { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
              ],
              testCaseId: "case-1",
            },
          ],
          environment: { servers: ["srv-1"] },
        },
        modelApiKeys: { openai: "sk-test" },
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: mcpClientManager as any,
        testCaseId: "case-1",
      } as any)
    ).rejects.toThrow("is not connected");

    expect(recorder.finalize).toHaveBeenCalledWith({
      status: "failed",
      summary: undefined,
    });
    expect(convexClient.mutation).toHaveBeenCalledWith(
      "testSuites:markSetupPendingIterationsFailed",
      expect.objectContaining({ runId: "run-1" })
    );
  });

  it("does not run the canary for a theirs tools/list miss after initialize", async () => {
    mcpClientManager.getConnectionStatus.mockReturnValue("connected");
    const refused = new Error("connect ECONNREFUSED 203.0.113.10:443");
    (refused as Error & { code: string }).code = "ECONNREFUSED";
    mcpClientManager.getToolsForAiSdk.mockRejectedValue(refused);

    convexClient.query.mockImplementation(async (ref: string) => {
      if (ref === "testSuites:getTestSuiteRunDetails") {
        return {
          iterations: [
            {
              _id: "iter-pending",
              status: "pending",
              testCaseId: "case-1",
              testCaseSnapshot: { query: "Hello", expectedToolCalls: [] },
            },
          ],
        };
      }
      return { status: "running" };
    });

    const recorder = {
      runId: "run-1",
      suiteId: "suite-1",
      startIteration: vi.fn(),
      finishIteration: vi.fn(),
      finalize: vi.fn(),
    };

    await expect(
      runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: "run-1",
        recorder,
        config: {
          tests: [
            {
              title: "Case",
              query: "Hello",
              runs: 1,
              model: "gpt-4-turbo",
              provider: "openai",
              expectedToolCalls: [],
              promptTurns: [
                { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
              ],
              testCaseId: "case-1",
            },
          ],
          environment: { servers: ["srv-1"] },
        },
        modelApiKeys: { openai: "sk-test" },
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: mcpClientManager as any,
        testCaseId: "case-1",
      } as any)
    ).rejects.toThrow();

    expect(pinnedFetchMock).not.toHaveBeenCalled();
    const finish = recorder.finishIteration.mock.calls[0]![0] as {
      metadata?: {
        stageResults?: Array<{ stage: string; state: string; reason?: string }>;
      };
    };
    expect(finish.metadata?.stageResults?.find((r) => r.stage === "discovery")).toMatchObject({
      state: "failed",
      reason: "toolsListFailed",
    });
  });
});
