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
});
