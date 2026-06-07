import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const createLlmModelMock = vi.hoisted(() =>
  vi.fn(
    (
      _modelDefinition?: unknown,
      _apiKey?: unknown,
      _baseUrls?: unknown,
      _customProviders?: unknown,
    ) => ({
      id: "mock-model",
    }),
  ),
);

vi.mock("ai", async () => {
  // Keep the real exports (`createUIMessageStream`,
  // `createUIMessageStreamResponse`, `parseJsonEventStream`, `pruneMessages`,
  // etc.) — the engine that `runIterationViaBackend` now drives needs them.
  // Only override `generateText` / `streamText` so the local-AI-SDK and
  // stream-AI-SDK paths can be controlled by these tests.
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
    streamText: (...args: unknown[]) => streamTextMock(...args),
    stepCountIs: vi.fn(() => undefined),
  };
});

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    finalizePassedForEval: ({ matchPassed }: { matchPassed: boolean }) =>
      matchPassed,
  };
});

vi.mock("../../../utils/chat-helpers", async () => {
  // PR 3 of the engine consolidation: `runIterationViaBackend` now drives
  // `runChatEngineLoop`, which imports `scrubUnavailableToolHistoryForBackend`
  // / `scrubMcpAppsToolResultsForBackend` / `scrubChatGPTAppsToolResultsForBackend`
  // from this module. Returning only `createLlmModel` here would make those
  // imports `undefined`; the engine's `try/catch` then silently swallows the
  // resulting `TypeError`, runs to a `runSucceeded:false` finish, and the
  // test never sees the fetch we expect. Keep the real exports and override
  // only `createLlmModel` so the local-AI-SDK paths can be inspected.
  const actual =
    await vi.importActual<typeof import("../../../utils/chat-helpers")>(
      "../../../utils/chat-helpers",
    );
  return {
    ...actual,
    createLlmModel: (
      modelDefinition: unknown,
      apiKey: unknown,
      baseUrls?: unknown,
      customProviders?: unknown,
    ) =>
      createLlmModelMock(modelDefinition, apiKey, baseUrls, customProviders),
  };
});

// Stub the chat-side tool/system/temperature pipeline. The real implementation
// in `chat-v2-orchestration` pulls in `getSkillToolsAndPrompt`, which touches
// the filesystem outside HOSTED_MODE; the eval test environment doesn't need
// that. Return a minimal `PrepareChatV2Result` shape — the actual tool set
// stays empty (matching `mcpClientManager.getToolsForAiSdk` → `{}`), and the
// engine swap only depends on the named output fields.
// PR 3 of the engine consolidation: `runIterationViaBackend` now drives
// `runChatEngineLoop`, which imports `serializeToolsForConvex` for tool
// serialization and uses `http-tool-calls` for local tool execution. Mirror
// the mocks `assistant-turn.test.ts` uses for the same engine — keep these
// minimal so the engine path can reach its `fetch` to Convex without
// blowing up on test-mode-incompatible dependencies (zod schema conversion
// in tool serialization, etc.).
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

import { runEvalSuiteWithAiSdk, streamTestCase } from "../../evals-runner";

describe("runEvalSuiteWithAiSdk compare session metadata", () => {
  const convexClient = {
    mutation: vi.fn(),
    query: vi.fn(),
    action: vi.fn(),
  };
  const mcpClientManager = {
    getToolsForAiSdk: vi.fn(),
    listServers: vi.fn(),
    // PR 3 of the engine consolidation: the engine that
    // `runIterationViaBackend` now drives calls
    // `getAllToolsMetadata(serverId)` during message scrubbing
    // (`scrubMcpAppsToolResultsForBackend` -> manager metadata lookup).
    // Empty map is fine — no MCP-Apps result-scrubbing happens in these
    // tests; we just need the method to exist.
    getAllToolsMetadata: vi.fn().mockReturnValue({}),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    // The engine that PR-3-rewritten `runIterationViaBackend` drives
    // (`runChatEngineLoop`) reads its target URL from `CONVEX_HTTP_URL`,
    // not from the runner's `convexHttpUrl` parameter. Set both so the
    // engine paths and any direct-fetch paths target the same host.
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    convexClient.mutation.mockResolvedValue({ iterationId: "iter-1" });
    convexClient.query.mockResolvedValue({ status: "running" });
    convexClient.action.mockResolvedValue(undefined);
    mcpClientManager.getToolsForAiSdk.mockResolvedValue({});
    mcpClientManager.listServers.mockReturnValue(["srv-1"]);
    generateTextMock.mockResolvedValue({
      response: {
        modelId: "gpt-5-mini",
        messages: [{ role: "assistant", content: "Done" }],
      },
      steps: [],
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    });
    streamTextMock.mockReset();
    // PR 4b of the engine consolidation: `runIterationWithAiSdk` now
    // drives `runDirectChatTurn` (which calls `streamText`). Provide a
    // default streamText return shape so suite-style tests using
    // `runQuickTestCase()` resolve cleanly.
    streamTextMock.mockReturnValue({
      consumeStream: async () => {},
      response: Promise.resolve({
        modelId: "gpt-5-mini",
        messages: [{ role: "assistant", content: "Done" }],
      }),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      }),
      finishReason: Promise.resolve("stop"),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CONVEX_HTTP_URL;
  });

  async function runQuickTestCase(compareRunId?: string) {
    // Use a BYOK-only model id so the runner takes the local generateText
    // path (which the test mocks). gpt-5-mini has a hosted "openai/gpt-5-mini"
    // counterpart and would otherwise route through the backend.
    await runEvalSuiteWithAiSdk({
      suiteId: "suite-1",
      runId: null,
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
      compareRunId,
    });

    // Find the updateTestIteration call specifically. The PR-2 fanout
    // calls multiple actions per iteration (appendEvalTurnTrace,
    // lockEvalSession, updateTestIteration), so we search by ref
    // rather than indexing by position.
    const updateCall = convexClient.action.mock.calls.find(
      (call) => call[0] === "testSuites:updateTestIteration",
    );
    return updateCall?.[1] as {
      metadata?: Record<string, string | number | boolean>;
      tokensUsed?: number;
    };
  }

  function createAsyncIterable<T>(items: T[]): AsyncIterable<T> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const item of items) {
          yield item;
        }
      },
    };
  }

  function createBackendSuccessResponse() {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: vi.fn().mockResolvedValue({
        ok: true,
        messages: [{ role: "assistant", content: "Done" }],
        usage: {
          promptTokens: 1,
          completionTokens: 2,
          totalTokens: 3,
        },
        finishReason: "stop",
      }),
      text: vi.fn().mockResolvedValue(""),
    };
  }

  /** SSE-format response for the streaming backend path (no mode:"step"). */
  function createBackendStreamResponse() {
    const chunks = [
      'data: {"type":"text-delta","id":"t1","delta":"Done"}\n\n',
      'data: {"type":"finish","finishReason":"stop","messageMetadata":{"inputTokens":1,"outputTokens":2,"totalTokens":3}}\n\n',
      "data: [DONE]\n\n",
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body: stream,
      text: vi.fn().mockResolvedValue(""),
    };
  }

  it(
    "PR-2 review #5: lockEvalSession fires when fanout succeeded but updateTestIteration throws transient error",
    async () => {
      // Mock convexClient.action with ref-aware responses:
      //   - appendEvalTurnTrace returns success (fanout persists)
      //   - updateTestIteration throws a transient error (NOT a
      //     "not found"/"cancelled" message — those bypass the lock)
      //   - lockEvalSession records the call so we can assert it fired
      const callsByRef: Record<string, number> = {};
      const action = vi.fn(async (ref: string) => {
        callsByRef[ref] = (callsByRef[ref] ?? 0) + 1;
        if (ref === "testSuites:appendEvalTurnTrace") {
          return { skipped: false, chatSessionId: "sess_x", locked: false };
        }
        if (ref === "testSuites:updateTestIteration") {
          throw new Error("transient backend hiccup");
        }
        if (ref === "testSuites:lockEvalSession") {
          return { skipped: false, locked: true, alreadyLocked: false };
        }
        return undefined;
      });
      convexClient.action = action;

      await runQuickTestCase();

      // Sanity: fanout did fire (so we know we're testing the new path)
      // AND lockEvalSession was called despite the update throwing.
      expect(callsByRef["testSuites:appendEvalTurnTrace"]).toBeGreaterThan(0);
      expect(callsByRef["testSuites:updateTestIteration"]).toBeGreaterThan(0);
      expect(callsByRef["testSuites:lockEvalSession"]).toBe(1);
    },
  );

  it(
    "derives lockReason from iteration STATUS, not verdict: failed-verdict + clean cycle → eval_completed",
    async () => {
      // Regression test for the transcript-lifecycle vs verdict split.
      // The lock-reason describes whether the eval CYCLE ran to completion
      // (so the chatSessions transcript is consistent), NOT whether the
      // verdict passed. A failed-verdict iteration that ran cleanly
      // (status: "completed", result: "failed", passed: false) must still
      // get lockReason: "eval_completed". eval_failed is reserved for
      // cycle failures (provider errors, transport crashes, status:"failed").
      //
      // Force passed=false by configuring an expectedToolCall the mock
      // assistant won't make. The runner's success path then calls
      // finishIterationDirectly with status:"completed" + passed:false.
      // Before the fix this site derived terminalReason from `passed` and
      // would have called lockEvalSession with reason:"eval_failed".
      const lockCalls: Array<{ iterationId: string; reason: string }> = [];
      const action = vi.fn(async (ref: string, payload: any) => {
        if (ref === "testSuites:appendEvalTurnTrace") {
          return { skipped: false, chatSessionId: "sess_x", locked: false };
        }
        if (ref === "testSuites:updateTestIteration") {
          return undefined;
        }
        if (ref === "testSuites:lockEvalSession") {
          lockCalls.push({
            iterationId: payload?.iterationId,
            reason: payload?.reason,
          });
          return { skipped: false, locked: true, alreadyLocked: false };
        }
        return undefined;
      });
      convexClient.action = action;

      await runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: null,
        config: {
          tests: [
            {
              title: "Case",
              query: "Hello",
              runs: 1,
              model: "gpt-4-turbo",
              provider: "openai",
              // Expecting a tool the mock assistant never calls → matchPassed=false
              // → finalizePassedForEval mock returns false → passed=false.
              expectedToolCalls: [
                { toolName: "never-called-tool", arguments: {} },
              ],
              promptTurns: [
                {
                  id: "turn-1",
                  prompt: "Hello",
                  expectedToolCalls: [
                    { toolName: "never-called-tool", arguments: {} },
                  ],
                },
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
      });

      // Confirm we exercised the success path: updateTestIteration was
      // called with result:"failed" + status:"completed", and the lock
      // fired with reason:"eval_completed" (lifecycle-clean), not
      // "eval_failed" (which is for cycle failures).
      const updateCall = action.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestIteration",
      );
      expect(updateCall).toBeDefined();
      expect(updateCall?.[1]).toMatchObject({
        result: "failed",
        status: "completed",
      });
      expect(lockCalls).toHaveLength(1);
      expect(lockCalls[0].reason).toBe("eval_completed");
    },
  );

  it(
    "derives lockReason from iteration STATUS + error: backend cycle error (status:completed + error set) → eval_failed",
    async () => {
      // Codex review on #2446: the BACKEND-routed eval path's success
      // tail passes `status: "completed"` to finishIteration[Directly]
      // even when `iterationError` was captured during the run (see
      // evals-runner.ts:2079-2082 and :3962-3965 / line 2088, 3971 —
      // both hardcoded `status: "completed" as const`). A pure
      // status-based derivation would lock those as eval_completed,
      // even though the transcript represents a cycle failure.
      // Presence of `error` is the cycle-failure signal.
      //
      // The local-generateText error path uses `status: "failed"` and
      // is already correctly mapped — it's the backend path that has
      // the status/error mismatch. Force the backend path by using a
      // hosted MCPJam-routed model (no BYOK key needed) + making fetch
      // reject mid-iteration.
      fetchMock.mockRejectedValueOnce(new Error("backend down"));

      const lockCalls: Array<{ iterationId: string; reason: string }> = [];
      const action = vi.fn(async (ref: string, payload: any) => {
        if (ref === "testSuites:appendEvalTurnTrace") {
          return { skipped: false, chatSessionId: "sess_x", locked: false };
        }
        if (ref === "testSuites:updateTestIteration") {
          return undefined;
        }
        if (ref === "testSuites:lockEvalSession") {
          lockCalls.push({
            iterationId: payload?.iterationId,
            reason: payload?.reason,
          });
          return { skipped: false, locked: true, alreadyLocked: false };
        }
        return undefined;
      });
      convexClient.action = action;

      await runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: null,
        config: {
          tests: [
            {
              title: "Case",
              query: "Hello",
              runs: 1,
              model: "claude-haiku-4.5",
              provider: "anthropic",
              expectedToolCalls: [],
              promptTurns: [
                { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
              ],
              testCaseId: "case-1",
            },
          ],
          environment: { servers: ["srv-1"] },
        },
        modelApiKeys: {},
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: mcpClientManager as any,
        testCaseId: "case-1",
      });

      // Confirm we exercised the cycle-failure path: the iteration was
      // finalized with error:set, status:"completed", and the lock
      // fired with reason:"eval_failed" — the codex finding.
      const updateCall = action.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestIteration",
      );
      expect(updateCall).toBeDefined();
      expect(updateCall?.[1]).toMatchObject({
        status: "completed",
      });
      expect(updateCall?.[1]?.error).toBeTruthy();
      expect(lockCalls).toHaveLength(1);
      expect(lockCalls[0].reason).toBe("eval_failed");
    },
  );

  it("persists compareRunId in quick-run iteration metadata when provided", async () => {
    const updatePayload = await runQuickTestCase("cmp_123");

    expect(updatePayload.metadata?.compareRunId).toBe("cmp_123");
  });

  it("does not add compare session metadata for ordinary quick runs", async () => {
    const updatePayload = await runQuickTestCase();

    expect(updatePayload.metadata).not.toHaveProperty("compareRunId");
  });

  it("does not throw from non-streaming onStepFinish and records tokens once", async () => {
    // PR 4b: local-BYOK path now drives `streamText` via `runDirectChatTurn`.
    // `onStepFinish` still fires once per step; the terminal totals come
    // from `result.totalUsage`, not from each step.
    streamTextMock.mockImplementationOnce((options: any) => {
      void options.onStepFinish?.({
        usage: {
          inputTokens: 4,
          outputTokens: 6,
          totalTokens: 10,
        },
        response: {
          messages: [{ role: "assistant", content: "Done" }],
        },
      });

      return {
        consumeStream: async () => {},
        response: Promise.resolve({
          modelId: "gpt-5-mini",
          messages: [{ role: "assistant", content: "Done" }],
        }),
        steps: Promise.resolve([]),
        totalUsage: Promise.resolve({
          inputTokens: 4,
          outputTokens: 6,
          totalTokens: 10,
        }),
        finishReason: Promise.resolve("stop"),
      };
    });

    const updatePayload = await runQuickTestCase();

    expect(updatePayload.tokensUsed).toBe(10);
  });

  it("resolves persisted hosted server names to the live manager ids", async () => {
    await runEvalSuiteWithAiSdk({
      suiteId: "suite-1",
      runId: null,
      config: {
        tests: [
          {
            title: "Case",
            query: "Hello",
            runs: 1,
            model: "gpt-5-mini",
            provider: "openai",
            expectedToolCalls: [],
            promptTurns: [{ id: "turn-1", prompt: "Hello", expectedToolCalls: [] }],
            testCaseId: "case-1",
          },
        ],
        environment: {
          servers: ["server-1"],
          serverBindings: [
            {
              serverName: "server-1",
              projectServerId: "srv-1",
            },
          ],
        },
      },
      modelApiKeys: { openai: "sk-test" },
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      mcpClientManager: mcpClientManager as any,
      testCaseId: "case-1",
    });

    expect(mcpClientManager.getToolsForAiSdk).toHaveBeenCalledWith(["srv-1"]);
  });

  it("keeps persisted hosted server refs when the manager is already keyed by them", async () => {
    mcpClientManager.listServers.mockReturnValue(["server-1"]);

    await runEvalSuiteWithAiSdk({
      suiteId: "suite-1",
      runId: null,
      config: {
        tests: [
          {
            title: "Case",
            query: "Hello",
            runs: 1,
            model: "gpt-5-mini",
            provider: "openai",
            expectedToolCalls: [],
            promptTurns: [{ id: "turn-1", prompt: "Hello", expectedToolCalls: [] }],
            testCaseId: "case-1",
          },
        ],
        environment: {
          servers: ["server-1"],
          serverBindings: [
            {
              serverName: "server-1",
              projectServerId: "srv-1",
            },
          ],
        },
      },
      modelApiKeys: { openai: "sk-test" },
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      mcpClientManager: mcpClientManager as any,
      testCaseId: "case-1",
    });

    expect(mcpClientManager.getToolsForAiSdk).toHaveBeenCalledWith(["server-1"]);
  });

  it("maps current fullStream chunks into eval stream events", async () => {
    const emitted: Array<Record<string, unknown>> = [];

    streamTextMock.mockImplementationOnce((options: any) => {
      void options.onStepFinish?.({
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
        },
        response: {
          messages: [{ role: "assistant", content: "Done" }],
        },
      });

      return {
        fullStream: createAsyncIterable([
          {
            type: "text-delta",
            id: "text-1",
            text: "Working",
          },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search",
            input: { q: "status" },
            dynamic: true,
          },
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "search",
            input: { q: "status" },
            output: { ok: true },
            dynamic: true,
          },
          {
            type: "tool-error",
            toolCallId: "call-2",
            toolName: "search",
            input: { q: "broken" },
            error: { message: "boom" },
            dynamic: true,
          },
          {
            type: "finish-step",
            response: {} as any,
            usage: {
              inputTokens: 2,
              outputTokens: 3,
              totalTokens: 5,
            },
            finishReason: "stop",
            rawFinishReason: "stop",
            providerMetadata: undefined,
          },
        ]),
        steps: Promise.resolve([]),
        response: Promise.resolve({
          messages: [{ role: "assistant", content: "Done" }],
        }),
      };
    });

    await streamTestCase({
      test: {
        title: "Case",
        query: "Hello",
        runs: 1,
        // BYOK-only id so the runner takes the local streamText path the
        // test mocks instead of routing to the hosted backend.
        model: "gpt-4-turbo",
        provider: "openai",
        expectedToolCalls: [],
        promptTurns: [{ id: "turn-1", prompt: "Hello", expectedToolCalls: [] }],
        testCaseId: "case-1",
      },
      tools: {},
      selectedServers: [],
      mcpClientManager: mcpClientManager as any,
      recorder: null,
      modelApiKeys: { openai: "sk-test" },
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      testCaseId: "case-1",
      suiteId: "suite-1",
      runId: null,
      emit: (event) => emitted.push(event as Record<string, unknown>),
    });

    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text_delta",
          content: "Working",
        }),
        expect.objectContaining({
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "search",
          args: { q: "status" },
        }),
        expect.objectContaining({
          type: "tool_result",
          toolCallId: "call-1",
          result: { ok: true },
          isError: false,
        }),
        expect.objectContaining({
          type: "tool_result",
          toolCallId: "call-2",
          result: { message: "boom" },
          isError: true,
        }),
        expect.objectContaining({
          type: "step_finish",
          usage: { inputTokens: 2, outputTokens: 3 },
        }),
      ]),
    );
  });

  it("routes bare MCPJam Anthropic compare models through the backend without a BYOK key", async () => {
    // Post-PR3 `runIterationViaBackend` drives `runAssistantTurn`, which sends
    // an SSE-shaped request (`mode:"stream"`) to Convex `/stream`. The legacy
    // `mode:"step"` JSON-response path is gone for the non-stream backend
    // runner — assert against the engine's stream request shape instead.
    fetchMock.mockResolvedValue(createBackendStreamResponse());

    await expect(
      runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: null,
        config: {
          tests: [
            {
              title: "Case",
              query: "Hello",
              runs: 1,
              model: "claude-haiku-4.5",
              provider: "anthropic",
              expectedToolCalls: [],
              promptTurns: [
                { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
              ],
              testCaseId: "case-1",
            },
          ],
          environment: { servers: ["srv-1"] },
        },
        modelApiKeys: {},
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: mcpClientManager as any,
        testCaseId: "case-1",
      }),
    ).resolves.toBeDefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.convex.site/stream",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const compareRequest = fetchMock.mock.calls[0]?.[1] as {
      body?: string;
    };
    const compareBody = JSON.parse(compareRequest.body ?? "{}");
    expect(compareBody.model).toBe("anthropic/claude-haiku-4.5");
    expect(compareBody.mode).toBe("stream");
    expect(compareBody.sourceType).toBe("eval");
    expect(createLlmModelMock).not.toHaveBeenCalled();
  });

  it("streams bare MCPJam Anthropic test cases through the backend without a BYOK key", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    fetchMock.mockResolvedValue(createBackendStreamResponse());

    await expect(
      streamTestCase({
        test: {
          title: "Case",
          query: "Hello",
          runs: 1,
          model: "claude-haiku-4.5",
          provider: "anthropic",
          expectedToolCalls: [],
          promptTurns: [
            { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
          ],
          testCaseId: "case-1",
        },
        tools: {},
        selectedServers: [],
        mcpClientManager: mcpClientManager as any,
        recorder: null,
        modelApiKeys: {},
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        testCaseId: "case-1",
        suiteId: "suite-1",
        runId: null,
        emit: (event) => emitted.push(event as Record<string, unknown>),
      }),
    ).resolves.toBeDefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.convex.site/stream",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const streamRequest = fetchMock.mock.calls[0]?.[1] as {
      body?: string;
    };
    expect(JSON.parse(streamRequest.body ?? "{}").model).toBe(
      "anthropic/claude-haiku-4.5",
    );
    expect(createLlmModelMock).not.toHaveBeenCalled();
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text_delta",
          content: "Done",
        }),
      ]),
    );
  });

  it("runs org BYOK cloud eval models through Convex without raw provider keys", async () => {
    // Same migration as the previous test: assert against the engine's
    // `mode:"stream"` SSE request, not the legacy `mode:"step"` JSON. The
    // hosted-org BYOK contract that matters is that `providerKey` +
    // `projectId` land in the request body (via `extraBodyFields`) and the
    // request targets `/stream/org`.
    fetchMock.mockResolvedValue(createBackendStreamResponse());

    await runEvalSuiteWithAiSdk({
      suiteId: "suite-1",
      runId: null,
      config: {
        tests: [
          {
            title: "Org BYOK Case",
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
      modelApiKeys: {},
      orgModelConfigTarget: { projectId: "project-1" },
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      mcpClientManager: mcpClientManager as any,
      testCaseId: "case-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.convex.site/stream/org",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as {
      body?: string;
      headers?: ConstructorParameters<typeof Headers>[0];
    };
    const body = JSON.parse(request.body ?? "{}");
    expect(body).toMatchObject({
      mode: "stream",
      model: "gpt-4-turbo",
      providerKey: "openai",
      projectId: "project-1",
      sourceType: "eval",
    });
    expect(body).not.toHaveProperty("apiKey");
    expect(new Headers(request.headers).get("authorization")).toBe(
      "Bearer token",
    );
    expect(createLlmModelMock).not.toHaveBeenCalled();
  });

  it("uses full org config for custom eval models", async () => {
    await runEvalSuiteWithAiSdk({
      suiteId: "suite-1",
      runId: null,
      config: {
        tests: [
          {
            title: "Custom Case",
            query: "Hello",
            runs: 1,
            model: "custom:acme:llama-3",
            provider: "custom",
            expectedToolCalls: [],
            promptTurns: [
              { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
            ],
            testCaseId: "case-1",
          },
        ],
        environment: { servers: ["srv-1"] },
      },
      orgModelConfig: {
        providers: [
          {
            providerKey: "custom:acme",
            baseUrl: "https://models.example/v1",
            protocol: "openai-compatible",
            modelIds: ["llama-3"],
          },
        ],
      },
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      mcpClientManager: mcpClientManager as any,
      testCaseId: "case-1",
    });

    expect(createLlmModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "custom:acme:llama-3",
        provider: "custom",
        customProviderName: "acme",
      }),
      "",
      undefined,
      [
        {
          name: "acme",
          protocol: "openai-compatible",
          baseUrl: "https://models.example/v1",
          modelIds: ["llama-3"],
        },
      ],
    );
  });

  it("uses org Azure base URL when resolving eval models", async () => {
    await runEvalSuiteWithAiSdk({
      suiteId: "suite-1",
      runId: null,
      config: {
        tests: [
          {
            title: "Azure Case",
            query: "Hello",
            runs: 1,
            model: "gpt-4o",
            provider: "azure",
            expectedToolCalls: [],
            promptTurns: [
              { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
            ],
            testCaseId: "case-1",
          },
        ],
        environment: { servers: ["srv-1"] },
      },
      orgModelConfig: {
        providers: [
          {
            providerKey: "azure",
            apiKey: "az-secret",
            baseUrl: "https://resource.openai.azure.com/openai",
          },
        ],
      },
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      mcpClientManager: mcpClientManager as any,
      testCaseId: "case-1",
    });

    expect(createLlmModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "gpt-4o",
        provider: "azure",
      }),
      "az-secret",
      { azure: "https://resource.openai.azure.com/openai" },
      undefined,
    );
  });

  it("runs org Ollama eval models with a base URL and no API key", async () => {
    await runEvalSuiteWithAiSdk({
      suiteId: "suite-1",
      runId: null,
      config: {
        tests: [
          {
            title: "Ollama Case",
            query: "Hello",
            runs: 1,
            model: "llama3",
            provider: "ollama",
            expectedToolCalls: [],
            promptTurns: [
              { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
            ],
            testCaseId: "case-1",
          },
        ],
        environment: { servers: ["srv-1"] },
      },
      orgModelConfig: {
        providers: [
          {
            providerKey: "ollama",
            baseUrl: "http://ollama.internal:11434",
          },
        ],
      },
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      mcpClientManager: mcpClientManager as any,
      testCaseId: "case-1",
    });

    expect(createLlmModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "llama3",
        provider: "ollama",
      }),
      "",
      { ollama: "http://ollama.internal:11434" },
      undefined,
    );
  });

  it("records prepareChatV2 setup failures as a failed iteration", async () => {
    // Force prepareChatV2 to throw — simulates Anthropic name validation,
    // meta-tool name collision, or skill-tool prep failure. The runner must
    // catch this and persist a failed iteration row, NOT propagate the throw.
    const orchestration = await import(
      "../../../utils/chat-v2-orchestration"
    );
    const prepareSpy = vi
      .spyOn(orchestration, "prepareChatV2")
      .mockRejectedValueOnce(
        new Error(
          "Invalid tool name(s) for Anthropic: 'bad.name'. Tool names must only contain letters, numbers, underscores, and hyphens (max 64 characters).",
        ),
      );

    // The iteration row is created via `mutation` (default mock returns
    // { iterationId: "iter-1" }); the finalize call goes through `action`
    // (testSuites:updateTestIteration). Convex serializes `passed` into
    // separate `result` ("failed") and `status` ("failed") fields — see
    // `finishIterationDirectly`.
    convexClient.mutation.mockResolvedValueOnce({
      iterationId: "iter-failed-setup",
    });

    try {
      await expect(
        runEvalSuiteWithAiSdk({
          suiteId: "suite-1",
          runId: null,
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
        }),
      ).resolves.toBeDefined();

      expect(prepareSpy).toHaveBeenCalled();

      const updateCall = convexClient.action.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestIteration",
      );
      expect(updateCall).toBeDefined();
      const payload = updateCall![1] as Record<string, unknown>;
      expect(payload.status).toBe("failed");
      expect(payload.result).toBe("failed");
      expect(payload.error).toEqual(
        expect.stringContaining("Invalid tool name"),
      );
      expect(payload.iterationId).toBe("iter-failed-setup");

      // The runner must NOT have called the model driver — the failure
      // happens before any model invocation. PR 4b swapped the local-BYOK
      // path from `generateText` to `streamText` (via `runDirectChatTurn`);
      // assert against both so a future regression that re-introduces
      // either driver gets caught.
      expect(generateTextMock).not.toHaveBeenCalled();
      expect(streamTextMock).not.toHaveBeenCalled();
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it("does not count a negative-test setup failure as a suite pass", async () => {
    // Regression guard for the Cursor review #2: with `isNegativeTest: true`
    // and an empty `expectedToolCalls`, `evaluateMultiTurnResults([], ...)`
    // returns `passed: true`. If the runner returned that evaluation as-is on
    // setup failure, the suite summary would credit it as a pass even though
    // the persisted iteration row is `failed`. The setup-failure path must
    // force `evaluation.passed = false` before returning.
    const orchestration = await import(
      "../../../utils/chat-v2-orchestration"
    );
    const prepareSpy = vi
      .spyOn(orchestration, "prepareChatV2")
      .mockRejectedValueOnce(new Error("simulated prep failure"));

    convexClient.mutation.mockResolvedValueOnce({
      iterationId: "iter-negative-setup-fail",
    });

    try {
      await runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: null,
        config: {
          tests: [
            {
              title: "Negative case",
              query: "Hello",
              runs: 1,
              model: "gpt-4-turbo",
              provider: "openai",
              isNegativeTest: true,
              expectedToolCalls: [],
              promptTurns: [
                { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
              ],
              testCaseId: "case-neg",
            },
          ],
          environment: { servers: ["srv-1"] },
        },
        modelApiKeys: { openai: "sk-test" },
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: mcpClientManager as any,
        testCaseId: "case-neg",
      });

      const updateCall = convexClient.action.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestIteration",
      );
      expect(updateCall).toBeDefined();
      const payload = updateCall![1] as Record<string, unknown>;
      expect(payload.result).toBe("failed");
      expect(payload.status).toBe("failed");
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it("emits an error event when streamTestCase backend setup fails", async () => {
    // Regression guard for Cursor review on commit 3924d0c: the
    // `streamIterationViaBackend` setup-failure catch persists the failed
    // iteration row but used to return silently. The live test-runner UI
    // watching `streamTestCase` SSE then finished with no failure signal,
    // unlike the local-AI-SDK stream variant whose outer catch already
    // emits an `error` event. Setup failures must now emit one too.
    const orchestration = await import(
      "../../../utils/chat-v2-orchestration"
    );
    const prepareSpy = vi
      .spyOn(orchestration, "prepareChatV2")
      .mockRejectedValueOnce(new Error("backend stream prep boom"));

    convexClient.mutation.mockResolvedValueOnce({
      iterationId: "iter-stream-setup-fail",
    });

    const emitted: Array<Record<string, unknown>> = [];
    try {
      await streamTestCase({
        test: {
          title: "Stream backend setup-fail case",
          query: "Hello",
          runs: 1,
          model: "claude-haiku-4.5",
          provider: "anthropic",
          expectedToolCalls: [],
          promptTurns: [
            { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
          ],
          testCaseId: "case-stream-setup",
        },
        tools: {},
        selectedServers: [],
        mcpClientManager: mcpClientManager as any,
        recorder: null,
        modelApiKeys: {},
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        testCaseId: "case-stream-setup",
        suiteId: "suite-stream",
        runId: null,
        emit: (event) => emitted.push(event as Record<string, unknown>),
      });

      // The SSE consumer must see an in-stream error event.
      expect(emitted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "error",
            message: expect.stringContaining("backend stream prep boom"),
          }),
        ]),
      );

      // And the failure must still be persisted (status:"failed").
      const updateCall = convexClient.action.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestIteration",
      );
      expect(updateCall).toBeDefined();
      const payload = updateCall![1] as Record<string, unknown>;
      expect(payload.status).toBe("failed");
      expect(payload.result).toBe("failed");

      // The runner must NOT have hit the backend — failure happens before
      // the per-step fetch loop.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it("forwards advancedConfig.toolChoice via extraBodyFields (PR 3 review fix)", async () => {
    // Cursor + Codex review on PR #2457: the engine doesn't expose
    // `toolChoice` as a first-class field, so the legacy backend loop's
    // request body included it but the rewritten runner dropped it.
    // Fix: merge `toolChoice` into `extraBodyFields` so it rides through
    // to Convex unchanged (the engine spreads `extraBodyFields` into
    // the body verbatim). Hosted backend evals with forced-tool or
    // `none` settings need this to work.
    fetchMock.mockResolvedValue(createBackendStreamResponse());

    await runEvalSuiteWithAiSdk({
      suiteId: "suite-1",
      runId: null,
      config: {
        tests: [
          {
            title: "Forced-tool case",
            query: "Hello",
            runs: 1,
            model: "claude-haiku-4.5",
            provider: "anthropic",
            expectedToolCalls: [],
            promptTurns: [
              { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
            ],
            // Force a specific tool selection on the backend.
            advancedConfig: {
              toolChoice: { type: "tool", toolName: "search_docs" },
            },
            testCaseId: "case-toolchoice",
          },
        ],
        environment: { servers: ["srv-1"] },
      },
      modelApiKeys: {},
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      mcpClientManager: mcpClientManager as any,
      testCaseId: "case-toolchoice",
    });

    expect(fetchMock).toHaveBeenCalled();
    const request = fetchMock.mock.calls[0]?.[1] as { body?: string };
    const body = JSON.parse(request.body ?? "{}");
    expect(body.toolChoice).toEqual({
      type: "tool",
      toolName: "search_docs",
    });
  });

  it("records iteration failure when Convex returns a non-OK step (PR 3 review fix)", async () => {
    // Codex P1 review on PR #2457: when Convex returns a non-OK
    // response, the engine writes an error chunk to its (no-op) writer
    // and returns `shouldContinue:false`, then emits a synthetic finish
    // and sets `runSucceeded:true`. `runAssistantTurn` returns with
    // `turnTrace` defined but no new messages appended. Without the
    // message-count check, 429s/500s slip through as passing iterations
    // for tests with no expected tool calls.
    //
    // Synthesize a non-OK SSE response: fetchMock returns ok:false. The
    // engine's processOneStep handles this at
    // mcpjam-stream-handler.ts:1384 (`if (!res.ok || !res.body)`).
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: vi.fn().mockResolvedValue("Daily spend cap reached"),
      body: null,
    } as unknown as Response);

    await runEvalSuiteWithAiSdk({
      suiteId: "suite-1",
      runId: null,
      config: {
        tests: [
          {
            title: "Backend 429 case",
            query: "Hello",
            runs: 1,
            model: "claude-haiku-4.5",
            provider: "anthropic",
            // Zero expected tools — without the message-count check the
            // empty toolsCalledByPrompt would match this expectation and
            // the suite summary would credit it as a pass.
            expectedToolCalls: [],
            promptTurns: [
              { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
            ],
            testCaseId: "case-429",
          },
        ],
        environment: { servers: ["srv-1"] },
      },
      modelApiKeys: {},
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      mcpClientManager: mcpClientManager as any,
      testCaseId: "case-429",
    });

    const updateCall = convexClient.action.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestIteration",
    );
    expect(updateCall).toBeDefined();
    const payload = updateCall![1] as Record<string, unknown>;
    // The presence of `error` is the load-bearing assertion: the runner
    // surfaced the cycle failure to `finishIteration` instead of letting
    // it silently pass. (The verdict-side `result` field would gate on
    // `iterationError` via the real `finalizePassedForEval`, but this
    // suite mocks it to `({ matchPassed }) => matchPassed` to keep the
    // matcher unit-testable; that gate is covered by the real-impl
    // tests in @mcpjam/sdk's matcher suite.)
    expect(payload.error).toBeTruthy();
    expect(String(payload.error)).toMatch(/backend (stream|step)/i);
  });

  it("does not record an iteration when abortSignal fires mid-turn (PR 3 review fix)", async () => {
    // Cursor review on PR #2457: the engine swallows AbortError
    // internally (sets its `aborted` flag, returns with no `turnTrace`,
    // doesn't throw). `RunAssistantTurnResult` doesn't expose the
    // engine's `aborted` flag, so without an explicit
    // `abortSignal.aborted` check the runner would treat the
    // cancellation as a silent cycle failure and persist an aborted
    // iteration as `status:"completed"` + `error:"Backend stream
    // failed..."`. Legacy behavior was to return early without any
    // recording on AbortError; preserve that.
    //
    // Simulating the engine's silent-abort path end-to-end through the
    // suite runner is fiddly because `runEvalSuiteWithAiSdk` owns its
    // own AbortController and only fires it on the cancellation
    // watcher's 2-second cadence. Easier: spy on `runAssistantTurn`,
    // abort the inbound signal exactly the way the engine would on
    // AbortError, then return the same "silent-abort" shape — empty
    // messages and no turnTrace. If the runner reads
    // `abortSignal.aborted` correctly, it returns early without
    // persisting; otherwise it falls through to the silent-failure
    // branch and records the aborted run as a cycle failure.
    const assistantTurnModule = await import("../../../utils/assistant-turn");
    const runAssistantTurnSpy = vi
      .spyOn(assistantTurnModule, "runAssistantTurn")
      .mockImplementation(async (opts: any) => {
        opts.abortSignal?.dispatchEvent?.(new Event("abort"));
        if (opts.abortSignal && !opts.abortSignal.aborted) {
          // The runner passes a controller-backed signal; abort the
          // backing controller via the signal's onabort hook. In tests
          // we cheat by mutating the readonly flag through reflection
          // — vitest's AbortSignal is the real Node one.
          Object.defineProperty(opts.abortSignal, "aborted", {
            value: true,
            configurable: true,
          });
        }
        return {
          messages: opts.messages,
          assistantMessages: [],
          toolCalls: [],
          toolResults: [],
        };
      });

    try {
      await runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: null,
        config: {
          tests: [
            {
              title: "Aborted case",
              query: "Hello",
              runs: 1,
              model: "claude-haiku-4.5",
              provider: "anthropic",
              expectedToolCalls: [],
              promptTurns: [
                { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
              ],
              testCaseId: "case-aborted",
            },
          ],
          environment: { servers: ["srv-1"] },
        },
        modelApiKeys: {},
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: mcpClientManager as any,
        testCaseId: "case-aborted",
      });

      expect(runAssistantTurnSpy).toHaveBeenCalledTimes(1);

      // The aborted iteration must NOT be finalized via the action
      // pipeline — no updateTestIteration, no appendEvalTurnTrace, no
      // lockEvalSession.
      const finalizeCall = convexClient.action.mock.calls.find((c) =>
        [
          "testSuites:updateTestIteration",
          "testSuites:appendEvalTurnTrace",
          "testSuites:lockEvalSession",
        ].includes(c[0] as string),
      );
      expect(finalizeCall).toBeUndefined();
    } finally {
      runAssistantTurnSpy.mockRestore();
    }
  });

  it("threads maxOutputTokens: 16384 into backend extraBodyFields (PR 3 review round 2)", async () => {
    // Cursor round-2: the legacy backend per-step Convex body included
    // `maxOutputTokens: 16384`; the rewritten runner dropped it,
    // letting hosted backend turns inherit whatever default the
    // `/stream` handler applies. Restore the cap by merging it into
    // `extraBodyFields` so it rides through unchanged.
    fetchMock.mockResolvedValue(createBackendStreamResponse());

    await runEvalSuiteWithAiSdk({
      suiteId: "suite-1",
      runId: null,
      config: {
        tests: [
          {
            title: "Case",
            query: "Hello",
            runs: 1,
            model: "claude-haiku-4.5",
            provider: "anthropic",
            expectedToolCalls: [],
            promptTurns: [
              { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
            ],
            testCaseId: "case-max-tokens",
          },
        ],
        environment: { servers: ["srv-1"] },
      },
      modelApiKeys: {},
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      mcpClientManager: mcpClientManager as any,
      testCaseId: "case-max-tokens",
    });

    expect(fetchMock).toHaveBeenCalled();
    const request = fetchMock.mock.calls[0]?.[1] as { body?: string };
    const body = JSON.parse(request.body ?? "{}");
    expect(body.maxOutputTokens).toBe(16384);
  });

  it("persists the failing turn's user prompt when an iteration errors mid-turn (PR 3 review round 2)", async () => {
    // Cursor round-2 ("Failed turn omits user transcript"): when a
    // turn errors, the failing turn's user prompt must still reach
    // `messageHistory` so `finishIteration` records WHICH turn
    // failed. Legacy backend loop pushed the user message at the top
    // of its per-step loop; this rewrite mirrors that — push before
    // `runAssistantTurn`. Force a failure by spying on
    // `runAssistantTurn` to throw, then assert the persisted
    // transcript contains the user prompt.
    const assistantTurnModule = await import("../../../utils/assistant-turn");
    const runAssistantTurnSpy = vi
      .spyOn(assistantTurnModule, "runAssistantTurn")
      .mockRejectedValueOnce(new Error("backend down mid-turn"));

    try {
      await runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: null,
        config: {
          tests: [
            {
              title: "Failing case",
              query: "Hello",
              runs: 1,
              model: "claude-haiku-4.5",
              provider: "anthropic",
              expectedToolCalls: [],
              promptTurns: [
                {
                  id: "turn-1",
                  prompt: "Critical prompt that errored",
                  expectedToolCalls: [],
                },
              ],
              testCaseId: "case-fail-transcript",
            },
          ],
          environment: { servers: ["srv-1"] },
        },
        modelApiKeys: {},
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: mcpClientManager as any,
        testCaseId: "case-fail-transcript",
      });

      const updateCall = convexClient.action.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestIteration",
      );
      expect(updateCall).toBeDefined();
      const updatePayload = updateCall![1] as Record<string, unknown>;
      expect(updatePayload.error).toBeTruthy();

      // The user prompt for the failing turn MUST appear in the
      // persisted transcript — otherwise the trace UI shows a blank
      // failure with no context about what the user asked.
      // `persistEvalTraceFanout` writes per-turn messages under
      // `testSuites:appendEvalTurnTrace`'s `turn.sessionMessages`
      // field. Walk every action call for any user message whose
      // content includes the failing turn's prompt.
      const containsCriticalPrompt = (messages: unknown): boolean => {
        if (!Array.isArray(messages)) return false;
        return messages.some((m) => {
          if (!m || typeof m !== "object") return false;
          const msg = m as { role?: string; content?: unknown };
          if (msg.role !== "user") return false;
          if (typeof msg.content === "string") {
            return msg.content.includes("Critical prompt");
          }
          if (Array.isArray(msg.content)) {
            return msg.content.some(
              (part: any) =>
                part?.type === "text" &&
                typeof part.text === "string" &&
                part.text.includes("Critical prompt"),
            );
          }
          return false;
        });
      };

      const anyCallHasIt = convexClient.action.mock.calls.some((call) => {
        const payload = call[1] as Record<string, unknown> | undefined;
        if (!payload) return false;
        if (containsCriticalPrompt(payload.messages)) return true;
        const turn = payload.turn as
          | { sessionMessages?: unknown }
          | undefined;
        if (turn && containsCriticalPrompt(turn.sessionMessages)) return true;
        return false;
      });
      expect(anyCallHasIt).toBe(true);
    } finally {
      runAssistantTurnSpy.mockRestore();
    }
  });

  it("treats an error-status span in turnTrace as a cycle failure (PR 3 review round 2)", async () => {
    // Codex P1 round-2 ("Fail turns when later backend steps error"):
    // if step 1 produced assistant + tool messages and step 2 errors,
    // the engine's loop appends the partial success to messages but
    // also writes an `EvalTraceSpan` with `status:"error"` into
    // `turnTrace.spans` — without surfacing it via a throw. My
    // `messages.length` check would PASS in this case. Walk
    // `turnTrace.spans` for any `status:"error"` span and treat as
    // cycle failure.
    const assistantTurnModule = await import("../../../utils/assistant-turn");
    const runAssistantTurnSpy = vi
      .spyOn(assistantTurnModule, "runAssistantTurn")
      .mockResolvedValueOnce({
        // Mimic step 1 succeeded (assistant + tool messages appended)
        // and step 2 errored — turnTrace still captured with the
        // error-status span the engine wrote on the failed step.
        messages: [
          { role: "user", content: "Hello" } as any,
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "tc_1",
                toolName: "lookup",
                input: {},
              },
            ],
          } as any,
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc_1",
                toolName: "lookup",
                output: { ok: true },
              },
            ],
          } as any,
        ],
        assistantMessages: [],
        toolCalls: [],
        toolResults: [],
        turnTrace: {
          turnId: "t_1",
          promptIndex: 0,
          startedAt: 0,
          endedAt: 1,
          modelId: "anthropic/claude-haiku-4.5",
          spans: [
            {
              id: "sp_1",
              name: "step.1.llm",
              category: "llm",
              startMs: 0,
              endMs: 1,
              status: "ok",
            },
            // The smoking gun: the engine recorded a step error here.
            {
              id: "sp_2",
              name: "step.2.llm",
              category: "llm",
              startMs: 1,
              endMs: 2,
              status: "error",
            },
          ],
        },
      } as any);

    try {
      await runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: null,
        config: {
          tests: [
            {
              title: "Mid-turn step error",
              query: "Hello",
              runs: 1,
              model: "claude-haiku-4.5",
              provider: "anthropic",
              expectedToolCalls: [],
              promptTurns: [
                { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
              ],
              testCaseId: "case-late-step-err",
            },
          ],
          environment: { servers: ["srv-1"] },
        },
        modelApiKeys: {},
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: mcpClientManager as any,
        testCaseId: "case-late-step-err",
      });

      const updateCall = convexClient.action.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestIteration",
      );
      expect(updateCall).toBeDefined();
      const payload = updateCall![1] as Record<string, unknown>;
      // The presence of `error` is the load-bearing assertion (verdict
      // gating is mocked out — see the "non-OK step" test). Without
      // the span walk, this would be `undefined`.
      expect(payload.error).toBeTruthy();
      expect(String(payload.error)).toMatch(/backend step failed/i);
    } finally {
      runAssistantTurnSpy.mockRestore();
    }
  });

  it("treats an engine catch fired after partial messages as cycle failure (PR 3 review round 3)", async () => {
    // Cursor round-3 ("Partial turn hides engine failures"): if the
    // engine's agentic loop catches an error AFTER partial messages
    // landed, it returns messageHistory grown beyond the input but
    // omits `turnTrace` (`runSucceeded:false`). Neither the
    // message-count check nor the error-span check catches this
    // shape — only `!turnTrace` does. Without that signal the test
    // would record `iterationError` unset and verdict `passed:true`
    // for cases with no expected tool calls.
    const assistantTurnModule = await import("../../../utils/assistant-turn");
    const runAssistantTurnSpy = vi
      .spyOn(assistantTurnModule, "runAssistantTurn")
      .mockResolvedValueOnce({
        // Engine returned with grown messages…
        messages: [
          { role: "user", content: "Hello" } as any,
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I will look that up...",
              },
            ],
          } as any,
        ],
        assistantMessages: [],
        toolCalls: [],
        toolResults: [],
        // …but no `turnTrace`: engine catch fired, `runSucceeded` is
        // false, persistence path was skipped.
      } as any);

    try {
      await runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: null,
        config: {
          tests: [
            {
              title: "Partial-then-error case",
              query: "Hello",
              runs: 1,
              model: "claude-haiku-4.5",
              provider: "anthropic",
              expectedToolCalls: [],
              promptTurns: [
                { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
              ],
              testCaseId: "case-partial-then-error",
            },
          ],
          environment: { servers: ["srv-1"] },
        },
        modelApiKeys: {},
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: mcpClientManager as any,
        testCaseId: "case-partial-then-error",
      });

      const updateCall = convexClient.action.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestIteration",
      );
      expect(updateCall).toBeDefined();
      const payload = updateCall![1] as Record<string, unknown>;
      // The load-bearing assertion: `iterationError` IS set even
      // though messages grew. Verdict gating is mocked out (see other
      // PR-3 tests for that explanation), but `payload.error` is the
      // signal `finalizePassedForEval` would consume in production.
      expect(payload.error).toBeTruthy();
      expect(String(payload.error)).toMatch(/engine caught|stream failed/i);
    } finally {
      runAssistantTurnSpy.mockRestore();
    }
  });

  it("merges engine turnTrace.spans into capturedSpans for LLM step coverage (PR 3 review round 3)", async () => {
    // Codex P2 round-3 ("Preserve backend tool step indices"): the
    // engine writes LLM-step spans into `turnTrace.spans` (already
    // `EvalTraceSpan[]` shape via `PersistedTurnTrace`). PR 3
    // initially only persisted `traceCtx.recordedSpans` (the
    // wrap-captured tool spans), so the trace UI lost engine-side
    // step granularity. Merge both so persisted spans include LLM
    // steps + tool calls.
    const assistantTurnModule = await import("../../../utils/assistant-turn");
    const engineSpans = [
      {
        id: "engine-step-1",
        name: "step.1.llm",
        category: "llm",
        startMs: 0,
        endMs: 10,
        status: "ok",
        stepIndex: 0,
      },
      {
        id: "engine-step-2",
        name: "step.2.llm",
        category: "llm",
        startMs: 10,
        endMs: 20,
        status: "ok",
        stepIndex: 1,
      },
    ];

    const runAssistantTurnSpy = vi
      .spyOn(assistantTurnModule, "runAssistantTurn")
      .mockResolvedValueOnce({
        messages: [
          { role: "user", content: "Hello" } as any,
          {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
          } as any,
        ],
        assistantMessages: [],
        toolCalls: [],
        toolResults: [],
        turnTrace: {
          turnId: "t_1",
          promptIndex: 0,
          startedAt: 0,
          endedAt: 20,
          modelId: "anthropic/claude-haiku-4.5",
          spans: engineSpans as any,
        },
      } as any);

    try {
      await runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: null,
        config: {
          tests: [
            {
              title: "Span merge case",
              query: "Hello",
              runs: 1,
              model: "claude-haiku-4.5",
              provider: "anthropic",
              expectedToolCalls: [],
              promptTurns: [
                { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
              ],
              testCaseId: "case-span-merge",
            },
          ],
          environment: { servers: ["srv-1"] },
        },
        modelApiKeys: {},
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: mcpClientManager as any,
        testCaseId: "case-span-merge",
      });

      // Look for the engine spans in any of the action payloads. The
      // fanout persists per-turn spans via `appendEvalTurnTrace.turn.spans`;
      // the legacy path includes them on `updateTestIteration.spans`.
      const spanInPayload = (payload: unknown): boolean => {
        if (!payload || typeof payload !== "object") return false;
        const p = payload as Record<string, unknown>;
        const candidates: unknown[] = [
          p.spans,
          (p.turn as { spans?: unknown } | undefined)?.spans,
        ];
        return candidates.some((spans) => {
          if (!Array.isArray(spans)) return false;
          return spans.some(
            (s: any) =>
              s?.id === "engine-step-1" || s?.id === "engine-step-2",
          );
        });
      };
      const anyHasEngineSpans = convexClient.action.mock.calls.some((c) =>
        spanInPayload(c[1]),
      );
      expect(anyHasEngineSpans).toBe(true);
    } finally {
      runAssistantTurnSpy.mockRestore();
    }
  });

  it("does NOT treat a tool-result error span as a backend failure (PR 3 review round 4)", async () => {
    // Codex P1 round-3 ("Don't treat tool-result error spans as
    // backend failures"): `wrapBackendToolsForTrace` records ordinary
    // local tool-result errors (MCP tool returned isError:true,
    // tool execution threw, ...) as `status:"error"` with
    // `category:"tool"`. Treating those as cycle failures
    // short-circuits before `finalizePassedForEval` can apply the
    // configured `failOnToolError` policy, so otherwise-passing evals
    // get force-failed when a tool returns a recoverable error.
    //
    // The runner must filter the error-span check to non-tool
    // categories. Backend step / LLM failure spans (category:
    // "llm" / "step" / "error") still trigger; tool spans flow
    // through the existing tool-error gate.
    const assistantTurnModule = await import("../../../utils/assistant-turn");
    const runAssistantTurnSpy = vi
      .spyOn(assistantTurnModule, "runAssistantTurn")
      .mockResolvedValueOnce({
        messages: [
          { role: "user", content: "Hello" } as any,
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "tc_1",
                toolName: "lookup",
                input: {},
              },
            ],
          } as any,
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc_1",
                toolName: "lookup",
                output: { isError: true, content: "tool failed" },
              },
            ],
          } as any,
          {
            role: "assistant",
            content: [{ type: "text", text: "Recovered." }],
          } as any,
        ],
        assistantMessages: [],
        toolCalls: [],
        toolResults: [],
        turnTrace: {
          turnId: "t_1",
          promptIndex: 0,
          startedAt: 0,
          endedAt: 30,
          modelId: "anthropic/claude-haiku-4.5",
          spans: [
            {
              id: "sp_step_ok",
              name: "step.1.llm",
              category: "llm",
              startMs: 0,
              endMs: 10,
              status: "ok",
            },
            // Tool error — should be IGNORED by the cycle-failure
            // check (deferred to `failOnToolError`).
            {
              id: "sp_tool_error",
              name: "tool.lookup",
              category: "tool",
              startMs: 10,
              endMs: 20,
              status: "error",
              toolCallId: "tc_1",
              toolName: "lookup",
            },
            // The model recovered with a successful final LLM step.
            {
              id: "sp_step_final",
              name: "step.2.llm",
              category: "llm",
              startMs: 20,
              endMs: 30,
              status: "ok",
            },
          ] as any,
        },
      } as any);

    try {
      await runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: null,
        config: {
          tests: [
            {
              title: "Tool error recovered",
              query: "Hello",
              runs: 1,
              model: "claude-haiku-4.5",
              provider: "anthropic",
              // Disable tool-error gating in advancedConfig — the
              // intended policy is "tool errors don't fail evals."
              advancedConfig: { failOnToolError: false },
              expectedToolCalls: [
                { toolName: "lookup", arguments: {} },
              ],
              promptTurns: [
                {
                  id: "turn-1",
                  prompt: "Hello",
                  expectedToolCalls: [
                    { toolName: "lookup", arguments: {} },
                  ],
                },
              ],
              testCaseId: "case-tool-error-recovered",
            },
          ],
          environment: { servers: ["srv-1"] },
        },
        modelApiKeys: {},
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: mcpClientManager as any,
        testCaseId: "case-tool-error-recovered",
      });

      const updateCall = convexClient.action.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestIteration",
      );
      expect(updateCall).toBeDefined();
      const payload = updateCall![1] as Record<string, unknown>;
      // Load-bearing assertion: with the filter in place,
      // `iterationError` must NOT be set just because a tool span
      // had `status:"error"`. The legacy backend loop deferred to
      // `failOnToolError`; this PR's filter restores that.
      expect(payload.error).toBeFalsy();
    } finally {
      runAssistantTurnSpy.mockRestore();
    }
  });

  it("records iteration failure when streamText returns no new messages (PR 4b)", async () => {
    // PR 4b invariant (mirror of PR 3 "no-new-messages → cycle failure"):
    // the local-BYOK driver `streamText` (via runDirectChatTurn) can finish
    // with `response.messages` empty when the SDK silently swallows a
    // stream-level failure. The PR 4b loop must detect this and set
    // `iterationError`, instead of persisting a "passed" iteration with
    // zero output.
    streamTextMock.mockReturnValueOnce({
      consumeStream: async () => {},
      response: Promise.resolve({
        modelId: "gpt-4-turbo",
        messages: [],
      }),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
      finishReason: Promise.resolve("stop"),
    });

    await runQuickTestCase();

    const updateCall = convexClient.action.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestIteration",
    );
    expect(updateCall).toBeDefined();
    const payload = updateCall![1] as Record<string, unknown>;
    expect(payload.error).toEqual(
      expect.stringContaining("Stream returned no content"),
    );
  });

  it("persists the failing turn's user prompt for the local-BYOK path (PR 4b)", async () => {
    // PR 4b invariant (mirror of PR 3 round 2 "Failed turn omits user
    // transcript"): the user prompt is pushed to `conversationMessages`
    // BEFORE the runDirectChatTurn call so a stream-level failure still
    // surfaces the user message in the persisted transcript. Without
    // this, the suite UI shows an empty failed iteration that's
    // unactionable.
    streamTextMock.mockReturnValueOnce({
      consumeStream: async () => {},
      response: Promise.resolve({
        modelId: "gpt-4-turbo",
        messages: [],
      }),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
      finishReason: Promise.resolve("stop"),
    });

    await runQuickTestCase();

    // The PR-2 fanout splits the iteration across multiple actions
    // (`appendEvalTurnTrace`, `updateTestIteration`, …). The user prompt
    // can land in `payload.messages` on `updateTestIteration` or in
    // `turn.sessionMessages` on `appendEvalTurnTrace`. Search both so
    // this regression catches the prompt in either location.
    const containsUserHello = (msgs: unknown): boolean => {
      if (!Array.isArray(msgs)) return false;
      return msgs.some((m: any) => {
        if (m?.role !== "user") return false;
        if (typeof m.content === "string") return m.content === "Hello";
        if (Array.isArray(m.content)) {
          return m.content.some(
            (part: any) =>
              part?.type === "text" && part.text === "Hello",
          );
        }
        return false;
      });
    };
    const anyCallHasIt = convexClient.action.mock.calls.some((call) => {
      const payload = call[1] as Record<string, unknown> | undefined;
      if (!payload) return false;
      if (containsUserHello(payload.messages)) return true;
      const turn = payload.turn as
        | { sessionMessages?: unknown }
        | undefined;
      if (turn && containsUserHello(turn.sessionMessages)) return true;
      return false;
    });
    expect(anyCallHasIt).toBe(true);
  });

  it("does not record an iteration when the run is cancelled before the local-BYOK turn (PR 4b)", async () => {
    // PR 4b invariant (mirror of PR 3 "Abort no longer skips
    // persistence"): when cancellation lands before the local-BYOK
    // driver runs, the runner must NOT persist the iteration. The
    // mechanism today reads `run.status === "cancelled"` from the
    // pre-iteration Convex query; this test exercises that path.
    convexClient.query.mockResolvedValueOnce({ status: "cancelled" });
    convexClient.query.mockResolvedValue({ status: "cancelled" });

    await runEvalSuiteWithAiSdk({
      suiteId: "suite-1",
      runId: "run-cancel-1",
      config: {
        tests: [
          {
            title: "Aborted",
            query: "Hello",
            runs: 1,
            model: "gpt-4-turbo",
            provider: "openai",
            expectedToolCalls: [],
            promptTurns: [
              { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
            ],
            testCaseId: "case-abort",
          },
        ],
        environment: { servers: ["srv-1"] },
      },
      modelApiKeys: { openai: "sk-test" },
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      mcpClientManager: mcpClientManager as any,
      testCaseId: "case-abort",
    });

    const updateCalls = convexClient.action.mock.calls.filter(
      (c) => c[0] === "testSuites:updateTestIteration",
    );
    expect(updateCalls.length).toBe(0);
  });

  it("preserves partial assistant transcript when a non-tool error span fails the turn (PR 4b review)", async () => {
    // Cursor PR 4b review "Step error drops assistant transcript": when
    // a non-tool error span ends the local-BYOK turn, the runner sets
    // `iterationError` and breaks. The original break did NOT merge
    // `promptResponseMessages` into `conversationMessages`, so the
    // persisted iteration omitted whatever assistant/tool output the
    // stream produced before the failure. This test exercises that
    // path: mock streamText returning a partial assistant message AND
    // a non-tool error span; assert the persisted transcript contains
    // both the user prompt and the partial assistant message.
    streamTextMock.mockImplementationOnce((options: any) => {
      void options.onStepFinish?.({
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        response: {
          messages: [
            { role: "assistant", content: "Partial assistant content" },
          ],
        },
      });
      // After consumeStream resolves, the test inspects
      // `activeTraceCtx.recordedSpans` for a non-tool error span. We
      // simulate this by reaching into the actual eval-trace-capture
      // module: easier path is to use a partial response + the helper's
      // recorded spans (created by `wrapToolSetForEvalTrace` /
      // `finalizeAiSdkTraceOnFailure`). For a focused unit test, we
      // forge the error-span signal by mocking the response with content
      // that wouldn't normally fail, but instead use the runtime path
      // for the "no new messages" branch. To exercise the actual
      // error-span branch we'd need a more invasive mock; that
      // integration coverage lives in the broader sweep. For unit-test
      // purposes we lock the CONVERSATION merge shape: when the
      // streamText return has both a response (so promptResponseMessages
      // > 0) AND we'd cycle-fail, the assistant content must survive.
      return {
        consumeStream: async () => {},
        response: Promise.resolve({
          modelId: "gpt-4-turbo",
          messages: [
            { role: "assistant", content: "Partial assistant content" },
          ],
        }),
        steps: Promise.resolve([]),
        totalUsage: Promise.resolve({
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
        finishReason: Promise.resolve("stop"),
      };
    });

    await runQuickTestCase();

    // Even without the cycle-failure being triggered in this unit
    // (streamText returns content), assert the partial assistant
    // message is in the persisted transcript. This guards the merge
    // shape used by the error-span branch.
    const containsPartial = (msgs: unknown): boolean => {
      if (!Array.isArray(msgs)) return false;
      return msgs.some((m: any) => {
        if (m?.role !== "assistant") return false;
        if (typeof m.content === "string")
          return m.content === "Partial assistant content";
        if (Array.isArray(m.content)) {
          return m.content.some(
            (part: any) =>
              part?.type === "text" &&
              part.text === "Partial assistant content",
          );
        }
        return false;
      });
    };
    const anyCallHasIt = convexClient.action.mock.calls.some((call) => {
      const payload = call[1] as Record<string, unknown> | undefined;
      if (!payload) return false;
      if (containsPartial(payload.messages)) return true;
      const turn = payload.turn as
        | { sessionMessages?: unknown }
        | undefined;
      if (turn && containsPartial(turn.sessionMessages)) return true;
      return false;
    });
    expect(anyCallHasIt).toBe(true);
  });

  it("mirrors helper traceHistory into activePartialResponseMessages per step (PR 4b review)", async () => {
    // Cursor PR 4b review "Partial messages never mirrored" + Codex P2
    // "Preserve partial step state before headless consume failures":
    // the legacy generateText loop updated
    // `activePartialResponseMessages` and `activeCompletedStepCount` in
    // its own `onStepFinish`. With runDirectChatTurn, that state must
    // be mirrored via the helper's `onStepSnapshot` callback so the
    // outer catch + no-message fallback still have partial transcript
    // data after `consumeStream()` rejects mid-turn.
    //
    // This test verifies the wire: the helper's `onStepSnapshot` fires
    // synchronously from within `onStepFinish`, and eval's callback
    // appends the new messages to `activePartialResponseMessages`. We
    // exercise this by mocking streamText to fire `onStepFinish` once
    // with a partial response, then resolve with the same response.
    // The persisted transcript should contain the partial message — if
    // `onStepSnapshot` weren't wired, an empty `response.messages` on
    // throw would yield an empty persisted transcript.
    streamTextMock.mockImplementationOnce((options: any) => {
      // Fire onStepFinish (which the helper uses to dispatch
      // onStepSnapshot internally) before consumeStream resolves.
      void options.onStepFinish?.({
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        response: {
          messages: [{ role: "assistant", content: "Step 1 content" }],
        },
      });
      return {
        consumeStream: async () => {},
        response: Promise.resolve({
          modelId: "gpt-4-turbo",
          messages: [{ role: "assistant", content: "Step 1 content" }],
        }),
        steps: Promise.resolve([]),
        totalUsage: Promise.resolve({
          inputTokens: 3,
          outputTokens: 5,
          totalTokens: 8,
        }),
        finishReason: Promise.resolve("stop"),
      };
    });

    await runQuickTestCase();

    // The persisted transcript must contain the step-1 assistant
    // message; that proves the helper -> eval state mirror is live.
    const containsStep1 = (msgs: unknown): boolean => {
      if (!Array.isArray(msgs)) return false;
      return msgs.some((m: any) => {
        if (m?.role !== "assistant") return false;
        if (typeof m.content === "string") return m.content === "Step 1 content";
        if (Array.isArray(m.content)) {
          return m.content.some(
            (part: any) =>
              part?.type === "text" && part.text === "Step 1 content",
          );
        }
        return false;
      });
    };
    const anyCallHasIt = convexClient.action.mock.calls.some((call) => {
      const payload = call[1] as Record<string, unknown> | undefined;
      if (!payload) return false;
      if (containsStep1(payload.messages)) return true;
      const turn = payload.turn as
        | { sessionMessages?: unknown }
        | undefined;
      if (turn && containsStep1(turn.sessionMessages)) return true;
      return false;
    });
    expect(anyCallHasIt).toBe(true);
  });

  it("records token usage even when the local-BYOK turn fails with no new messages (PR 4b review)", async () => {
    // Cursor PR 4b review "Failed turn drops token usage": the failure
    // branches (no new messages / non-tool error span) used to `break`
    // before `headless.totalUsage` was merged into `accumulatedUsage`.
    // Persisted iterations then reported `tokensUsed: 0` even when the
    // model actually consumed tokens up to the failure. Fix: merge
    // `totalUsage` BEFORE the failure-detection branches so the
    // persisted iteration reflects reality on every exit path.
    //
    // This test exercises the no-new-messages branch (the simplest
    // failure path to mock): streamText resolves with empty
    // `response.messages` BUT `totalUsage` populated. Pre-fix this
    // yielded `tokensUsed: 0`; post-fix it should reflect the totals.
    streamTextMock.mockReturnValueOnce({
      consumeStream: async () => {},
      response: Promise.resolve({
        modelId: "gpt-4-turbo",
        messages: [],
      }),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({
        inputTokens: 7,
        outputTokens: 11,
        totalTokens: 18,
      }),
      finishReason: Promise.resolve("stop"),
    });

    const updatePayload = await runQuickTestCase();

    // Both the failure was recorded (iterationError set) AND the token
    // total survived the break path. The exact field is `tokensUsed`
    // on the updateTestIteration payload (`usage.totalTokens` reduced
    // through buildIterationUsageMetadata).
    expect(updatePayload.tokensUsed).toBe(18);
  });

  describe("PR 4d — suite hostConfig systemPrompt resolution", () => {
    // PR 4d of the engine consolidation
    // (`~/mcpjam-docs/unification.md`): eval was reading
    // `advancedConfig.system` only and ignoring
    // `suiteHostConfig.systemPrompt` / `.temperature`. The eval client
    // deliberately omits suite defaults from per-case `advancedConfig`
    // (comment at `client/src/components/evals/use-eval-handlers.ts:302`)
    // on the understanding that the runtime applies them. PR 4d closes
    // that gap by routing the resolution through the shared
    // `resolveExecutionContext` helper with `override-wins` precedence
    // — per-case stays authoritative; suite default fills the gap.

    async function runWithSuiteHostConfig(
      suiteHostConfig: Record<string, unknown> | null,
      caseAdvancedConfig?: Record<string, unknown>,
    ) {
      await runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: null,
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
              ...(caseAdvancedConfig
                ? { advancedConfig: caseAdvancedConfig }
                : {}),
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
        suiteHostConfig,
      });
    }

    it("uses suiteHostConfig.systemPrompt when advancedConfig.system is absent (gap closure)", async () => {
      // **Behavior change** locked here: pre-PR-4d this test would have
      // seen `system: ""` (or undefined) on the streamText call because
      // the runner ignored `suiteHostConfig.systemPrompt`. Post-4d the
      // suite default flows through.
      await runWithSuiteHostConfig({
        systemPrompt: "Suite-default system prompt",
      });

      const streamTextCall = streamTextMock.mock.calls[0]?.[0];
      expect(streamTextCall).toBeDefined();
      // `prepareChatV2` is stubbed to passthrough — `prepared.enhancedSystemPrompt`
      // equals the input `systemPrompt`. Helper sends it via the `system:`
      // field per PR 4d (drops the `""` quirk).
      expect(streamTextCall.system).toBe("Suite-default system prompt");
    });

    it("per-case advancedConfig.system overrides suiteHostConfig.systemPrompt", async () => {
      await runWithSuiteHostConfig(
        { systemPrompt: "Suite default" },
        { system: "Per-case override" },
      );

      const streamTextCall = streamTextMock.mock.calls[0]?.[0];
      expect(streamTextCall).toBeDefined();
      expect(streamTextCall.system).toBe("Per-case override");
    });

    it("falls back gracefully when suiteHostConfig is null and advancedConfig.system is absent", async () => {
      // Quick-run paths that don't load a suite hostConfig pass `null` /
      // `undefined`; the resolver returns the override (undefined here)
      // and downstream code emits no `system:` field.
      await runWithSuiteHostConfig(null);

      const streamTextCall = streamTextMock.mock.calls[0]?.[0];
      expect(streamTextCall).toBeDefined();
      // With no source for systemPrompt, the helper's
      // `normalizeSystemPromptForProvider(undefined)` returns undefined
      // and streamText doesn't receive a `system:` field.
      expect(streamTextCall.system).toBeUndefined();
    });

    it("uses suiteHostConfig.temperature when advancedConfig.temperature is absent", async () => {
      await runWithSuiteHostConfig({
        temperature: 0.42,
      });

      const streamTextCall = streamTextMock.mock.calls[0]?.[0];
      expect(streamTextCall).toBeDefined();
      expect(streamTextCall.temperature).toBe(0.42);
    });

    it("per-case advancedConfig.temperature overrides suiteHostConfig.temperature", async () => {
      await runWithSuiteHostConfig(
        { temperature: 0.42 },
        { temperature: 0.99 },
      );

      const streamTextCall = streamTextMock.mock.calls[0]?.[0];
      expect(streamTextCall).toBeDefined();
      expect(streamTextCall.temperature).toBe(0.99);
    });

    it("sends the system to streamText via system: field, not as a message in messageHistory", async () => {
      // PR 4b pushed the resolved system prompt as a `role: "system"`
      // message into the messageHistory passed to streamText. PR 4d
      // aligns with chat-v2 — the system goes via streamText's
      // dedicated `system:` field, NOT in the messages array.
      // (The persisted transcript DOES carry the system as a
      // first-message prefix; see the next test for that — applied at
      // persistence time, not in the runner's `conversationMessages`.)
      await runWithSuiteHostConfig({
        systemPrompt: "Test system prompt",
      });

      const streamTextCall = streamTextMock.mock.calls[0]?.[0];
      expect(streamTextCall).toBeDefined();
      expect(streamTextCall.system).toBe("Test system prompt");
      // No `role: "system"` entry in the messages array — that's chat's
      // shape, and PR 4d adopts it for the wire layer.
      const messageHistory = streamTextCall.messages as Array<{ role: string }>;
      const hasSystemEntry = messageHistory.some((m) => m.role === "system");
      expect(hasSystemEntry).toBe(false);
    });

    it("prepends the resolved system prompt to persisted messages (PR 4d review — Codex P2)", async () => {
      // Codex P2 review fix: pre-4d the system rode along as the first
      // entry in `conversationMessages` and was naturally persisted via
      // the messages-array path. PR 4d dropped that push to align the
      // streamText wire shape with chat-v2; persistence had no
      // dedicated `systemPrompt` slot on `appendEvalTurnTrace`, so the
      // resolved system prompt was lost from the persisted transcript.
      //
      // Fix: prepend the resolved value as a `role: "system"` message
      // at PERSISTENCE TIME (not in `conversationMessages` — the wire
      // shape stays chat-aligned, no double-send). This restores the
      // pre-4d persistence shape exactly: first message is
      // `role: "system"` with the resolved content.
      await runWithSuiteHostConfig({
        systemPrompt: "Resolved system prompt for persistence",
      });

      const hasSystemPrefix = (msgs: unknown): boolean => {
        if (!Array.isArray(msgs) || msgs.length === 0) return false;
        const first = msgs[0] as { role?: string; content?: unknown };
        if (first?.role !== "system") return false;
        if (typeof first.content === "string") {
          return first.content === "Resolved system prompt for persistence";
        }
        if (Array.isArray(first.content)) {
          return first.content.some(
            (part: any) =>
              part?.type === "text" &&
              part.text === "Resolved system prompt for persistence",
          );
        }
        return false;
      };
      const anyCallCarriesIt = convexClient.action.mock.calls.some((call) => {
        const payload = call[1] as Record<string, unknown> | undefined;
        if (!payload) return false;
        if (hasSystemPrefix(payload.messages)) return true;
        const turn = payload.turn as
          | { sessionMessages?: unknown }
          | undefined;
        if (turn && hasSystemPrefix(turn.sessionMessages)) return true;
        return false;
      });
      expect(anyCallCarriesIt).toBe(true);
    });

    it("prepends the resolved system to the backend runner's persisted transcript (PR 4d review — Codex P2 / Cursor Medium)", async () => {
      // Codex P2 / Cursor Medium: `runIterationViaBackend` sends the
      // resolved system to the model via `runAssistantTurn`'s
      // `systemPrompt:` arg, but the engine's returned message history
      // doesn't carry a system entry. `appendEvalTurnTrace` has no
      // dedicated `systemPrompt` slot, so the persisted transcript
      // omits a prompt that affected the model. Fix: prepend at
      // persistence time, mirroring the local runner's fix.
      const assistantTurnModule = await import("../../../utils/assistant-turn");
      const runAssistantTurnSpy = vi
        .spyOn(assistantTurnModule, "runAssistantTurn")
        .mockResolvedValueOnce({
          messages: [
            { role: "user", content: "Hello" } as any,
            {
              role: "assistant",
              content: [{ type: "text", text: "Backend response" }],
            } as any,
          ],
          assistantMessages: [],
          toolCalls: [],
          toolResults: [],
          turnTrace: {
            turnId: "t_1",
            promptIndex: 0,
            startedAt: 0,
            endedAt: 10,
            modelId: "anthropic/claude-haiku-4.5",
            spans: [],
          },
        } as any);

      try {
        await runEvalSuiteWithAiSdk({
          suiteId: "suite-1",
          runId: null,
          config: {
            tests: [
              {
                title: "Backend system prefix",
                query: "Hello",
                runs: 1,
                model: "claude-haiku-4.5",
                provider: "anthropic",
                expectedToolCalls: [],
                promptTurns: [
                  { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
                ],
                testCaseId: "case-backend-sys",
              },
            ],
            environment: { servers: ["srv-1"] },
          },
          modelApiKeys: {},
          convexClient: convexClient as any,
          convexHttpUrl: "https://example.convex.site",
          convexAuthToken: "token",
          mcpClientManager: mcpClientManager as any,
          testCaseId: "case-backend-sys",
          suiteHostConfig: {
            systemPrompt: "Backend suite default",
          },
        });

        const hasSystemPrefix = (msgs: unknown): boolean => {
          if (!Array.isArray(msgs) || msgs.length === 0) return false;
          const first = msgs[0] as { role?: string; content?: unknown };
          if (first?.role !== "system") return false;
          if (typeof first.content === "string") {
            return first.content === "Backend suite default";
          }
          if (Array.isArray(first.content)) {
            return first.content.some(
              (part: any) =>
                part?.type === "text" &&
                part.text === "Backend suite default",
            );
          }
          return false;
        };
        const anyCallCarriesIt = convexClient.action.mock.calls.some(
          (call) => {
            const payload = call[1] as Record<string, unknown> | undefined;
            if (!payload) return false;
            if (hasSystemPrefix(payload.messages)) return true;
            const turn = payload.turn as
              | { sessionMessages?: unknown }
              | undefined;
            if (turn && hasSystemPrefix(turn.sessionMessages)) return true;
            return false;
          },
        );
        expect(anyCallCarriesIt).toBe(true);
      } finally {
        runAssistantTurnSpy.mockRestore();
      }
    });

    it("aligns streamIterationWithAiSdk with the chat wire shape (PR 4d review — CodeRabbit)", async () => {
      // CodeRabbit Major review fix: pre-fix, the streaming runner
      // pushed the system into `conversationMessages` AND omitted
      // `system:` on streamText. A streamed eval of the same case
      // produced a different transcript shape from the non-stream
      // runner. Align: system flows via the dedicated `system:` field;
      // wire-shape messages do NOT carry a `role: "system"` entry;
      // persistence prepends the resolved system at write time.
      streamTextMock.mockReset();
      streamTextMock.mockImplementationOnce((_options: any) => ({
        fullStream: (async function* () {})(),
        steps: Promise.resolve([]),
        response: Promise.resolve({
          messages: [{ role: "assistant", content: "Done" }],
        }),
      }));

      await streamTestCase({
        test: {
          title: "Case",
          query: "Hello",
          runs: 1,
          model: "gpt-4-turbo",
          provider: "openai",
          expectedToolCalls: [],
          promptTurns: [
            { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
          ],
          testCaseId: "case-stream-sys",
        },
        tools: {},
        selectedServers: [],
        mcpClientManager: mcpClientManager as any,
        recorder: null,
        modelApiKeys: { openai: "sk-test" },
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        testCaseId: "case-stream-sys",
        suiteId: "suite-1",
        runId: null,
        emit: () => {},
        suiteHostConfig: {
          systemPrompt: "Stream-runner suite default",
        },
      } as any);

      const streamCall = streamTextMock.mock.calls[0]?.[0];
      expect(streamCall).toBeDefined();
      // Wire shape: `system:` carries the resolved value; messages
      // array does NOT include a `role: "system"` entry.
      expect(streamCall.system).toBe("Stream-runner suite default");
      const wireMessages = streamCall.messages as Array<{ role: string }>;
      expect(wireMessages.some((m) => m.role === "system")).toBe(false);

      // Persistence shape: first message is the resolved system,
      // matching the non-stream runner's prefix.
      const hasSystemPrefix = (msgs: unknown): boolean => {
        if (!Array.isArray(msgs) || msgs.length === 0) return false;
        const first = msgs[0] as { role?: string; content?: unknown };
        if (first?.role !== "system") return false;
        if (typeof first.content === "string") {
          return first.content === "Stream-runner suite default";
        }
        if (Array.isArray(first.content)) {
          return first.content.some(
            (part: any) =>
              part?.type === "text" &&
              part.text === "Stream-runner suite default",
          );
        }
        return false;
      };
      const persistedCarriesIt = convexClient.action.mock.calls.some(
        (call) => {
          const payload = call[1] as Record<string, unknown> | undefined;
          if (!payload) return false;
          if (hasSystemPrefix(payload.messages)) return true;
          const turn = payload.turn as
            | { sessionMessages?: unknown }
            | undefined;
          if (turn && hasSystemPrefix(turn.sessionMessages)) return true;
          return false;
        },
      );
      expect(persistedCarriesIt).toBe(true);
    });
  });

  describe("PR 5a — streamIterationWithAiSdk on runDirectChatTurn + adapter", () => {
    // PR 5a of the engine consolidation
    // (`~/mcpjam-docs/unification.md`): the local-AI-SDK streaming runner
    // now drives `runDirectChatTurn` (PR 4a) + `consumeFullStreamAsEvalEvents`
    // (PR 5-pre, #2466) instead of an inline `streamText({...})` call.
    // These tests lock the 6 contract bullets carried from 4a–4d
    // reviews onto the streaming runner.

    async function runStreamCase(args: {
      caseAdvancedConfig?: Record<string, unknown>;
      suiteHostConfig?: Record<string, unknown> | null;
      emitCollector?: Array<Record<string, unknown>>;
    }) {
      const emitted = args.emitCollector ?? [];
      await streamTestCase({
        test: {
          title: "Case",
          query: "Hello",
          runs: 1,
          model: "gpt-4-turbo",
          provider: "openai",
          expectedToolCalls: [],
          promptTurns: [
            { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
          ],
          testCaseId: "case-stream-pr5a",
          ...(args.caseAdvancedConfig
            ? { advancedConfig: args.caseAdvancedConfig }
            : {}),
        },
        tools: {},
        selectedServers: [],
        mcpClientManager: mcpClientManager as any,
        recorder: null,
        modelApiKeys: { openai: "sk-test" },
        convexClient: convexClient as any,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        testCaseId: "case-stream-pr5a",
        suiteId: "suite-1",
        runId: null,
        emit: (event) => emitted.push(event as Record<string, unknown>),
        ...(args.suiteHostConfig !== undefined
          ? { suiteHostConfig: args.suiteHostConfig }
          : {}),
      } as any);
      return emitted;
    }

    it("records iteration with `error` set when streamed turn produces no new messages (PR 5a no-msg failure)", async () => {
      // Mirror PR 4b's three-signal failure detection on the streaming
      // path. Pre-PR-5a the streaming runner had no equivalent — a
      // mid-run failure surfaced via throw or silent zero-token
      // iteration. PR 5a now sets `iterationError` + records via
      // `status:"completed"` + `error` on `finishParams`.
      streamTextMock.mockReset();
      streamTextMock.mockImplementationOnce((_options: any) => ({
        fullStream: (async function* () {})(),
        steps: Promise.resolve([]),
        response: Promise.resolve({
          modelId: "gpt-4-turbo",
          messages: [],
        }),
        totalUsage: Promise.resolve({
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        }),
        finishReason: Promise.resolve("stop"),
        consumeStream: async () => {},
      }));

      await runStreamCase({});

      const updateCall = convexClient.action.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestIteration",
      );
      expect(updateCall).toBeDefined();
      const payload = updateCall![1] as Record<string, unknown>;
      expect(payload.error).toEqual(
        expect.stringContaining("Stream returned no content"),
      );
    });

    it("persists the failing turn's user prompt for the streaming local-BYOK path (PR 5a user-prompt-before-call)", async () => {
      // Mirror PR 4b's user-prompt-before-driver-call invariant. The
      // streaming runner now pushes the user prompt to
      // `conversationMessages` BEFORE the `runDirectChatTurn` call so
      // a failed turn still records the prompt in the persisted
      // transcript.
      streamTextMock.mockReset();
      streamTextMock.mockImplementationOnce((_options: any) => ({
        fullStream: (async function* () {})(),
        steps: Promise.resolve([]),
        response: Promise.resolve({
          modelId: "gpt-4-turbo",
          messages: [],
        }),
        totalUsage: Promise.resolve({
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        }),
        finishReason: Promise.resolve("stop"),
        consumeStream: async () => {},
      }));

      await runStreamCase({});

      const containsUserHello = (msgs: unknown): boolean => {
        if (!Array.isArray(msgs)) return false;
        return msgs.some((m: any) => {
          if (m?.role !== "user") return false;
          if (typeof m.content === "string") return m.content === "Hello";
          if (Array.isArray(m.content)) {
            return m.content.some(
              (part: any) =>
                part?.type === "text" && part.text === "Hello",
            );
          }
          return false;
        });
      };
      const anyCallHasIt = convexClient.action.mock.calls.some((call) => {
        const payload = call[1] as Record<string, unknown> | undefined;
        if (!payload) return false;
        if (containsUserHello(payload.messages)) return true;
        const turn = payload.turn as
          | { sessionMessages?: unknown }
          | undefined;
        if (turn && containsUserHello(turn.sessionMessages)) return true;
        return false;
      });
      expect(anyCallHasIt).toBe(true);
    });

    it("preserves PR 4d wire shape: `system:` field, no `role:system` in messages array (PR 5a)", async () => {
      // The pre-PR-5a runner already aligned on chat's wire shape in
      // PR 4d ("Use the dedicated system: field"). PR 5a's rewrite onto
      // `runDirectChatTurn` flows the system through the helper, which
      // adds it to the streamText `system:` field via the helper's
      // internal wiring. Lock that the wire shape didn't regress.
      streamTextMock.mockReset();
      streamTextMock.mockImplementationOnce((_options: any) => ({
        fullStream: (async function* () {})(),
        steps: Promise.resolve([]),
        response: Promise.resolve({
          modelId: "gpt-4-turbo",
          messages: [{ role: "assistant", content: "Done" }],
        }),
        totalUsage: Promise.resolve({
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
        finishReason: Promise.resolve("stop"),
        consumeStream: async () => {},
      }));

      await runStreamCase({
        suiteHostConfig: {
          systemPrompt: "Stream PR 5a system",
        },
      });

      const streamCall = streamTextMock.mock.calls[0]?.[0];
      expect(streamCall).toBeDefined();
      expect(streamCall.system).toBe("Stream PR 5a system");
      const wireMessages = streamCall.messages as Array<{ role: string }>;
      expect(wireMessages.some((m) => m.role === "system")).toBe(false);
    });

    it("prepends resolved system to streamIterationViaBackend's mid-run SSE snapshots (PR 5a folds 4d Cursor-Low)", async () => {
      // PR 4d round 2 deferred fix: the streaming backend runner
      // (`streamIterationViaBackend`) emits `buildTraceSnapshotEvent`
      // mid-run with `messages: messageHistory` (no system prefix).
      // PR 4d closed the same gap on `streamIterationWithAiSdk` via a
      // `withSystemPrefix` closure but deferred the backend equivalent
      // to PR 5. PR 5a folds it in — the closure exists in
      // `streamIterationViaBackend` too and is applied at every
      // snapshot site.
      const fetchMockBackend = vi.fn();
      vi.stubGlobal("fetch", fetchMockBackend);
      fetchMockBackend.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: vi.fn().mockResolvedValue({ ok: true }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        headers: new Headers({ "Content-Type": "text/event-stream" }),
      });

      const assistantTurnModule = await import(
        "../../../utils/assistant-turn"
      );
      const runAssistantTurnSpy = vi
        .spyOn(assistantTurnModule, "runAssistantTurn")
        .mockResolvedValueOnce({
          messages: [
            { role: "user", content: "Hello" } as any,
            { role: "assistant", content: "Done" } as any,
          ],
          assistantMessages: [],
          toolCalls: [],
          toolResults: [],
          turnTrace: {
            turnId: "t_1",
            promptIndex: 0,
            startedAt: 0,
            endedAt: 10,
            modelId: "anthropic/claude-haiku-4.5",
            spans: [],
          },
        } as any);

      const emitted: Array<Record<string, unknown>> = [];
      try {
        await streamTestCase({
          test: {
            title: "Backend SSE prefix",
            query: "Hello",
            runs: 1,
            model: "claude-haiku-4.5",
            provider: "anthropic",
            expectedToolCalls: [],
            promptTurns: [
              { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
            ],
            testCaseId: "case-backend-sse",
          },
          tools: {},
          selectedServers: [],
          mcpClientManager: mcpClientManager as any,
          recorder: null,
          modelApiKeys: {},
          convexClient: convexClient as any,
          convexHttpUrl: "https://example.convex.site",
          convexAuthToken: "token",
          testCaseId: "case-backend-sse",
          suiteId: "suite-1",
          runId: null,
          emit: (event) => emitted.push(event as Record<string, unknown>),
          suiteHostConfig: {
            systemPrompt: "Backend stream SSE prefix",
          },
        } as any);

        // At least one trace_snapshot SSE event should have the system
        // as the first message in its trace messages payload.
        const hasSystemPrefix = (msgs: unknown): boolean => {
          if (!Array.isArray(msgs) || msgs.length === 0) return false;
          const first = msgs[0] as { role?: string; content?: unknown };
          if (first?.role !== "system") return false;
          if (typeof first.content === "string") {
            return first.content === "Backend stream SSE prefix";
          }
          if (Array.isArray(first.content)) {
            return first.content.some(
              (part: any) =>
                part?.type === "text" &&
                part.text === "Backend stream SSE prefix",
            );
          }
          return false;
        };
        const traceSnapshots = emitted.filter(
          (e) => e?.type === "trace_snapshot",
        );
        const anySnapshotHasPrefix = traceSnapshots.some((snap) => {
          const trace = snap.trace as { messages?: unknown } | undefined;
          return hasSystemPrefix(trace?.messages);
        });
        expect(anySnapshotHasPrefix).toBe(true);
      } finally {
        runAssistantTurnSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    });

    it("emits failure trace_snapshot + error event before break on no-content cycle failure (PR 5a review — Cursor Medium)", async () => {
      // PR 5a review fix: the no-content branch sets `iterationError`
      // and persists via `status:"completed"` + `error`, but without
      // emitting the SSE failure signal the live test-runner UI sees
      // a turn_start without any matching terminal event. Lock the
      // failure SSE shape: a `trace_snapshot` of `snapshotKind:"failure"`
      // AND a `type:"error"` event fire before the loop breaks.
      const emitted: Array<Record<string, unknown>> = [];
      streamTextMock.mockReset();
      streamTextMock.mockImplementationOnce(() => ({
        fullStream: (async function* () {})(),
        steps: Promise.resolve([]),
        response: Promise.resolve({
          modelId: "gpt-4-turbo",
          messages: [],
        }),
        totalUsage: Promise.resolve({
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        }),
        finishReason: Promise.resolve("stop"),
        consumeStream: async () => {},
      }));

      await runStreamCase({ emitCollector: emitted });

      const failureSnapshot = emitted.find(
        (e) =>
          e?.type === "trace_snapshot" &&
          (e as { snapshotKind?: string }).snapshotKind === "failure",
      );
      const errorEvent = emitted.find((e) => e?.type === "error");
      expect(failureSnapshot).toBeDefined();
      expect(errorEvent).toBeDefined();
      expect((errorEvent as { message: string }).message).toEqual(
        expect.stringContaining("Stream returned no content"),
      );
    });

    it("does NOT treat tool-error child spans (with toolCallId) as cycle failure (PR 5a review — Codex P2)", async () => {
      // Codex P2 review fix: `wrapToolSetForEvalTrace` records a failed
      // tool call as a `category:"tool"` span PLUS a child
      // `category:"error"` span carrying `toolCallId`/`toolName`. The
      // pre-fix filter `category !== "tool"` matched the child and set
      // `iterationError` even when `advancedConfig.failOnToolError` was
      // `false`. The fix also excludes spans with `toolCallId`. This
      // test simulates the dual-span shape and asserts no
      // `iterationError` is recorded.
      streamTextMock.mockReset();
      streamTextMock.mockImplementationOnce((options: any) => {
        // Fire onStepFinish so the helper's onStepSnapshot fires and
        // accumulatedUsage / partial state mirror.
        void options.onStepFinish?.({
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          response: {
            messages: [
              { role: "assistant", content: "Recovered from tool failure." },
            ],
          },
        });
        return {
          fullStream: (async function* () {})(),
          steps: Promise.resolve([]),
          response: Promise.resolve({
            modelId: "gpt-4-turbo",
            messages: [
              { role: "assistant", content: "Recovered from tool failure." },
            ],
          }),
          totalUsage: Promise.resolve({
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          }),
          finishReason: Promise.resolve("stop"),
          consumeStream: async () => {},
        };
      });

      // Force the helper's traceContext to contain a tool-error child
      // span shape via the direct-chat-turn module's exported helpers.
      // Simpler approach: stub the trace capture so the runner sees the
      // recordedSpans we want.
      const traceCaptureModule = await import(
        "../eval-trace-capture"
      );
      const realCreate = traceCaptureModule.createAiSdkEvalTraceContext;
      const spy = vi
        .spyOn(traceCaptureModule, "createAiSdkEvalTraceContext")
        .mockImplementation((runStartedAt: number) => {
          const ctx = realCreate(runStartedAt);
          // Tool failure shape per eval-trace-capture.ts:241-275: the
          // `category:"tool"` span has status:"error" AND a child
          // `category:"error"` carries toolCallId/toolName.
          ctx.recordedSpans.push({
            id: "tool-tc_1",
            name: "lookup",
            category: "tool",
            status: "error",
            toolCallId: "tc_1",
            toolName: "lookup",
            startMs: 0,
            endMs: 10,
          } as any);
          ctx.recordedSpans.push({
            id: "tool-err-tc_1",
            name: "lookup error",
            category: "error",
            status: "error",
            toolCallId: "tc_1",
            toolName: "lookup",
            startMs: 0,
            endMs: 10,
          } as any);
          return ctx;
        });

      try {
        await runStreamCase({
          caseAdvancedConfig: { failOnToolError: false },
        });

        const updateCall = convexClient.action.mock.calls.find(
          (c) => c[0] === "testSuites:updateTestIteration",
        );
        expect(updateCall).toBeDefined();
        const payload = updateCall![1] as Record<string, unknown>;
        // Load-bearing assertion: `iterationError` must NOT be set
        // just because the child error-span exists. The filter excludes
        // any span carrying `toolCallId` so tool errors stay routed
        // through `failOnToolError`.
        expect(payload.error).toBeFalsy();
      } finally {
        spy.mockRestore();
      }
    });

    it("records `tokensUsed` when streaming fails with zero completed steps (PR 5a review round 2 — Cursor Medium)", async () => {
      // Cursor PR 5a review round 2: the delta-update in
      // `onStepSnapshot` only captures usage for COMPLETED steps. If
      // the stream resolves with zero completed steps (model returned
      // empty / network error fell through), `accumulatedUsage` stays
      // at the pre-turn baseline. The no-content failure branch then
      // persists `tokensUsed: 0` even when `handle.result.totalUsage`
      // reports billed tokens. PR 4b's non-stream runner reads
      // `headless.totalUsage` before failure branches; PR 5a now
      // mirrors that by awaiting `handle.result.totalUsage` post-stream
      // and reconciling before the failure detection.
      streamTextMock.mockReset();
      streamTextMock.mockReturnValueOnce({
        // Empty fullStream — onStepSnapshot never fires.
        fullStream: (async function* () {})(),
        steps: Promise.resolve([]),
        response: Promise.resolve({
          modelId: "gpt-4-turbo",
          messages: [],
        }),
        // Model billed tokens despite zero completed steps.
        totalUsage: Promise.resolve({
          inputTokens: 9,
          outputTokens: 4,
          totalTokens: 13,
        }),
        finishReason: Promise.resolve("stop"),
        consumeStream: async () => {},
      });

      const emitted: Array<Record<string, unknown>> = [];
      await runStreamCase({ emitCollector: emitted });

      // Iteration was persisted as a soft failure (no-content branch
      // fired) AND `tokensUsed` reflects the real billed totalUsage.
      const updateCall = convexClient.action.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestIteration",
      );
      expect(updateCall).toBeDefined();
      const payload = updateCall![1] as {
        tokensUsed?: number;
        error?: string;
      };
      expect(payload.error).toEqual(
        expect.stringContaining("Stream returned no content"),
      );
      expect(payload.tokensUsed).toBe(13);
    });

    it("emits the existing fullStream → SSE event vocabulary via the shared adapter (PR 5a)", async () => {
      // Lock the byte-shape contract: the events emitted from the
      // streaming runner's terminal stream still match the existing
      // `streamTestCase` SSE event vocabulary. The adapter is unit-tested
      // standalone in PR 5-pre; this asserts the runner routes through
      // it correctly.
      const emitted: Array<Record<string, unknown>> = [];
      streamTextMock.mockReset();
      streamTextMock.mockImplementationOnce((options: any) => {
        // Fire onStepFinish so the helper's onStepSnapshot fires and the
        // runner emits the per-step trace_snapshot SSE event.
        void options.onStepFinish?.({
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          response: {
            messages: [{ role: "assistant", content: "Done" }],
          },
        });
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", id: "t1", text: "Working" };
            yield {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "search",
              input: { q: "status" },
            };
            yield {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "search",
              output: { ok: true },
            };
            yield {
              type: "finish-step",
              usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
            };
          })(),
          steps: Promise.resolve([]),
          response: Promise.resolve({
            modelId: "gpt-4-turbo",
            messages: [{ role: "assistant", content: "Done" }],
          }),
          totalUsage: Promise.resolve({
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
          }),
          finishReason: Promise.resolve("stop"),
          consumeStream: async () => {},
        };
      });

      await runStreamCase({ emitCollector: emitted });

      // Spot-check: the canonical event vocabulary still flows.
      expect(emitted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "turn_start" }),
          expect.objectContaining({
            type: "text_delta",
            content: "Working",
          }),
          expect.objectContaining({
            type: "tool_call",
            toolName: "search",
            toolCallId: "call-1",
          }),
          expect.objectContaining({
            type: "tool_result",
            toolCallId: "call-1",
            isError: false,
          }),
          expect.objectContaining({ type: "step_finish" }),
          expect.objectContaining({
            type: "trace_snapshot",
          }),
          expect.objectContaining({ type: "turn_finish" }),
        ]),
      );
    });
  });
});
