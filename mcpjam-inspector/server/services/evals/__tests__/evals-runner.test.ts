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
    generateTextMock.mockImplementationOnce(async (options: any) => {
      await options.onStepFinish?.({
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
        response: {
          modelId: "gpt-5-mini",
          messages: [{ role: "assistant", content: "Done" }],
        },
        steps: [],
        usage: {
          inputTokens: 4,
          outputTokens: 6,
          totalTokens: 10,
        },
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

      // The runner must NOT have called generateText — the failure happens
      // before any model invocation.
      expect(generateTextMock).not.toHaveBeenCalled();
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
});
