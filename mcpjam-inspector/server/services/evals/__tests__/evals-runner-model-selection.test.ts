/**
 * Saved model selections through the eval runner (model selection contract,
 * acceptance scenarios 1 and 4): an explicit `org` / `local` selection never
 * matches the hosted catalog first, a `hosted` one goes to the hosted rail,
 * a legacy bare id keeps hosted-first, and a connection that cannot be
 * reached refuses with `credential_missing` before any request is built.
 * A hosted or org selection is forwarded to the backend as `modelSelection`
 * (so its resolver re-checks the connection and records the requested
 * selection); a local selection and a legacy id never are.
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

const admittedFactory = vi.hoisted(() => vi.fn(() => ({ id: "freshly-admitted-model" })));
vi.mock("@mcpjam/sdk/model-factory", async (importActual) => ({
  ...await importActual<typeof import("@mcpjam/sdk/model-factory")>(),
  buildOrgModelFromResolvedConfig: admittedFactory,
}));

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
      advancedConfig?: Record<string, unknown>;
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

  describe("a refused case on a suite run", () => {
    it("puts the refusal code and reason on that case's pending rows", async () => {
      convexClient.query.mockImplementation(async (name: string) =>
        name === "testSuites:getTestSuiteRunDetails"
          ? {
              iterations: [
                {
                  _id: "iter-refused",
                  status: "pending",
                  testCaseId: "case-1",
                },
                // Another case's row, and a row already claimed: untouched.
                { _id: "iter-other", status: "pending", testCaseId: "case-2" },
                {
                  _id: "iter-running",
                  status: "running",
                  testCaseId: "case-1",
                },
              ],
            }
          : { status: "running" },
      );
      const recorder = {
        runId: "run-1",
        suiteId: "suite-1",
        startIteration: vi.fn(),
        finishIteration: vi.fn(),
        finalize: vi.fn(),
      };
      await run(
        { model: SAME_ID, provider: "openrouter", selection: ORG_OPENROUTER },
        {
          runId: "run-1",
          recorder,
          orgModelConfigTarget: { projectId: "project-1" },
          orgModelConfig: {
            providers: [{ providerKey: "openai", apiKey: "sk-org" }],
          },
        },
      );

      expect(recorder.finishIteration).toHaveBeenCalledTimes(1);
      const finished = recorder.finishIteration.mock.calls[0]![0] as {
        iterationId?: string;
        status?: string;
        error?: string;
      };
      expect(finished.iterationId).toBe("iter-refused");
      expect(finished.status).toBe("setup_failed");
      expect(finished.error).toMatch(
        /^Model selection refused — credential_missing: /,
      );
      expect(JSON.stringify(finished)).not.toContain("sk-org");
      expect(fetchMock).not.toHaveBeenCalled();
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

  describe("forwards the saved selection to the backend as modelSelection", () => {
    /** Every Convex request body the run sent, by path. */
    function allRequestBodies() {
      return fetchMock.mock.calls
        .filter(([url]) =>
          String(url).startsWith("https://example.convex.site/"),
        )
        .map(([url, init]) => ({
          path: String(url).slice("https://example.convex.site".length),
          body: JSON.parse((init as { body?: string }).body ?? "{}"),
        }));
    }

    it("org → /stream/org carries the selection with its connectionRef", async () => {
      await run(
        { model: SAME_ID, provider: "openrouter", selection: ORG_OPENROUTER },
        { orgModelConfigTarget: { projectId: "project-1" } },
      );
      const body = requestTo("/stream/org");
      expect(body).toMatchObject({
        model: SAME_ID,
        providerKey: "openrouter",
        projectId: "project-1",
      });
      expect(body.modelSelection).toEqual(ORG_OPENROUTER);
      expect(body.modelSelection.connectionRef).toEqual({
        kind: "orgProvider",
        id: "orgprov_openrouter_1",
      });
    });

    it("org on a local-runtime-eligible provider → /stream/org/resolve carries it too", async () => {
      const ORG_OLLAMA: ModelSelection = {
        modelId: "ollama/llama3",
        source: "org",
        connectionRef: { kind: "orgProvider", id: "orgprov_ollama_1" },
        nativeModelId: "llama3",
        fallback: { provider: "none", model: "none" },
      };
      fetchMock.mockImplementation(async (url: string) =>
        url === "https://example.convex.site/stream/org/resolve"
          ? {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                runtimeLocation: "cloud",
                providerKey: "ollama",
              }),
              text: async () => "",
            }
          : createBackendStreamResponse(),
      );
      await run(
        { model: "llama3", provider: "ollama", selection: ORG_OLLAMA },
        { orgModelConfigTarget: { projectId: "project-1" } },
      );
      const resolveBody = requestTo("/stream/org/resolve");
      expect(resolveBody).toMatchObject({
        projectId: "project-1",
        providerKey: "ollama",
        model: "llama3",
      });
      expect(resolveBody.modelSelection).toEqual(ORG_OLLAMA);
      expect(requestTo("/stream/org")?.modelSelection).toEqual(ORG_OLLAMA);
    });

    it("hosted → /stream carries the selection with its fallback", async () => {
      const HOSTED_WITH_FALLBACK: ModelSelection = {
        ...HOSTED,
        fallback: { provider: "openrouter", model: "none" },
      };
      await run(
        {
          model: SAME_ID,
          provider: "openrouter",
          selection: HOSTED_WITH_FALLBACK,
        },
        { orgModelConfigTarget: { projectId: "project-1" } },
      );
      const body = requestTo("/stream");
      expect(body).toMatchObject({ model: SAME_ID, projectId: "project-1" });
      expect(body.modelSelection).toEqual(HOSTED_WITH_FALLBACK);
      expect(body.modelSelection.fallback).toEqual({
        provider: "openrouter",
        model: "none",
      });
    });

    it("a legacy bare id sends no modelSelection", async () => {
      await run(
        { model: SAME_ID, provider: "openrouter" },
        { orgModelConfigTarget: { projectId: "project-1" } },
      );
      const bodies = allRequestBodies();
      expect(bodies.map((b) => b.path)).toContain("/stream");
      for (const { body } of bodies) {
        expect(body).not.toHaveProperty("modelSelection");
      }
    });

    it("a local selection is never sent to the backend", async () => {
      const LOCAL_OPENAI: ModelSelection = {
        modelId: "openai/gpt-4o",
        source: "local",
        connectionRef: { kind: "localProvider", providerKey: "openai" },
        fallback: { provider: "none", model: "none" },
      };
      await run(
        { model: "openai/gpt-4o", provider: "openai", selection: LOCAL_OPENAI },
        {
          modelApiKeys: { openai: "sk-local" },
          orgModelConfigTarget: { projectId: "project-1" },
        },
      );
      expect(createLlmModelMock).toHaveBeenCalled();
      for (const { body } of allRequestBodies()) {
        expect(body).not.toHaveProperty("modelSelection");
      }
      expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
        "localProvider",
      );
    });

    it("a selection with a field outside the shape (a key) is refused, not forwarded", async () => {
      const errorSpy = vi.spyOn(logger, "error");
      await run(
        {
          model: SAME_ID,
          provider: "openrouter",
          selection: {
            ...ORG_OPENROUTER,
            apiKey: "sk-should-never-leave",
          } as ModelSelection,
        },
        { orgModelConfigTarget: { projectId: "project-1" } },
      );
      const failure = errorSpy.mock.calls.find(
        ([message]) => message === "[evals] Test case failed:",
      )?.[1] as { name?: string; message?: string } | undefined;
      errorSpy.mockRestore();
      expect(failure?.name).toBe("ModelSelectionValidationError");
      expect(failure?.message).toContain("apiKey");
      expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
        "sk-should-never-leave",
      );
    });

    it("is sent unconditionally: no capability probe gates it", async () => {
      // The deployed backends read request fields by name and ignore unknown
      // ones, so there is nothing to gate on (unlike the Convex writers, whose
      // validators reject unknown args and are gated on
      // `getCapabilities.modelSelections`).
      await run(
        { model: SAME_ID, provider: "openrouter", selection: ORG_OPENROUTER },
        { orgModelConfigTarget: { projectId: "project-1" } },
      );
      expect(requestTo("/stream/org")?.modelSelection).toEqual(ORG_OPENROUTER);
      const probed = [
        ...convexClient.query.mock.calls,
        ...convexClient.action.mock.calls,
        ...convexClient.mutation.mock.calls,
      ].some(([name]) => String(name).includes("getCapabilities"));
      expect(probed).toBe(false);
    });
  });

  describe("eval attribution ids on the backend request", () => {
    /** A suite run: its iteration row was pre-created and is found by case. */
    function precreatedSuiteIteration() {
      convexClient.query.mockImplementation(async (name: string) =>
        name === "testSuites:getTestSuiteRunDetails"
          ? {
              iterations: [
                {
                  _id: "iter-suite-1",
                  testCaseId: "case-1",
                  iterationNumber: 1,
                },
              ],
            }
          : { status: "running" },
      );
    }

    it("a suite run's /stream body names the iteration and the run", async () => {
      precreatedSuiteIteration();
      await run(
        { model: SAME_ID, provider: "openrouter", selection: HOSTED },
        { runId: "run-1", orgModelConfigTarget: { projectId: "project-1" } },
      );
      expect(requestTo("/stream")).toMatchObject({
        evalIterationId: "iter-suite-1",
        evalRunId: "run-1",
        modelSelection: HOSTED,
      });
    });

    it("a suite run's /stream/org body names the iteration and the run", async () => {
      precreatedSuiteIteration();
      await run(
        { model: SAME_ID, provider: "openrouter", selection: ORG_OPENROUTER },
        { runId: "run-1", orgModelConfigTarget: { projectId: "project-1" } },
      );
      expect(requestTo("/stream/org")).toMatchObject({
        providerKey: "openrouter",
        evalIterationId: "iter-suite-1",
        evalRunId: "run-1",
        modelSelection: ORG_OPENROUTER,
      });
    });

    it("a legacy suite case still names its iteration and run", async () => {
      precreatedSuiteIteration();
      await run(
        { model: SAME_ID, provider: "openrouter" },
        { runId: "run-1", orgModelConfigTarget: { projectId: "project-1" } },
      );
      const body = requestTo("/stream");
      expect(body).toMatchObject({
        evalIterationId: "iter-suite-1",
        evalRunId: "run-1",
      });
      expect(body).not.toHaveProperty("modelSelection");
    });

    it("a quick run (no suite run) names only its iteration", async () => {
      await run(
        { model: SAME_ID, provider: "openrouter", selection: HOSTED },
        { orgModelConfigTarget: { projectId: "project-1" } },
      );
      const body = requestTo("/stream");
      expect(body).toMatchObject({ evalIterationId: "iter-1" });
      expect(body).not.toHaveProperty("evalRunId");
    });
  });

  describe("saved selection settings reach the provider call", () => {
    /** A suite host config whose default temperature must NOT win. */
    const HOST_DEFAULT = { suiteHostConfig: { temperature: 0.7 } };
    const LOCAL_GPT4O: ModelSelection = {
      modelId: "openai/gpt-4o",
      source: "local",
      connectionRef: { kind: "localProvider", providerKey: "openai" },
      nativeModelId: "gpt-4o",
      settings: { temperature: 0.2 },
      fallback: { provider: "none", model: "none" },
    };
    const LOCAL_GPT5_EFFORT: ModelSelection = {
      modelId: "openai/gpt-5",
      source: "local",
      connectionRef: { kind: "localProvider", providerKey: "openai" },
      nativeModelId: "gpt-5",
      settings: { reasoningEffort: "high" },
      fallback: { provider: "none", model: "none" },
    };
    const localOptions = {
      modelApiKeys: { openai: "sk-local" },
      orgModelConfigTarget: { projectId: "project-1" },
      ...HOST_DEFAULT,
    };
    const streamTextCall = () =>
      streamTextMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;

    it("local: the saved temperature (0.2) reaches streamText, over the host default", async () => {
      await run(
        { model: "openai/gpt-4o", provider: "openai", selection: LOCAL_GPT4O },
        localOptions,
      );
      expect(streamTextMock).toHaveBeenCalledTimes(1);
      expect(streamTextCall()?.temperature).toBe(0.2);
    });

    it("precedence: a per-run override beats the saved selection", async () => {
      await run(
        {
          model: "openai/gpt-4o",
          provider: "openai",
          selection: LOCAL_GPT4O,
          advancedConfig: { temperature: 0.5 },
        },
        localOptions,
      );
      expect(streamTextCall()?.temperature).toBe(0.5);
    });

    it("precedence: the host default applies when the selection sets none", async () => {
      const { settings: _settings, ...noSettings } = LOCAL_GPT4O;
      await run(
        { model: "openai/gpt-4o", provider: "openai", selection: noSettings },
        localOptions,
      );
      expect(streamTextCall()?.temperature).toBe(0.7);
    });

    it("local: a saved reasoning effort becomes provider options, with no temperature", async () => {
      await run(
        {
          model: "openai/gpt-5",
          provider: "openai",
          selection: LOCAL_GPT5_EFFORT,
        },
        localOptions,
      );
      expect(streamTextMock).toHaveBeenCalledTimes(1);
      expect(streamTextCall()?.providerOptions).toEqual({
        openai: { reasoningEffort: "high" },
      });
      expect(streamTextCall()).not.toHaveProperty("temperature");
    });

    it("local: an effort the model has no control for fails the case, it does not run without it", async () => {
      await expectRefused(
        run(
          {
            model: "openai/gpt-4o",
            provider: "openai",
            selection: {
              ...LOCAL_GPT4O,
              settings: { reasoningEffort: "high" },
            },
          },
          localOptions,
        ),
        "capability_missing",
      );
      expect(streamTextMock).not.toHaveBeenCalled();
    });

    it("hosted: the top-level temperature is the saved one, not the host default", async () => {
      const hostedWithTemperature: ModelSelection = {
        ...HOSTED,
        settings: { temperature: 0.2 },
      };
      await run(
        {
          model: SAME_ID,
          provider: "openrouter",
          selection: hostedWithTemperature,
        },
        { orgModelConfigTarget: { projectId: "project-1" }, ...HOST_DEFAULT },
      );
      const body = requestTo("/stream");
      expect(body.temperature).toBe(0.2);
      expect(body.modelSelection).toEqual(hostedWithTemperature);
    });

    it("org cloud: the top-level temperature is the saved one too", async () => {
      const orgWithTemperature: ModelSelection = {
        ...ORG_OPENROUTER,
        settings: { temperature: 0.2 },
      };
      await run(
        {
          model: SAME_ID,
          provider: "openrouter",
          selection: orgWithTemperature,
        },
        { orgModelConfigTarget: { projectId: "project-1" }, ...HOST_DEFAULT },
      );
      const body = requestTo("/stream/org");
      expect(body.temperature).toBe(0.2);
      expect(body.modelSelection).toEqual(orgWithTemperature);
    });

    it("org cloud: a saved reasoning effort is refused (the route cannot apply it)", async () => {
      await expectRefused(
        run(
          {
            model: SAME_ID,
            provider: "openrouter",
            selection: {
              ...ORG_OPENROUTER,
              settings: { reasoningEffort: "low" },
            },
          },
          { orgModelConfigTarget: { projectId: "project-1" } },
        ),
        "capability_missing",
      );
      expect(requestTo("/stream/org")).toBeNull();
    });
  });

  describe("local-runtime org connection: usage and execution record writeback", () => {
    const ORG_OLLAMA_LOCAL: ModelSelection = {
      modelId: "ollama/llama3",
      source: "org",
      connectionRef: { kind: "orgProvider", id: "orgprov_ollama_local_1" },
      nativeModelId: "llama3",
      settings: { temperature: 0.2 },
      fallback: { provider: "none", model: "none" },
    };

    it("admits the prepared toolset before a local eval provider call", async () => {
      preparedToolsOverride.current = {
        search: {
          description: "Search",
          inputSchema: { type: "object", properties: {} },
        },
      };
      const admissions: unknown[] = [];
      fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
        if (url.endsWith("/stream/org/resolve")) {
          const request = JSON.parse(String(init.body));
          if (request.modelWorkload) {
            admissions.push(request.modelWorkload);
            expect(streamTextMock).not.toHaveBeenCalled();
            return Response.json(
              {
                ok: false,
                code: "capability_missing",
                error: "tools unsupported",
              },
              { status: 400 },
            );
          }
          return Response.json({
            ok: true,
            runtimeLocation: "local",
            provider: {
              providerKey: "ollama",
              baseUrl: "http://localhost:11434",
              modelIds: ["llama3"],
            },
          });
        }
        return Response.json({ ok: true });
      });
      await run(
        { model: "llama3", provider: "ollama", selection: ORG_OLLAMA_LOCAL },
        { orgModelConfigTarget: { projectId: "project-local-admission" } },
      );
      expect(admissions).toEqual([
        { purpose: "evalTarget", hasTools: true, hasUserImages: false },
      ]);
      expect(streamTextMock).not.toHaveBeenCalled();
      expect(requestTo("/stream/org/local-usage")).toBeNull();
    });

    it("executes the provider config returned by turn admission after a rotation", async () => {
      admittedFactory.mockClear();
      const fresh = { providerKey: "ollama", apiKey: "new-key", baseUrl: "http://localhost:22434", modelIds: ["llama3"] };
      fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
        if (url.endsWith("/stream/org/resolve")) {
          const request = JSON.parse(String(init.body));
          return Response.json({ ok: true, runtimeLocation: "local", provider: request.modelWorkload ? fresh : { ...fresh, apiKey: "old-key", baseUrl: "http://localhost:11434" } });
        }
        return Response.json({ ok: true });
      });
      await run({ model: "llama3", provider: "ollama", selection: ORG_OLLAMA_LOCAL }, { orgModelConfigTarget: { projectId: "project-local-rotation" } });
      expect(admittedFactory).toHaveBeenCalledWith(fresh, "llama3");
      expect(streamTextMock).toHaveBeenCalledOnce();
      expect((streamTextMock.mock.calls[0][0] as any).model).toEqual({ id: "freshly-admitted-model" });
    });

    it("posts /stream/org/local-usage naming the iteration, with the selection and its record", async () => {
      fetchMock.mockImplementation(async (url: string) =>
        url === "https://example.convex.site/stream/org/resolve"
          ? {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                runtimeLocation: "local",
                provider: {
                  providerKey: "ollama",
                  baseUrl: "http://localhost:11434",
                  modelIds: ["llama3"],
                },
              }),
              text: async () => "",
            }
          : { ok: true, status: 200, text: async () => "" },
      );
      await run(
        { model: "llama3", provider: "ollama", selection: ORG_OLLAMA_LOCAL },
        {
          orgModelConfigTarget: { projectId: "project-local-usage" },
          suiteHostConfig: { temperature: 0.7 },
        },
      );
      // The model ran here, with the saved temperature.
      expect(streamTextMock).toHaveBeenCalledTimes(1);
      expect(
        (streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>)
          .temperature,
      ).toBe(0.2);
      await vi.waitFor(() =>
        expect(requestTo("/stream/org/local-usage")).not.toBeNull(),
      );
      const body = requestTo("/stream/org/local-usage");
      expect(body).toMatchObject({
        projectId: "project-local-usage",
        providerKey: "ollama",
        model: "llama3",
        sourceType: "eval",
        evalIterationId: expect.any(String),
        modelSelection: ORG_OLLAMA_LOCAL,
      });
      expect(body.execution).toEqual({
        requested: ORG_OLLAMA_LOCAL,
        resolved: {
          rail: "local",
          wireModelId: "llama3",
          connectionRef: {
            kind: "orgProvider",
            id: "orgprov_ollama_local_1",
          },
          nativeModelId: "llama3",
          offering: {
            rail: "local",
            providerKey: "ollama",
            nativeModelId: "llama3",
          },
        },
        effectiveSettings: { temperature: 0.2, maxOutputTokens: 0 },
        attempts: [
          {
            rail: "local",
            wireModelId: "llama3",
            outcome: "ok",
            at: expect.any(Number),
          },
        ],
        upstreamModel: "gpt-4o",
      });
    });
  });
});
