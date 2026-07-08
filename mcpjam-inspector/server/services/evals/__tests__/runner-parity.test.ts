import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PR0 of the runner-unification (plan: we-need-robustness-and-jaunty-toast.md).
// Golden-output parity harness: pins the *persisted Convex payload* and the
// *emitted EvalStreamEvent sequence* of every runner path BEFORE the four
// runners are merged into one engine. Later PRs (1-6) must keep these snapshots
// byte-stable (PR3 normalizes the intermediate finishParams `error` field, which
// is cosmetic — `finalizeEvalIteration` forwards error/details to Convex
// unconditionally — so these Convex-payload snapshots stay unchanged; PR5 adds
// NEW streaming-pinned snapshots).
//
// We snapshot a NORMALIZED projection (timestamps + volatile ids scrubbed), not
// raw payloads, so the contract is the durable shape, not wall-clock noise.

const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const createLlmModelMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({ id: "mock-model" }))
);

// Deterministic browser-session facts. The real `createBrowserSessionContext`
// depends on headless Chromium (not faithful in a unit test), so we mock it and
// let each case DECLARE the browser facts the runner reads at verdict/persist
// time — render observations, interaction steps (with widget→tool calls), and
// scripted-check failures. This pins how the runner MERGES/GATES/PERSISTS those
// facts (the surface the step-engine cutover must preserve); the harness's own
// render/interaction fidelity is covered by e2e. Inert by default so non-widget
// cases are unaffected.
const browserState = vi.hoisted(() => ({
  renderObservations: [] as any[],
  interactionSteps: [] as any[],
  scriptedCheckFailures: [] as any[],
  computerUseSupported: false as boolean,
}));

vi.mock("../../browser-session-context", () => ({
  createBrowserSessionContext: vi.fn(async () => ({
    computerUseSupported: browserState.computerUseSupported,
    computerUseVersion: null,
    computerWidgetTools: {},
    get widgetRenderObservations() {
      return browserState.renderObservations;
    },
    get browserInteractionSteps() {
      return browserState.interactionSteps;
    },
    prepareAdvertisedTools: undefined,
    get scriptedCheckFailures() {
      return browserState.scriptedCheckFailures;
    },
    mountedWidgetToolName: null,
    drainFollowUps: () => [],
    setActivePromptIndex: () => {},
    setActiveAuthoredStepId: () => {},
    setActiveWidgetChecks: () => {},
    flushActiveWidgetChecks: () => {},
    noteToolCallInput: () => {},
    handleEngineToolResult: async () => {},
    handleDirectToolResultChunk: async () => {},
    renderPinnedToolResult: async () => {},
    replayInteractStep: async () => ({ ok: false }),
    evaluateWidgetAssertion: async () => ({ ok: false }),
    setKeepWidgetsMountedForSteps: () => {},
    drainNewArtifacts: () => ({ observations: [], steps: [] }),
    dismissCarriedWidget: async () => {},
    collectVideo: async () => null,
    dispose: async () => {},
  })),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
    streamText: (...args: unknown[]) => streamTextMock(...args),
    stepCountIs: vi.fn(() => undefined),
  };
});

// Phase-4 PR0: `finalizePassedForEval` is NOT stubbed — the golden corpus must
// exercise the real 5-gate verdict (predicate gate, failOnToolError, tool-error
// trace gate) that the step-engine cutover preserves. For the existing
// prompt-only cases (no predicates, no tool errors) the real helper returns
// exactly `matchPassed`, so those baselines are unchanged.

vi.mock("../../../utils/chat-helpers", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-helpers")
  >("../../../utils/chat-helpers");
  return {
    ...actual,
    createLlmModel: (...args: Parameters<typeof actual.createLlmModel>) =>
      createLlmModelMock(...args),
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

import { runEvalSuiteWithAiSdk, streamTestCase } from "../../evals-runner";
import type { EvalStreamEvent } from "@/shared/eval-stream-events";

// ── normalization: scrub wall-clock + volatile values so snapshots are stable ──
const SCRUB_KEYS = new Set([
  "startedAt",
  "lastActivityAt",
  "turnStartedAt",
  "turnEndedAt",
  "createdAt",
  "updatedAt",
  "startMs",
  "endMs",
  "durationMs",
  // Per-run timing inside trace spans (time-to-first-chunk etc.) — varies
  // run-to-run; not part of the persisted-shape contract.
  "ttfcMs",
]);

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SCRUB_KEYS.has(k)) {
        out[k] = v == null ? v : "<scrubbed>";
      } else if (
        k === "id" &&
        typeof v === "string" &&
        /^eval-ai-err-\d+$/.test(v)
      ) {
        out[k] = "eval-ai-err-<scrubbed>";
      } else {
        out[k] = scrub(v);
      }
    }
    return out;
  }
  // Scrub epoch-ms-looking numbers (covers stray timestamps not under a known key).
  if (typeof value === "number" && value > 1_600_000_000_000) {
    return "<scrubbed-ts>";
  }
  return value;
}

/** The persisted contract: each Convex write the runner made, normalized. */
function summarizeConvexActions(
  action: ReturnType<typeof vi.fn>
): Array<{ ref: string; payload: unknown }> {
  return action.mock.calls.map((call) => ({
    ref: String(call[0]),
    payload: scrub(call[1]),
  }));
}

/** The SSE contract: the type sequence (step_status carries kind+status). */
function summarizeEvents(
  events: EvalStreamEvent[]
): Array<string | { type: string; kind?: string; status?: string }> {
  return events.map((e) =>
    e.type === "step_status"
      ? { type: e.type, kind: e.kind, status: e.status }
      : e.type
  );
}

describe("runner parity (golden Convex payload + event sequence)", () => {
  const convexClient = {
    mutation: vi.fn(),
    query: vi.fn(),
    action: vi.fn(),
  };
  const mcpClientManager = {
    getToolsForAiSdk: vi.fn(),
    listServers: vi.fn(),
    getAllToolsMetadata: vi.fn().mockReturnValue({}),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    browserState.renderObservations = [];
    browserState.interactionSteps = [];
    browserState.scriptedCheckFailures = [];
    browserState.computerUseSupported = false;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    convexClient.mutation.mockResolvedValue({ iterationId: "iter-1" });
    convexClient.query.mockResolvedValue({ status: "running" });
    convexClient.action.mockResolvedValue(undefined);
    mcpClientManager.getToolsForAiSdk.mockResolvedValue({});
    mcpClientManager.listServers.mockReturnValue(["srv-1"]);
    streamTextMock.mockReturnValue({
      consumeStream: async () => {},
      fullStream: (async function* () {})(),
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

  /** SSE-format backend response for the hosted path. */
  function backendStreamResponse() {
    const chunks = [
      'data: {"type":"text-delta","id":"t1","delta":"Done"}\n\n',
      'data: {"type":"finish","finishReason":"stop","messageMetadata":{"inputTokens":1,"outputTokens":2,"totalTokens":3}}\n\n',
      "data: [DONE]\n\n",
    ];
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body,
      text: vi.fn().mockResolvedValue(""),
    };
  }

  const LOCAL_MODEL = { model: "gpt-4-turbo", provider: "openai" } as const;
  const HOSTED_MODEL = {
    model: "claude-haiku-4.5",
    provider: "anthropic",
  } as const;

  function streamCase(args: {
    model: { model: string; provider: string };
    promptTurns: unknown[];
    modelApiKeys?: Record<string, string>;
    emit: (e: EvalStreamEvent) => void;
  }) {
    return streamTestCase({
      test: {
        title: "Case",
        query: "Hello",
        runs: 1,
        model: args.model.model,
        provider: args.model.provider,
        expectedToolCalls: [],
        promptTurns: args.promptTurns,
        testCaseId: "case-1",
      },
      tools: {},
      selectedServers: [],
      mcpClientManager: mcpClientManager as any,
      recorder: null,
      modelApiKeys: args.modelApiKeys ?? {},
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      testCaseId: "case-1",
      suiteId: "suite-1",
      runId: null,
      emit: args.emit,
    } as any);
  }

  function batchSuite(args: {
    model: { model: string; provider: string };
    promptTurns?: unknown[];
    steps?: unknown[];
    modelApiKeys?: Record<string, string>;
    /** Extra top-level test fields (e.g. `isNegativeTest`, `matchOptions`). */
    extra?: Record<string, unknown>;
  }) {
    return runEvalSuiteWithAiSdk({
      suiteId: "suite-1",
      runId: null,
      config: {
        tests: [
          {
            title: "Case",
            query: "Hello",
            runs: 1,
            model: args.model.model,
            provider: args.model.provider,
            expectedToolCalls: [],
            ...(args.steps
              ? { steps: args.steps }
              : { promptTurns: args.promptTurns ?? PROMPT_ONLY }),
            testCaseId: "case-1",
            ...args.extra,
          },
        ],
        environment: { servers: ["srv-1"] },
      },
      modelApiKeys: args.modelApiKeys ?? {},
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      mcpClientManager: mcpClientManager as any,
      testCaseId: "case-1",
    } as any);
  }

  const PROMPT_ONLY = [
    { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
  ];

  // Phase-4 PR0 corpus extension (plan: please-do-a-sequential-fail-fast-verdict.md).
  // These baseline today's verdict/persistence output for cases the step-engine
  // cutover must keep byte-identical. Wave 1 = infra-free verdict-spine cases
  // (multi-turn, negative test). Wave 2 (separate increment) adds gate-faithful
  // cases (un-stub finalizePassedForEval) + browser-mocked widget/interact cases.
  const MULTI_TURN = [
    { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
    { id: "turn-2", prompt: "Again", expectedToolCalls: [] },
  ];

  it("local-stream prompt-only: events + convex payload", async () => {
    const emitted: EvalStreamEvent[] = [];
    await streamCase({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: PROMPT_ONLY,
      emit: (e) => emitted.push(e),
    });
    expect(summarizeEvents(emitted)).toMatchSnapshot("events");
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  it("local-stream prompt-only throw path: events + convex payload", async () => {
    streamTextMock.mockReturnValueOnce({
      consumeStream: async () => {},
      fullStream: (async function* () {
        throw new Error("provider stream exploded");
      })(),
      response: Promise.resolve({
        modelId: "gpt-5-mini",
        messages: [],
      }),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
      finishReason: Promise.resolve("error"),
    });

    const emitted: EvalStreamEvent[] = [];
    await streamCase({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: PROMPT_ONLY,
      emit: (e) => emitted.push(e),
    });
    expect(summarizeEvents(emitted)).toMatchSnapshot("events");
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  it("local-batch prompt-only: convex payload", async () => {
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: PROMPT_ONLY,
    });
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  it("hosted-stream prompt-only: events + convex payload", async () => {
    fetchMock.mockResolvedValue(backendStreamResponse());
    const emitted: EvalStreamEvent[] = [];
    await streamCase({
      model: HOSTED_MODEL,
      promptTurns: PROMPT_ONLY,
      emit: (e) => emitted.push(e),
    });
    expect(summarizeEvents(emitted)).toMatchSnapshot("events");
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  it("hosted-batch prompt-only: convex payload", async () => {
    fetchMock.mockResolvedValue(backendStreamResponse());
    await batchSuite({ model: HOSTED_MODEL, promptTurns: PROMPT_ONLY });
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  it("local-batch model-free pinned (setup failure: server not connected): convex payload + status", async () => {
    // A pinned-only (no prompt) case runs model-free on the local path. Here the
    // pinned server "Asana" is NOT in the connected set → `pinned_server_not_connected`
    // setup failure (status:"failed") + the default `widgetRendered` predicate
    // fails (no render). This is the pinned-setup-failure corpus entry. (Until
    // PR0's un-stub, `finalizePassedForEval` was mocked to `matchPassed`, which
    // masked both gates and showed a spurious `result:"passed"`.)
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: [
        {
          id: "turn-1",
          prompt: "",
          expectedToolCalls: [],
          pinnedToolCall: {
            serverName: "Asana",
            toolName: "search",
            arguments: { q: "x" },
          },
        },
      ],
    });
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  // ── Phase-4 PR0 corpus, wave 1 (infra-free) ──────────────────────────────

  it("local-stream multi-turn: events + convex payload", async () => {
    const emitted: EvalStreamEvent[] = [];
    await streamCase({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: MULTI_TURN,
      emit: (e) => emitted.push(e),
    });
    expect(summarizeEvents(emitted)).toMatchSnapshot("events");
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  it("local-batch multi-turn: convex payload", async () => {
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: MULTI_TURN,
    });
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  it("hosted-batch multi-turn: convex payload", async () => {
    // Fresh stream per turn: a `ReadableStream` is single-consumption, so
    // `mockResolvedValue` (one shared stream) would starve turn 2.
    fetchMock.mockImplementation(async () => backendStreamResponse());
    await batchSuite({ model: HOSTED_MODEL, promptTurns: MULTI_TURN });
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  // A local streamText result that emits the given tool calls (via `steps`) and
  // optionally a tool-result error (via `response.messages`), so we can exercise
  // the matcher actuals + the `failOnToolError` trace gate.
  function localStreamResult(opts: {
    toolCalls?: Array<{ toolName: string; args: Record<string, unknown> }>;
    toolError?: boolean;
  }) {
    const messages: unknown[] = [{ role: "assistant", content: "Done" }];
    if (opts.toolError) {
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "search",
            toolCallId: "tc-err",
            output: { type: "error-text", value: "boom" },
            isError: true,
          },
        ],
      });
    }
    return {
      consumeStream: async () => {},
      fullStream: (async function* () {})(),
      response: Promise.resolve({ modelId: "gpt-5-mini", messages }),
      steps: Promise.resolve(
        opts.toolCalls ? [{ toolCalls: opts.toolCalls }] : []
      ),
      totalUsage: Promise.resolve({
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      }),
      finishReason: Promise.resolve("stop"),
    };
  }

  it("local-batch case predicate + per-turn check (ordering): convex payload", async () => {
    // Locks invariant #2: `metadata.predicates = [case-level, …per-turn]`.
    // Both predicates pass against the mocked assistant message "Done".
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: [
        {
          id: "turn-1",
          prompt: "Hello",
          expectedToolCalls: [],
          checks: [{ type: "responseContains", needle: "Done" }],
        },
      ],
      extra: {
        successPredicates: [{ type: "finalAssistantMessageNonEmpty" }],
      },
    });
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  it("local-batch tool call matches expected: convex payload", async () => {
    streamTextMock.mockReturnValue(
      localStreamResult({
        toolCalls: [{ toolName: "search", args: { q: "x" } }],
      })
    );
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: [
        {
          id: "turn-1",
          prompt: "Search",
          expectedToolCalls: [{ toolName: "search", arguments: { q: "x" } }],
        },
      ],
    });
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  it("local-batch tool error, failOnToolError:true → failed: convex payload", async () => {
    streamTextMock.mockReturnValue(localStreamResult({ toolError: true }));
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: PROMPT_ONLY,
      extra: { advancedConfig: { failOnToolError: true } },
    });
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  it("local-batch tool error, failOnToolError:false → passed: convex payload", async () => {
    streamTextMock.mockReturnValue(localStreamResult({ toolError: true }));
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: PROMPT_ONLY,
      extra: { advancedConfig: { failOnToolError: false } },
    });
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  // ── Phase-4 PR0 corpus, wave 2 (browser-mocked widget/scripted-check) ─────
  // These DECLARE browser facts (render obs / interaction steps / scripted-check
  // failures) the runner reads at verdict/persist time, pinning how it merges +
  // gates + persists them. Harness render fidelity itself is covered by e2e.

  it("local-batch widget rendered (widgetRendered predicate passes): convex payload", async () => {
    browserState.renderObservations = [
      {
        toolCallId: "tc-1",
        toolName: "search-products",
        serverId: "srv-1",
        status: "rendered",
        elapsedMs: 50,
        ts: 1,
        promptIndex: 0,
      },
    ];
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: PROMPT_ONLY,
      extra: { successPredicates: [{ type: "widgetRendered" }] },
    });
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  it("local-batch interact fires widget tool call (merged into matcher): convex payload", async () => {
    browserState.renderObservations = [
      {
        toolCallId: "tc-1",
        toolName: "search-products",
        serverId: "srv-1",
        status: "rendered",
        elapsedMs: 50,
        ts: 1,
        promptIndex: 0,
      },
    ];
    browserState.interactionSteps = [
      {
        toolCallId: "tc-1",
        stepIndex: 0,
        promptIndex: 0,
        action: "left_click",
        widgetToolCalls: [
          { name: "add-to-cart", args: { id: 1 }, ok: true, elapsedMs: 10 },
        ],
        elapsedMs: 15,
        source: "scripted",
        locatorLabel: 'role=button[name="Add to cart"]',
        ts: 2,
      },
    ];
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: [
        {
          id: "turn-1",
          prompt: "Add it",
          // The widget-initiated call should count as an actual for this turn.
          expectedToolCalls: [
            { toolName: "add-to-cart", arguments: { id: 1 } },
          ],
        },
      ],
    });
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  it("local-batch unrendered widget fail-closed (scriptedCheckFailures gate): convex payload", async () => {
    // Widget never rendered → fail-closed scripted-check failure → verdict fails,
    // even though the matcher/predicates would otherwise pass.
    browserState.scriptedCheckFailures = [
      {
        toolName: "search-products",
        reason: 'no widget rendered for tool "search-products"',
      },
    ];
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: PROMPT_ONLY,
    });
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });

  it("§2: a failed widget DOM assert FAILS the iteration (flag-on)", async () => {
    // The browser mock's evaluateWidgetAssertion returns { ok: false }, so the
    // widgetCheck assert step fails. It lands in state.assertionResults (NOT
    // browser.scriptedCheckFailures), so without the §2 fix the iteration would
    // pass despite the failed widget assertion.
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: [
        {
          id: "t0",
          prompt: "render and check",
          expectedToolCalls: [],
          widgetChecks: [
            {
              toolName: "search-products",
              steps: [
                {
                  kind: "assert",
                  assertion: { type: "textVisible", text: "X" },
                },
              ],
            },
          ],
        },
      ],
    });
    const payload = JSON.stringify(summarizeConvexActions(convexClient.action));
    expect(payload).toContain('"result":"failed"');
  });

  it("§2 (hosted): a failed widget DOM assert FAILS the iteration", async () => {
    fetchMock.mockImplementation(async () => backendStreamResponse());
    await batchSuite({
      model: HOSTED_MODEL,
      promptTurns: [
        {
          id: "t0",
          prompt: "render and check",
          expectedToolCalls: [],
          widgetChecks: [
            {
              toolName: "search-products",
              steps: [
                {
                  kind: "assert",
                  assertion: { type: "textVisible", text: "X" },
                },
              ],
            },
          ],
        },
      ],
    });
    const payload = JSON.stringify(summarizeConvexActions(convexClient.action));
    expect(payload).toContain('"result":"failed"');
  });

  it("§2: a failed interact FAILS the iteration (flag-on)", async () => {
    // replayInteractStep returns { ok: false } → state.interactionFailures.
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: [
        {
          id: "t0",
          prompt: "render and click",
          expectedToolCalls: [],
          widgetChecks: [
            {
              toolName: "search-products",
              steps: [{ kind: "click", target: { testId: "add" } }],
            },
          ],
        },
      ],
    });
    const payload = JSON.stringify(summarizeConvexActions(convexClient.action));
    expect(payload).toContain('"result":"failed"');
  });

  it("PR6 fail-fast: a failed check halts the run and persists skippedSteps", async () => {
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: [
        {
          id: "t0",
          prompt: "one",
          expectedToolCalls: [],
          // Fails (assistant message is "Done") → the t0 assert step halts the run.
          checks: [{ type: "responseContains", needle: "WILL-NOT-MATCH" }],
        },
        { id: "t1", prompt: "two", expectedToolCalls: [] },
      ],
    });
    const payload = JSON.stringify(summarizeConvexActions(convexClient.action));
    // Later turn's prompt step was Skipped (never ran) and persisted.
    expect(payload).toContain("skippedSteps");
    // Stopping only ever happens because something failed (compact JSON: no space).
    expect(payload).toContain('"result":"failed"');
  });

  it("hosted-batch responseContains assert step fails when needle wrong", async () => {
    fetchMock.mockImplementation(async () => backendStreamResponse());
    await batchSuite({
      model: HOSTED_MODEL,
      steps: [
        { id: "p", kind: "prompt", prompt: "Hello" },
        {
          id: "a",
          kind: "assert",
          assertion: { type: "responseContains", needle: "WILL-NOT-MATCH" },
        },
      ],
    });
    const payload = JSON.stringify(summarizeConvexActions(convexClient.action));
    expect(payload).toContain('"result":"failed"');
  });

  it("hosted-batch step assert persists scoped predicate in metadata.predicates", async () => {
    fetchMock.mockImplementation(async () => backendStreamResponse());
    await batchSuite({
      model: HOSTED_MODEL,
      steps: [
        { id: "p", kind: "prompt", prompt: "Hello" },
        {
          id: "a",
          kind: "assert",
          assertion: { type: "responseContains", needle: "Done" },
        },
      ],
    });
    const payload = JSON.stringify(summarizeConvexActions(convexClient.action));
    expect(payload).toContain('"type":"responseContains"');
    expect(payload).toContain('"scope"');
  });

  it("local-batch negative test (no forbidden calls): convex payload", async () => {
    // Negative-test branch of `evaluateMultiTurnResults`: passes when the
    // forbidden tools are NOT called. Baselines the negative matcher path.
    await batchSuite({
      model: LOCAL_MODEL,
      modelApiKeys: { openai: "sk-test" },
      promptTurns: PROMPT_ONLY,
      extra: { isNegativeTest: true },
    });
    expect(summarizeConvexActions(convexClient.action)).toMatchSnapshot(
      "convex"
    );
  });
});
