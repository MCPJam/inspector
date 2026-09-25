/**
 * Saved model selections through the eval runner (model selection contract,
 * acceptance scenarios 1 and 4): an explicit `org` / `local` selection never
 * matches the hosted catalog first, a `hosted` one goes to the hosted rail,
 * a legacy bare id keeps hosted-first, and a connection that cannot be
 * reached refuses with `credential_missing` before any request is built.
 *
 * Mocks mirror `evals-runner.test.ts`.
 */
import { logger } from "../../../utils/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const preparedToolsOverride = vi.hoisted(() => ({
  current: undefined as Record<string, any> | undefined,
}));
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

// Most tests here want the matcher's verdict to BE the iteration verdict, so
// the gates are stubbed out. A test that exercises a gate flips `useReal`.
const finalizePassedStub = vi.hoisted(() => ({ useReal: false }));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    finalizePassedForEval: (
      params: Parameters<typeof actual.finalizePassedForEval>[0],
    ) =>
      finalizePassedStub.useReal
        ? actual.finalizePassedForEval(params)
        : params.matchPassed,
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
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-helpers")
  >("../../../utils/chat-helpers");
  return {
    ...actual,
    createLlmModel: (
      modelDefinition: unknown,
      apiKey: unknown,
      baseUrls?: unknown,
      customProviders?: unknown,
    ) => createLlmModelMock(modelDefinition, apiKey, baseUrls, customProviders),
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
    allTools: preparedToolsOverride.current ?? {},
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

import type { ModelSelection } from "@mcpjam/sdk";
import { runEvalSuiteWithAiSdk } from "../../evals-runner";

const SAME_ID = "anthropic/claude-haiku-4.5";
const ORG_OPENROUTER: ModelSelection = {
  modelId: SAME_ID,
  source: "org",
  connectionRef: { kind: "orgProvider", id: "orgprov_openrouter_1" },
  fallback: { provider: "none", model: "none" },
};
const HOSTED: ModelSelection = {
  modelId: SAME_ID,
  source: "hosted",
  fallback: { provider: "none", model: "none" },
};

function createBackendStreamResponse() {
  const chunks = [
    'data: {"type":"text-delta","id":"t1","delta":"Done"}\n\n',
    'data: {"type":"finish","finishReason":"stop","messageMetadata":{"inputTokens":1,"outputTokens":2,"totalTokens":3}}\n\n',
    "data: [DONE]\n\n",
  ];
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
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

describe("eval runner reads saved model selections", () => {
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
    getAllToolAnnotations: vi.fn(),
    hasCachedToolAnnotations: vi.fn(),
    getAllToolsMetadata: vi.fn().mockReturnValue({}),
    executeTool: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => createBackendStreamResponse());
    vi.stubGlobal("fetch", fetchMock);
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    convexClient.mutation.mockResolvedValue({ iterationId: "iter-1" });
    convexClient.query.mockResolvedValue({ status: "running" });
    convexClient.action.mockImplementation(async (name: string) =>
      name === "testSuites:startQuickRunIteration"
        ? { iterationId: "iter-1" }
        : undefined,
    );
    mcpClientManager.getToolsForAiSdk.mockResolvedValue({});
    mcpClientManager.listTools.mockResolvedValue({ tools: [] });
    mcpClientManager.getAllToolAnnotations.mockReturnValue({});
    mcpClientManager.hasCachedToolAnnotations.mockReturnValue(true);
    mcpClientManager.getConnectionStatus.mockReturnValue("connected");
    mcpClientManager.listServers.mockReturnValue(["srv-1"]);
    preparedToolsOverride.current = undefined;
    streamTextMock.mockReset();
    streamTextMock.mockReturnValue({
      consumeStream: async () => {},
      response: Promise.resolve({
        modelId: "gpt-4o",
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

  function run(
    test: {
      model: string;
      provider: string;
      selection?: ModelSelection;
    },
    options: Record<string, unknown> = {},
  ) {
    return runEvalSuiteWithAiSdk({
      suiteId: "suite-1",
      runId: null,
      config: {
        tests: [
          {
            title: "Case",
            query: "Hello",
            runs: 1,
            ...test,
            expectedToolCalls: [],
            promptTurns: [
              { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
            ],
            testCaseId: "case-1",
          },
        ],
        environment: { servers: ["srv-1"] },
      },
      convexClient: convexClient as any,
      convexHttpUrl: "https://example.convex.site",
      convexAuthToken: "token",
      mcpClientManager: mcpClientManager as any,
      testCaseId: "case-1",
      ...options,
    } as any);
  }

  /**
   * A refused case fails the way a missing API key always has: the case
   * rejects before any iteration starts, and the suite counts it as failed.
   */
  async function expectRefused(pending: Promise<unknown>, code: string) {
    const errorSpy = vi.spyOn(logger, "error");
    await pending;
    const refusal = errorSpy.mock.calls.find(
      ([message]) => message === "[evals] Test case failed:",
    )?.[1] as { name?: string; code?: string; message?: string } | undefined;
    errorSpy.mockRestore();
    expect(refusal?.name).toBe("ModelResolutionRefusalError");
    expect(refusal?.code).toBe(code);
    expect(refusal?.message).toMatch(new RegExp(`^${code}: `));
  }

  function requestTo(path: string) {
    const call = fetchMock.mock.calls.find(
      ([url]) => url === `https://example.convex.site${path}`,
    );
    return call
      ? JSON.parse((call[1] as { body?: string }).body ?? "{}")
      : null;
  }

  describe("scenario 1: one id in the hosted catalog and on an org OpenRouter connection", () => {
    it("source org → /stream/org with that provider, never the hosted rail", async () => {
      await run(
        { model: SAME_ID, provider: "openrouter", selection: ORG_OPENROUTER },
        {
          // A key in the request must not divert an org choice onto the
          // local path either.
          modelApiKeys: { openrouter: "sk-or-local" },
          orgModelConfigTarget: { projectId: "project-1" },
        },
      );
      const body = requestTo("/stream/org");
      expect(body).toMatchObject({
        model: SAME_ID,
        providerKey: "openrouter",
        projectId: "project-1",
      });
      expect(body).not.toHaveProperty("apiKey");
      expect(requestTo("/stream")).toBeNull();
      expect(createLlmModelMock).not.toHaveBeenCalled();
    });

    it("source hosted → the hosted /stream request", async () => {
      await run(
        { model: SAME_ID, provider: "openrouter", selection: HOSTED },
        { orgModelConfigTarget: { projectId: "project-1" } },
      );
      expect(requestTo("/stream")).toMatchObject({ model: SAME_ID });
      expect(requestTo("/stream/org")).toBeNull();
      expect(createLlmModelMock).not.toHaveBeenCalled();
    });

    it("legacy bare id (no selection) keeps hosted-first", async () => {
      await run(
        { model: SAME_ID, provider: "openrouter" },
        { orgModelConfigTarget: { projectId: "project-1" } },
      );
      expect(requestTo("/stream")).toMatchObject({ model: SAME_ID });
      expect(requestTo("/stream/org")).toBeNull();
    });
  });

  describe("scenario 4: org connection gone after save", () => {
    it("refuses credential_missing and never runs on MCPJam's key", async () => {
      await expectRefused(
        run(
          { model: SAME_ID, provider: "openrouter", selection: ORG_OPENROUTER },
          {
            orgModelConfigTarget: { projectId: "project-1" },
            // The run's resolved org config no longer lists the provider.
            orgModelConfig: {
              providers: [{ providerKey: "openai", apiKey: "sk-org" }],
            },
          },
        ),
        "credential_missing",
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(createLlmModelMock).not.toHaveBeenCalled();
    });

    it("refuses credential_missing when the run has no organization to resolve it in", async () => {
      await expectRefused(
        run(
          { model: SAME_ID, provider: "openrouter", selection: ORG_OPENROUTER },
          { modelApiKeys: { openrouter: "sk-or-local" } },
        ),
        "credential_missing",
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(createLlmModelMock).not.toHaveBeenCalled();
    });
  });

  describe("local selections", () => {
    const LOCAL_OPENAI: ModelSelection = {
      modelId: "openai/gpt-4o",
      source: "local",
      connectionRef: { kind: "localProvider", providerKey: "openai" },
      nativeModelId: "gpt-4o",
      fallback: { provider: "none", model: "none" },
    };

    it("run on the request's own key with the native id", async () => {
      await run(
        {
          model: "openai/gpt-4o",
          provider: "openai",
          selection: LOCAL_OPENAI,
        },
        {
          modelApiKeys: { openai: "sk-local" },
          orgModelConfigTarget: { projectId: "project-1" },
        },
      );
      expect(createLlmModelMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "gpt-4o", provider: "openai" }),
        "sk-local",
        undefined,
        undefined,
      );
      expect(requestTo("/stream")).toBeNull();
      expect(requestTo("/stream/org")).toBeNull();
    });

    it("without the local key: credential_missing, not the org key or the hosted twin", async () => {
      await expectRefused(
        run(
          {
            model: "openai/gpt-4o",
            provider: "openai",
            selection: LOCAL_OPENAI,
          },
          {
            orgModelConfigTarget: { projectId: "project-1" },
            orgModelConfig: {
              providers: [{ providerKey: "openai", apiKey: "sk-org" }],
            },
          },
        ),
        "credential_missing",
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(createLlmModelMock).not.toHaveBeenCalled();
    });
  });
});
