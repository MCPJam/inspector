import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { TestTemplateEditor } from "../test-template-editor";
import type { EvalIteration } from "../types";

function renderWithProviders(
  ui: ReactElement,
  { hostStyle = "claude" as const } = {},
) {
  return render(
    <PreferencesStoreProvider
      themeMode="light"
      themePreset="default"
      hostStyle={hostStyle}
    >
      {ui}
    </PreferencesStoreProvider>
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
const mockTraceViewer = vi.hoisted(() => vi.fn());
const getGuestBearerTokenMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue("guest-token")
);
const useAuthMock = vi.hoisted(() => ({
  getAccessToken: vi.fn().mockResolvedValue("token"),
}));
const useConvexAuthMock = vi.hoisted(() => ({
  isAuthenticated: false,
  isLoading: false,
}));
const projectServersMock = vi.hoisted(() => ({
  serversByName: new Map<string, string>(),
  isLoading: false,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => useAuthMock,
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    activeProjectId: "project-1",
    projects: {
      "project-1": {
        id: "project-1",
        name: "Project",
        sharedProjectId: null,
        servers: {},
      },
    },
    servers: {},
  }),
}));

vi.mock("@/hooks/useViews", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useViews")>();
  return {
    ...actual,
    useProjectServers: () => projectServersMock,
  };
});

vi.mock("@/stores/client-config-store", () => ({
  useClientConfigStore: (selector: (state: any) => unknown) =>
    selector({
      isAwaitingRemoteEcho: false,
      pendingProjectId: null,
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

vi.mock("../trace-viewer", () => ({
  TraceViewer: (props: {
    trace?: { messages?: Array<{ content?: unknown }> } | null;
    forcedViewMode?: string;
    isLoading?: boolean;
    expectedToolCalls?: Array<{ toolName: string }>;
  }) => {
    mockTraceViewer(props);
    const firstMessage = props.trace?.messages?.[0]?.content;
    return (
      <div
        data-testid="mock-trace-viewer"
        data-view-mode={props.forcedViewMode ?? "timeline"}
        data-is-loading={String(Boolean(props.isLoading))}
        data-message-count={String(props.trace?.messages?.length ?? 0)}
        data-first-message={
          typeof firstMessage === "string" ? firstMessage : "non-string"
        }
        data-expected-tool-count={String(props.expectedToolCalls?.length ?? 0)}
      />
    );
  },
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
  standardEventProps: () => ({}),
}));

vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: () => getGuestBearerTokenMock(),
}));

vi.mock("@/lib/apis/evals-api", () => ({
  listEvalTools: vi.fn().mockResolvedValue([]),
  runEvalTestCase: vi.fn(),
  streamEvalTestCase: (...args: unknown[]) => streamEvalTestCaseMock(...args),
}));

vi.mock("convex/react", () => ({
  useMutation: (name: unknown) => useMutationMock(name),
  useQuery: (name: unknown, args: unknown) => useQueryMock(name, args),
  useAction: () => vi.fn(),
  useConvexAuth: () => useConvexAuthMock,
}));

describe("TestTemplateEditor run view from route", () => {
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
        })
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
    return card as HTMLElement;
  }

  function getMetricBar(card: HTMLElement, label: "Latency" | "Tokens") {
    const row = within(card)
      .getByText(label)
      .closest("div.flex.items-center.gap-2");
    expect(row).not.toBeNull();
    const bar = row!.querySelector("div[style]");
    expect(bar).not.toBeNull();
    return bar as HTMLElement;
  }

  function getMetricRunningSpinnerCount(container: ParentNode): number {
    return container.querySelectorAll('[data-testid="metric-running-spinner"]')
      .length;
  }

  // Adds the given models to the compare selection via the chat-v2
  // ModelSelector popover that replaced the old "Add model to compare"
  // dropdown. Assumes the lead (pre-selected) model is GPT-4, which the
  // shared `caseDoc` fixture seeds via `models: [{ provider: "openai",
  // model: "gpt-4" }]`.
  async function addCompareModels(
    user: ReturnType<typeof userEvent.setup>,
    modelNames: string[],
  ): Promise<void> {
    await user.click(
      screen.getByRole("button", { name: /^openai logo/i }),
    );
    await user.click(
      await screen.findByRole("switch", { name: /multiple models/i }),
    );
    for (const name of modelNames) {
      await user.click(
        await screen.findByRole("option", {
          name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        }),
      );
    }
    await user.keyboard("{Escape}");
  }

  function getLatestTraceViewerProps() {
    const lastCall = mockTraceViewer.mock.calls.at(-1)?.[0];
    expect(lastCall).toBeDefined();
    return lastCall as {
      trace?: { messages?: Array<{ content?: unknown }> } | null;
      forcedViewMode?: string;
      isLoading?: boolean;
      expectedToolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockTraceViewer.mockReset();
    useMutationMock.mockImplementation((name: string) => {
      if (name === "testSuites:updateTestCase") {
        return updateTestCaseMutationMock;
      }
      return vi.fn();
    });
    getGuestBearerTokenMock.mockResolvedValue("guest-token");
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
      if (name === "hostConfigsV2:getSuiteConfig") {
        // Returning `null` (vs `undefined`) lets the editor build a
        // baseline from `emptyHostConfigInputV2(...)`; `undefined` means
        // "still loading" and would suppress the header row entirely.
        return null;
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
        }) => void
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
      }
    );
  });

  it("opens compare run mode when the route requests run view", async () => {
    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            model: "gpt-4",
            label: "GPT-4",
          } as any,
        ]}
        openCompareFromRoute
      />
    );

    await waitFor(() => {
      expect(screen.queryByText("No compare run yet")).not.toBeInTheDocument();
    });

    expect(useQueryMock).toHaveBeenCalledWith("testSuites:listTestIterations", {
      testCaseId: "case-1",
      limit: 200,
    });
    expect(
      screen.getByRole("button", { name: /retry all/i })
    ).toBeInTheDocument();
  });

  it("shows a loading spinner instead of config UI while route-open compare data is unresolved", async () => {
    let queriesReady = false;
    useQueryMock.mockImplementation((name: string, args: unknown) => {
      if (!queriesReady) {
        if (name === "testSuites:listTestCases") {
          return undefined;
        }
        if (name === "testSuites:getTestSuite") {
          return {
            _id: "suite-1",
            environment: { servers: ["srv"] },
          };
        }
        return undefined;
      }

      if (name === "testSuites:listTestCases") {
        return [caseDoc];
      }
      if (name === "testSuites:getTestSuite") {
        return {
          _id: "suite-1",
          environment: { servers: ["srv"] },
        };
      }
      if (name === "hostConfigsV2:getSuiteConfig") {
        return null;
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

    const view = renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            model: "gpt-4",
            label: "GPT-4",
          } as any,
        ]}
        openCompareFromRoute
      />
    );

    expect(screen.getByText("Loading results...")).toBeInTheDocument();
    expect(screen.queryByText("User prompt")).not.toBeInTheDocument();

    queriesReady = true;
    view.rerender(
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        <TestTemplateEditor
          suiteId="suite-1"
          selectedTestCaseId="case-1"
          connectedServerNames={new Set(["srv"])}
          projectId={null}
          availableModels={[
            {
              provider: "openai",
              model: "gpt-4",
              label: "GPT-4",
            } as any,
          ]}
          openCompareFromRoute
        />
      </PreferencesStoreProvider>
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /retry all/i })
      ).toBeInTheDocument();
    });
  });

  it("prefers the explicitly selected iteration over newer historical compare data", async () => {
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
      if (name === "hostConfigsV2:getSuiteConfig") {
        return null;
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
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            model: "gpt-4",
            label: "GPT-4",
          } as any,
        ]}
        openCompareFromRoute
        openCompareIterationId={clickedIteration._id}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("eval-trace-surface")).toHaveTextContent(
        clickedIteration._id
      );
    });
  });

  it("renders flat User prompt / Tool triggered for a single-turn case", async () => {
    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            model: "gpt-4",
            label: "GPT-4",
          } as any,
        ]}
        onExportDraft={vi.fn()}
      />
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
        projectId={null}
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
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    await addCompareModels(user, ["Claude 4.5 Sonnet", "Gemini 2.5 Pro"]);

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
      ([request]) => (request as { compareRunId?: string }).compareRunId
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

  it("persists unsaved test case draft fields before starting a compare run", async () => {
    const user = userEvent.setup();
    const draftCase = {
      ...caseDoc,
      title: "Untitled test case",
      query: "",
      isNegativeTest: false,
      promptTurns: undefined,
      expectedToolCalls: [],
      lastMessageRun: undefined,
    };

    useQueryMock.mockImplementation((name: string, args: unknown) => {
      if (name === "testSuites:listTestCases") return [draftCase];
      if (name === "testSuites:getTestSuite") {
        return { _id: "suite-1", environment: { servers: ["srv"] } };
      }
      if (name === "testSuites:listTestIterations" && args !== "skip") {
        return [];
      }
      return undefined;
    });

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            id: "gpt-4",
            model: "gpt-4",
            name: "GPT-4",
            label: "GPT-4",
          } as any,
        ]}
      />,
    );

    await user.type(
      await screen.findByPlaceholderText("Enter the user prompt…"),
      "Find the latest incidents",
    );
    await user.click(
      screen.getByRole("button", { name: "Untitled test case" }),
    );
    const titleInput = screen.getByDisplayValue("Untitled test case");
    await user.clear(titleInput);
    await user.type(titleInput, "Named draft case");
    await user.keyboard("{Enter}");

    await user.click(screen.getByRole("button", { name: /^run$/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(1);
    });

    expect(updateTestCaseMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        testCaseId: "case-1",
        title: "Named draft case",
        query: "Find the latest incidents",
        runs: 1,
        expectedToolCalls: [],
        isNegativeTest: true,
        promptTurns: [
          expect.objectContaining({
            id: "turn-1",
            prompt: "Find the latest incidents",
            expectedToolCalls: [],
          }),
        ],
      }),
    );
    expect(updateTestCaseMutationMock.mock.invocationCallOrder[0]).toBeLessThan(
      streamEvalTestCaseMock.mock.invocationCallOrder[0],
    );
  });

  it("renders an immediate chat preview instead of the generic spinner before the first stream event", async () => {
    const user = userEvent.setup();

    streamEvalTestCaseMock.mockImplementation(
      async () => new Promise<void>(() => {}),
    );

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            id: "gpt-4",
            model: "gpt-4",
            name: "GPT-4",
            label: "GPT-4",
          } as any,
        ]}
      />,
      { hostStyle: "claude" },
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /run$/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("mock-trace-viewer")).toBeInTheDocument();
    });

    expect(screen.getByTestId("mock-trace-viewer")).toHaveAttribute(
      "data-view-mode",
      "chat",
    );
    expect(screen.getByTestId("mock-trace-viewer")).toHaveAttribute(
      "data-is-loading",
      "true",
    );
    expect(screen.getByTestId("mock-trace-viewer")).toHaveAttribute(
      "data-message-count",
      "1",
    );
    expect(screen.getByTestId("mock-trace-viewer")).toHaveAttribute(
      "data-first-message",
      "Q",
    );
    expect(screen.queryByText("Running GPT-4…")).not.toBeInTheDocument();
  });

  it("renders a tools preview (not generic spinner) before the first stream event when the case has expected tool calls", async () => {
    const user = userEvent.setup();
    const caseWithTools = {
      ...caseDoc,
      isNegativeTest: false,
      expectedToolCalls: [{ toolName: "create_view", arguments: {} }],
    };

    useQueryMock.mockImplementation((name: string, args: unknown) => {
      if (name === "testSuites:listTestCases") return [caseWithTools];
      if (name === "testSuites:getTestSuite") {
        return { _id: "suite-1", environment: { servers: ["srv"] } };
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

    // Stream never resolves — keeps the run in "running, no iteration" state.
    streamEvalTestCaseMock.mockImplementation(
      async () => new Promise<void>(() => {}),
    );

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            id: "gpt-4",
            model: "gpt-4",
            name: "GPT-4",
            label: "GPT-4",
          } as any,
        ]}
      />,
      { hostStyle: "claude" },
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /run$/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("mock-trace-viewer")).toBeInTheDocument();
    });

    // Must show tools view (not chat) and pass expected tool calls through.
    expect(screen.getByTestId("mock-trace-viewer")).toHaveAttribute(
      "data-view-mode",
      "tools",
    );
    expect(screen.getByTestId("mock-trace-viewer")).toHaveAttribute(
      "data-is-loading",
      "true",
    );
    expect(screen.getByTestId("mock-trace-viewer")).toHaveAttribute(
      "data-expected-tool-count",
      "1",
    );
    // Generic spinner must not appear.
    expect(screen.queryByText(/Running GPT-4/)).not.toBeInTheDocument();
  });

  it("replaces the initial preview with streamed chat messages as soon as live trace data exists", async () => {
    const user = userEvent.setup();
    let emitEvent:
      | ((
          event:
            | { type: "turn_start"; turnIndex: number; prompt: string }
            | { type: "text_delta"; content: string },
        ) => void)
      | null = null;

    streamEvalTestCaseMock.mockImplementation(
      async (
        _request: unknown,
        onEvent: (
          event:
            | { type: "turn_start"; turnIndex: number; prompt: string }
            | { type: "text_delta"; content: string },
        ) => void,
      ) => {
        emitEvent = onEvent;
        return new Promise<void>(() => {});
      },
    );

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            id: "gpt-4",
            model: "gpt-4",
            name: "GPT-4",
            label: "GPT-4",
          } as any,
        ]}
      />,
      { hostStyle: "claude" },
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /run$/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(1);
      expect(getLatestTraceViewerProps().trace?.messages?.[0]?.content).toBe(
        "Q",
      );
    });

    act(() => {
      emitEvent?.({
        type: "turn_start",
        turnIndex: 0,
        prompt: "Streamed prompt",
      });
    });

    await waitFor(() => {
      const props = getLatestTraceViewerProps();
      expect(props.isLoading).toBe(true);
      expect(props.trace?.messages).toHaveLength(1);
      expect(props.trace?.messages?.[0]?.content).toBe("Streamed prompt");
    });
  });

  it("renders the host-style control below models and before the scenario form", async () => {
    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            id: "gpt-4",
            model: "gpt-4",
            name: "GPT-4",
            label: "GPT-4",
          } as any,
        ]}
      />,
      { hostStyle: "claude" },
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    const modelBar = screen.getByTestId("test-template-model-bar");
    const hostHeaderRow = screen.getByTestId("test-template-host-header-row");
    const scenarioHeading = screen.getByText("Test scenario");

    expect(
      modelBar.compareDocumentPosition(hostHeaderRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      hostHeaderRow.compareDocumentPosition(scenarioHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    // The new TestCaseHostHeader sources its baseline from suite
    // hostConfigsV2 — the mock returns null → seeded empty input →
    // `DEFAULT_HOST_STYLE_V2` ("mcpjam"). The `renderWithProviders`
    // `hostStyle: "claude"` only seeds the GLOBAL preferences store,
    // which the new header intentionally no longer reads (per-case
    // tweaks must not leak across views).
    expect(
      within(hostHeaderRow).getByTestId("test-case-host-style-mcpjam"),
    ).toHaveAttribute("data-selected", "true");
  });

  it("treats host-style pill clicks as per-case tweaks that don't leak to other surfaces", async () => {
    // Replaces the prior "carries it across compare columns" test. The
    // old test locked in cross-view leak behavior: clicking a host pill
    // in the test case editor mutated `usePreferencesStore.hostStyle`,
    // which downstream surfaces (CompareResultColumn, playground, chat
    // UI) all read. The new TestCaseHostHeader writes to a per-case
    // local override; the global preference store is untouched. A
    // follow-up will plumb the override into the iteration snapshot so
    // result cards can read it from there.
    const user = userEvent.setup();

    streamEvalTestCaseMock.mockImplementation(
      async () => new Promise<void>(() => {}),
    );

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            id: "gpt-4",
            model: "gpt-4",
            name: "GPT-4",
            label: "GPT-4",
          } as any,
        ]}
      />,
      { hostStyle: "claude" },
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    const hostHeaderRow = screen.getByTestId("test-template-host-header-row");

    // Baseline starts on the v2 default ("mcpjam") — the suite hostConfig
    // mock returns null, so emptyHostConfigInputV2 wins. No "Tweaked"
    // badge until the user makes a tweak.
    expect(
      within(hostHeaderRow).getByTestId("test-case-host-style-mcpjam"),
    ).toHaveAttribute("data-selected", "true");
    expect(
      screen.queryByTestId("test-case-host-tweaked-badge"),
    ).not.toBeInTheDocument();

    await user.click(
      within(hostHeaderRow).getByTestId("test-case-host-style-chatgpt"),
    );

    // The tweak applies locally and surfaces the Tweaked badge.
    await waitFor(() => {
      expect(
        within(hostHeaderRow).getByTestId("test-case-host-style-chatgpt"),
      ).toHaveAttribute("data-selected", "true");
    });
    expect(
      screen.getByTestId("test-case-host-tweaked-badge"),
    ).toBeInTheDocument();
  });

  it("defaults to Results tab when expected tool calls are on a non-first prompt turn (multi-turn case)", async () => {
    const user = userEvent.setup();
    // Multi-turn case: turn 1 has no expected tool calls, turn 2 has one.
    const multiTurnCase = {
      ...caseDoc,
      isNegativeTest: false,
      expectedToolCalls: [],
      promptTurns: [
        {
          id: "turn-1",
          prompt: "First prompt",
          expectedToolCalls: [],
        },
        {
          id: "turn-2",
          prompt: "Second prompt",
          expectedToolCalls: [{ toolName: "some_tool", arguments: {} }],
        },
      ],
    };

    useQueryMock.mockImplementation((name: string, args: unknown) => {
      if (name === "testSuites:listTestCases") {
        return [multiTurnCase];
      }
      if (name === "testSuites:getTestSuite") {
        return {
          _id: "suite-1",
          environment: { servers: ["srv"] },
        };
      }
      if (name === "hostConfigsV2:getSuiteConfig") {
        return null;
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
    streamEvalTestCaseMock.mockImplementation(
      async () => new Promise<void>(() => {}),
    );

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            id: "gpt-4",
            model: "gpt-4",
            name: "GPT-4",
            label: "GPT-4",
          } as any,
        ]}
      />,
      { hostStyle: "claude" },
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /run$/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(1);
    });

    // The pre-stream preview TraceViewer must be rendered in tools mode with
    // the expected tool call flattened from turn 2.
    await waitFor(() => {
      const props = getLatestTraceViewerProps();
      expect(props.forcedViewMode).toBe("tools");
      expect(props.expectedToolCalls).toEqual([
        { toolName: "some_tool", arguments: {} },
      ]);
    });
  });

  it("removes the pre-run host-style selector and only applies the host shell on Chat", async () => {
    const user = userEvent.setup();
    const caseWithExpectedToolCalls = {
      ...caseDoc,
      isNegativeTest: false,
      expectedToolCalls: [
        {
          toolName: "create_view",
          arguments: { shape: "box" },
        },
      ],
    };

    useQueryMock.mockImplementation((name: string, args: unknown) => {
      if (name === "testSuites:listTestCases") {
        return [caseWithExpectedToolCalls];
      }
      if (name === "testSuites:getTestSuite") {
        return {
          _id: "suite-1",
          environment: { servers: ["srv"] },
        };
      }
      if (name === "hostConfigsV2:getSuiteConfig") {
        // Stamp the suite hostConfig with `hostStyle: "claude"` so the
        // result-column baseline matches what this test asserts about
        // the chat shell. Result column priority is
        // snapshot.hostConfigOverride → baseline → global preference;
        // before this hostConfig-aware path landed, the global
        // preference was the source.
        return {
          id: "hostconfig-1",
          schemaVersion: 1,
          hostStyle: "claude",
          modelId: "",
          systemPrompt: "",
          temperature: 0.7,
          requireToolApproval: false,
          serverIds: [],
          optionalServerIds: [],
          connectionDefaults: { headers: {}, requestTimeout: 10000 },
          clientCapabilities: {},
          hostContext: {},
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
    streamEvalTestCaseMock.mockImplementation(
      async () => new Promise<void>(() => {}),
    );

    const view = renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            id: "gpt-4",
            model: "gpt-4",
            name: "GPT-4",
            label: "GPT-4",
          } as any,
        ]}
      />,
      { hostStyle: "claude" },
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    expect(
      screen.getByTestId("test-template-host-header-row"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /run$/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(1);
    });

    // The header lives in the config view only; flipping to the run /
    // compare view removes it. No `[data-selected]` host-style markers
    // should remain in the result tree.
    expect(
      screen.queryByTestId("test-template-host-header-row"),
    ).not.toBeInTheDocument();
    expect(
      view.container.querySelector('[data-testid^="test-case-host-style-"]'),
    ).toBeNull();

    const card = getCompareCard("GPT-4");

    // Default tab is Results when the case has expected tools, so the chat host shell
    // should only appear after switching back to Chat.
    expect(card.querySelector("[data-host-style]")).toBeNull();

    await user.click(within(card).getByRole("button", { name: /^Chat$/i }));
    expect(card.querySelector('[data-host-style="claude"]')).not.toBeNull();

    await user.click(within(card).getByRole("button", { name: /^Trace$/i }));
    expect(card.querySelector("[data-host-style]")).toBeNull();

    await user.click(within(card).getByRole("button", { name: /^Chat$/i }));
    expect(card.querySelector('[data-host-style="claude"]')).not.toBeNull();

    await user.click(within(card).getByRole("button", { name: /^Raw$/i }));
    expect(card.querySelector("[data-host-style]")).toBeNull();

    await user.click(within(card).getByRole("button", { name: /^Results$/i }));
    expect(card.querySelector("[data-host-style]")).toBeNull();
  });

  it("renders running spinners in the eval compare metric bars", async () => {
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
        }) => void
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
      }
    );

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
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
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    await addCompareModels(user, ["Claude 4.5 Sonnet", "Gemini 2.5 Pro"]);

    await user.click(screen.getByRole("button", { name: /run compare/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(3);
    });

    const runningCard = getCompareCard("Gemini 2.5 Pro");
    expect(getMetricRunningSpinnerCount(runningCard)).toBe(2);
    expect(within(runningCard).getByLabelText("Running")).toBeInTheDocument();

    finalModelDeferred.resolve();

    await waitFor(() => {
      expect(getMetricRunningSpinnerCount(runningCard)).toBe(0);
      expect(within(runningCard).getByLabelText("Passed")).toBeInTheDocument();
    });
  });

  it("removes the eval compare metric bar spinners after a running record completes", async () => {
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
        }) => void
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
      }
    );

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
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
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    await addCompareModels(user, ["Claude 4.5 Sonnet", "Gemini 2.5 Pro"]);

    await user.click(screen.getByRole("button", { name: /run compare/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(3);
    });

    const compareCard = getCompareCard("Gemini 2.5 Pro");
    expect(getMetricRunningSpinnerCount(compareCard)).toBe(2);
    expect(within(compareCard).getByLabelText("Running")).toBeInTheDocument();

    finalModelDeferred.resolve();

    await waitFor(() => {
      expect(getMetricRunningSpinnerCount(compareCard)).toBe(0);
      expect(
        within(compareCard).queryByLabelText("Running")
      ).not.toBeInTheDocument();
      expect(within(compareCard).getByLabelText("Passed")).toBeInTheDocument();
    });
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
        }) => void
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
      }
    );

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
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
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    await addCompareModels(user, ["Claude 4.5 Sonnet", "Gemini 2.5 Pro"]);

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
        }) => void
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
      }
    );

    renderWithProviders(
      <TestTemplateEditor
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv"])}
        projectId={null}
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
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    await addCompareModels(user, ["Claude 4.5 Sonnet", "Gemini 2.5 Pro"]);

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
        "text-emerald-700"
      );
    });

    expect(getMetricBar(openAiCard, "Latency")).toHaveStyle({ width: "50%" });
    expect(getMetricBar(openAiCard, "Tokens")).toHaveStyle({ width: "50%" });
  });
});
