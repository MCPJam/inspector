import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { TestTemplateEditor } from "../test-template-editor";
import type { EvalIteration } from "../types";

function renderWithProviders(ui: ReactElement) {
  return render(
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      {ui}
    </PreferencesStoreProvider>,
  );
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const useMutationMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const useQueryMock = vi.hoisted(() => vi.fn());
const updateTestCaseMutationMock = vi.hoisted(() => vi.fn());
const streamEvalTestCaseMock = vi.hoisted(() => vi.fn());
const useAuthMock = vi.hoisted(() => ({
  getAccessToken: vi.fn().mockResolvedValue("token"),
}));
const useConvexAuthMock = vi.hoisted(() => ({
  isAuthenticated: false,
  isLoading: false,
}));
const workspaceServersMock = vi.hoisted(() => ({
  serversByName: new Map<string, string>(),
  isLoading: false,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => useAuthMock,
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    activeWorkspaceId: "workspace-1",
    workspaces: {
      "workspace-1": {
        id: "workspace-1",
        name: "Workspace",
        sharedWorkspaceId: null,
        servers: {},
      },
    },
    servers: {},
  }),
}));

vi.mock("@/hooks/useViews", () => ({
  useWorkspaceServers: () => workspaceServersMock,
}));

vi.mock("@/stores/client-config-store", () => ({
  useClientConfigStore: (selector: (state: any) => unknown) =>
    selector({
      isAwaitingRemoteEcho: false,
      pendingWorkspaceId: null,
    }),
}));

vi.mock("../compare-run-chat-surface", () => ({
  CompareRunChatSurface: ({ iteration }: { iteration?: { _id?: string } }) => (
    <div data-testid="compare-run-chat-surface">{iteration?._id ?? "none"}</div>
  ),
}));

vi.mock("../eval-trace-surface", () => ({
  EvalTraceSurface: ({ iteration }: { iteration?: { _id?: string } }) => (
    <div data-testid="eval-trace-surface">{iteration?._id ?? "none"}</div>
  ),
}));

vi.mock("@/hooks/use-ai-provider-keys", () => ({
  useAiProviderKeys: () => ({
    getToken: vi.fn().mockResolvedValue("key"),
    hasToken: vi.fn().mockReturnValue(true),
    getOpenRouterSelectedModels: vi.fn(() => []),
    getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
    getAzureBaseUrl: vi.fn(() => ""),
  }),
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: () => "test",
  detectPlatform: () => "web",
}));

vi.mock("@/lib/apis/evals-api", () => ({
  listEvalTools: vi.fn().mockResolvedValue([]),
  runEvalTestCase: vi.fn(),
  streamEvalTestCase: (...args: unknown[]) => streamEvalTestCaseMock(...args),
}));

vi.mock("convex/react", () => ({
  useMutation: (_name: unknown) => useMutationMock(),
  useQuery: (name: unknown, args: unknown) => useQueryMock(name, args),
  useAction: () => vi.fn(),
  useConvexAuth: () => useConvexAuthMock,
}));

describe("TestTemplateEditor openCompareFromRoute", () => {
  const baseIteration: EvalIteration = {
    _id: "iter-1",
    testCaseId: "case-1",
    createdBy: "u1",
    createdAt: Date.now() - 10_000,
    updatedAt: Date.now() - 1_000,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    resultSource: "reported",
    actualToolCalls: [],
    tokensUsed: 10,
    testCaseSnapshot: {
      title: "T",
      query: "Q",
      provider: "openai",
      model: "gpt-4",
      expectedToolCalls: [],
    },
    suiteRunId: "run-1",
  };

  const caseDoc = {
    _id: "case-1",
    testSuiteId: "suite-1",
    title: "T",
    query: "Q",
    models: [{ provider: "openai", model: "gpt-4" }],
    runs: 1,
    expectedToolCalls: [],
    runsConfig: [],
    advancedConfig: {},
    isNegativeTest: true,
    lastMessageRun: baseIteration._id,
  };

  function makeCompletedIteration(params: {
    id: string;
    provider: string;
    model: string;
    durationMs: number;
    tokensUsed: number;
    toolCallCount: number;
    compareRunId?: string;
    status?: EvalIteration["status"];
    result?: EvalIteration["result"];
  }): EvalIteration {
    const startedAt = 10_000;

    return {
      ...baseIteration,
      _id: params.id,
      createdAt: startedAt,
      startedAt,
      updatedAt: startedAt + params.durationMs,
      status: params.status ?? "completed",
      result: params.result ?? "passed",
      suiteRunId: undefined,
      actualToolCalls: Array.from(
        { length: params.toolCallCount },
        (_value, index) => ({
          toolName: `tool-${index + 1}`,
          arguments: { index: index + 1 },
        }),
      ),
      tokensUsed: params.tokensUsed,
      metadata: params.compareRunId
        ? { compareRunId: params.compareRunId }
        : undefined,
      testCaseSnapshot: {
        ...baseIteration.testCaseSnapshot!,
        provider: params.provider,
        model: params.model,
      },
    };
  }

  function getCompareCard(modelLabel: string): HTMLElement {
    const card = screen
      .getByText(modelLabel, { selector: "div" })
      .closest(".rounded-2xl");
    expect(card).not.toBeNull();
    return card!;
  }

  function getMetricBar(card: HTMLElement, label: "Latency" | "Tokens") {
    const row = within(card).getByText(label).parentElement;
    expect(row).not.toBeNull();
    const bar = row!.querySelector("div[style]");
    expect(bar).not.toBeNull();
    return bar as HTMLElement;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useMutationMock.mockReturnValue(updateTestCaseMutationMock);
    useQueryMock.mockImplementation((name: string, args: unknown) => {
      if (name === "testSuites:listTestCases") {
        return [caseDoc];
      }
      if (name === "testSuites:getTestSuite") {
        return {
          _id: "suite-1",
          environment: { servers: ["srv"] },
        };
      }
      if (name === "testSuites:listTestIterations" && args !== "skip") {
        return [baseIteration];
      }
      if (
        name === "testSuites:getTestIteration" &&
        typeof args === "object" &&
        args !== null &&
        (args as { iterationId?: string }).iterationId === baseIteration._id
      ) {
        return baseIteration;
      }
      return undefined;
    });
    updateTestCaseMutationMock.mockResolvedValue(undefined);
    streamEvalTestCaseMock.mockImplementation(
      async (
        request: {
          model: string;
          provider: string;
          compareRunId?: string;
        },
        onEvent: (event: {
          type: "complete";
          iterationId: string;
          iteration: EvalIteration;
        }) => void,
      ) => {
        const iterationId = `iter-${request.provider}-${request.model}`;
        onEvent({
          type: "complete",
          iterationId,
          iteration: {
            ...baseIteration,
            _id: iterationId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            startedAt: Date.now(),
            suiteRunId: undefined,
            metadata: request.compareRunId
              ? { compareRunId: request.compareRunId }
              : undefined,
            testCaseSnapshot: {
              ...baseIteration.testCaseSnapshot!,
              provider: request.provider,
              model: request.model,
            },
          },
        });
      },
    );
  });

  it("opens compare run mode and clears route when openCompareFromRoute is set", async () => {
    const onClearOpenCompareRoute = vi.fn();

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        workspaceId={null}
        availableModels={[
          {
            provider: "openai",
            model: "gpt-4",
            label: "GPT-4",
          } as any,
        ]}
        openCompareFromRoute
        onClearOpenCompareRoute={onClearOpenCompareRoute}
      />,
    );

    await waitFor(() => {
      expect(onClearOpenCompareRoute).toHaveBeenCalled();
      expect(screen.queryByText("No compare run yet")).not.toBeInTheDocument();
    });

    expect(useQueryMock).toHaveBeenCalledWith("testSuites:listTestIterations", {
      testCaseId: "case-1",
      limit: 200,
    });
    expect(
      screen.getByRole("button", { name: /retry all/i }),
    ).toBeInTheDocument();
  });

  it("prefers the explicitly selected iteration over newer historical compare data", async () => {
    const onClearOpenCompareRoute = vi.fn();
    const clickedIteration: EvalIteration = {
      ...baseIteration,
      _id: "iter-clicked",
      suiteRunId: "run-clicked",
      result: "failed",
      updatedAt: Date.now() - 2_000,
    };
    const newerQuickIteration: EvalIteration = {
      ...baseIteration,
      _id: "iter-newer-quick",
      suiteRunId: undefined,
      updatedAt: Date.now() - 500,
      metadata: { compareRunId: "cmp-newer" },
    };

    useQueryMock.mockImplementation((name: string, args: unknown) => {
      if (name === "testSuites:listTestCases") {
        return [{ ...caseDoc, lastMessageRun: clickedIteration._id }];
      }
      if (name === "testSuites:getTestSuite") {
        return {
          _id: "suite-1",
          environment: { servers: ["srv"] },
        };
      }
      if (name === "testSuites:listTestIterations" && args !== "skip") {
        return [newerQuickIteration, clickedIteration];
      }
      if (
        name === "testSuites:getTestIteration" &&
        typeof args === "object" &&
        args !== null
      ) {
        const iterationId = (args as { iterationId?: string }).iterationId;
        if (iterationId === clickedIteration._id) {
          return clickedIteration;
        }
      }
      return undefined;
    });

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        workspaceId={null}
        availableModels={[
          {
            provider: "openai",
            model: "gpt-4",
            label: "GPT-4",
          } as any,
        ]}
        openCompareFromRoute
        openCompareIterationId={clickedIteration._id}
        onClearOpenCompareRoute={onClearOpenCompareRoute}
      />,
    );

    await waitFor(() => {
      expect(onClearOpenCompareRoute).toHaveBeenCalled();
      expect(screen.getByTestId("eval-trace-surface")).toHaveTextContent(
        clickedIteration._id,
      );
    });
  });

  it("renders flat User prompt / Tool triggered for a single-turn case", async () => {
    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        workspaceId={null}
        availableModels={[
          {
            provider: "openai",
            model: "gpt-4",
            label: "GPT-4",
          } as any,
        ]}
        onExportDraft={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("User prompt")).toBeInTheDocument();
    });

    expect(screen.getByText("Tool triggered")).toBeInTheDocument();
    expect(screen.queryByText("Prompt steps")).not.toBeInTheDocument();
  });

  it("autosaves compare models on run and reuses the compare session id for per-model retry", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        workspaceId={null}
        availableModels={[
          {
            provider: "openai",
            id: "gpt-4",
            model: "gpt-4",
            name: "GPT-4",
            label: "GPT-4",
          } as any,
          {
            provider: "anthropic",
            id: "claude-4.5-sonnet",
            model: "claude-4.5-sonnet",
            name: "Claude 4.5 Sonnet",
            label: "Claude 4.5 Sonnet",
          } as any,
          {
            provider: "google",
            id: "gemini-2.5-pro",
            model: "gemini-2.5-pro",
            name: "Gemini 2.5 Pro",
            label: "Gemini 2.5 Pro",
          } as any,
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /add model to compare/i }),
    );
    await user.click(screen.getByText("Claude 4.5 Sonnet"));
    await user.click(
      screen.getByRole("button", { name: /add model to compare/i }),
    );
    await user.click(screen.getByText("Gemini 2.5 Pro"));

    await user.click(screen.getByRole("button", { name: /run compare/i }));

    await waitFor(() => {
      expect(updateTestCaseMutationMock).toHaveBeenCalledWith({
        testCaseId: "case-1",
        models: [
          { provider: "openai", model: "gpt-4" },
          { provider: "anthropic", model: "claude-4.5-sonnet" },
          { provider: "google", model: "gemini-2.5-pro" },
        ],
      });
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(3);
    });

    const initialCompareRunIds = streamEvalTestCaseMock.mock.calls.map(
      ([request]) => (request as { compareRunId?: string }).compareRunId,
    );
    expect(new Set(initialCompareRunIds).size).toBe(1);
    expect(initialCompareRunIds[0]).toMatch(/^cmp_/);

    await user.click(screen.getAllByRole("button", { name: /^retry$/i })[0]!);

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(4);
    });

    const retryRequest = streamEvalTestCaseMock.mock.calls[3]?.[0] as {
      compareRunId?: string;
      model: string;
      provider: string;
    };

    expect(retryRequest.compareRunId).toBe(initialCompareRunIds[0]);
    expect(retryRequest.provider).toBe("openai");
    expect(retryRequest.model).toBe("gpt-4");
    expect(updateTestCaseMutationMock).toHaveBeenCalledTimes(1);
  });

  it("keeps eval compare winner accents neutral until all models finish running", async () => {
    const user = userEvent.setup();
    const finalModelDeferred = createDeferred();

    streamEvalTestCaseMock.mockImplementation(
      async (
        request: {
          model: string;
          provider: string;
          compareRunId?: string;
        },
        onEvent: (event: {
          type: "complete";
          iterationId: string;
          iteration: EvalIteration;
        }) => void,
      ) => {
        const complete = (params: {
          id: string;
          durationMs: number;
          tokensUsed: number;
          toolCallCount: number;
        }) => {
          const iteration = makeCompletedIteration({
            ...params,
            provider: request.provider,
            model: request.model,
            compareRunId: request.compareRunId,
          });
          onEvent({
            type: "complete",
            iterationId: iteration._id,
            iteration,
          });
        };

        if (request.provider === "openai") {
          complete({
            id: "iter-openai",
            durationMs: 1100,
            tokensUsed: 111,
            toolCallCount: 1,
          });
          return;
        }

        if (request.provider === "anthropic") {
          complete({
            id: "iter-anthropic",
            durationMs: 2200,
            tokensUsed: 222,
            toolCallCount: 2,
          });
          return;
        }

        await finalModelDeferred.promise;
        complete({
          id: "iter-google",
          durationMs: 1500,
          tokensUsed: 333,
          toolCallCount: 3,
        });
      },
    );

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        workspaceId={null}
        availableModels={[
          {
            provider: "openai",
            id: "gpt-4",
            model: "gpt-4",
            name: "GPT-4",
            label: "GPT-4",
          } as any,
          {
            provider: "anthropic",
            id: "claude-4.5-sonnet",
            model: "claude-4.5-sonnet",
            name: "Claude 4.5 Sonnet",
            label: "Claude 4.5 Sonnet",
          } as any,
          {
            provider: "google",
            id: "gemini-2.5-pro",
            model: "gemini-2.5-pro",
            name: "Gemini 2.5 Pro",
            label: "Gemini 2.5 Pro",
          } as any,
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /add model to compare/i }),
    );
    await user.click(screen.getByText("Claude 4.5 Sonnet"));
    await user.click(
      screen.getByRole("button", { name: /add model to compare/i }),
    );
    await user.click(screen.getByText("Gemini 2.5 Pro"));

    await user.click(screen.getByRole("button", { name: /run compare/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(3);
      expect(screen.getByText("1.1s")).toBeInTheDocument();
      expect(screen.getByText("111")).toBeInTheDocument();
      expect(screen.getByText("1 tool call")).toBeInTheDocument();
    });

    expect(screen.getByText("1.1s")).toHaveClass("text-foreground");
    expect(screen.getByText("111")).toHaveClass("text-foreground");
    expect(screen.getByText("1 tool call")).toHaveClass("text-foreground");

    finalModelDeferred.resolve();

    await waitFor(() => {
      expect(screen.getByText("1.5s")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("1.1s")).toHaveClass("text-emerald-700");
      expect(screen.getByText("111")).toHaveClass("text-emerald-700");
      expect(screen.getByText("1 tool call")).toHaveClass("text-emerald-700");
    });
  });

  it("excludes failed eval rows from winners and comparison bar scaling", async () => {
    const user = userEvent.setup();

    streamEvalTestCaseMock.mockImplementation(
      async (
        request: {
          model: string;
          provider: string;
          compareRunId?: string;
        },
        onEvent: (event: {
          type: "complete";
          iterationId: string;
          iteration: EvalIteration;
        }) => void,
      ) => {
        const complete = (params: {
          id: string;
          durationMs: number;
          tokensUsed: number;
          toolCallCount: number;
          status?: EvalIteration["status"];
          result?: EvalIteration["result"];
        }) => {
          const iteration = makeCompletedIteration({
            ...params,
            provider: request.provider,
            model: request.model,
            compareRunId: request.compareRunId,
          });
          onEvent({
            type: "complete",
            iterationId: iteration._id,
            iteration,
          });
        };

        if (request.provider === "openai") {
          complete({
            id: "iter-openai",
            durationMs: 1100,
            tokensUsed: 100,
            toolCallCount: 2,
          });
          return;
        }

        if (request.provider === "anthropic") {
          complete({
            id: "iter-anthropic",
            durationMs: 2200,
            tokensUsed: 200,
            toolCallCount: 4,
          });
          return;
        }

        complete({
          id: "iter-google-failed",
          durationMs: 9000,
          tokensUsed: 900,
          toolCallCount: 1,
          result: "failed",
        });
      },
    );

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        workspaceId={null}
        availableModels={[
          {
            provider: "openai",
            id: "gpt-4",
            model: "gpt-4",
            name: "GPT-4",
            label: "GPT-4",
          } as any,
          {
            provider: "anthropic",
            id: "claude-4.5-sonnet",
            model: "claude-4.5-sonnet",
            name: "Claude 4.5 Sonnet",
            label: "Claude 4.5 Sonnet",
          } as any,
          {
            provider: "google",
            id: "gemini-2.5-pro",
            model: "gemini-2.5-pro",
            name: "Gemini 2.5 Pro",
            label: "Gemini 2.5 Pro",
          } as any,
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /add model to compare/i }),
    );
    await user.click(screen.getByText("Claude 4.5 Sonnet"));
    await user.click(
      screen.getByRole("button", { name: /add model to compare/i }),
    );
    await user.click(screen.getByText("Gemini 2.5 Pro"));

    await user.click(screen.getByRole("button", { name: /run compare/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(3);
      expect(screen.getByText("9s")).toBeInTheDocument();
    });

    const openAiCard = getCompareCard("GPT-4");
    const openAiScope = within(openAiCard);

    await waitFor(() => {
      expect(openAiScope.getByText("1.1s")).toHaveClass("text-emerald-700");
      expect(openAiScope.getByText("100")).toHaveClass("text-emerald-700");
      expect(openAiScope.getByText("2 tool calls")).toHaveClass(
        "text-emerald-700",
      );
    });

    expect(getMetricBar(openAiCard, "Latency")).toHaveStyle({ width: "50%" });
    expect(getMetricBar(openAiCard, "Tokens")).toHaveStyle({ width: "50%" });
  });
});
