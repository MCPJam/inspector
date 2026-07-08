import { useState, type ReactElement } from "react";
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
const runEvalTestCaseMock = vi.hoisted(() => vi.fn());
const mockTraceViewer = vi.hoisted(() => vi.fn());
const getGuestBearerTokenMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue("guest-token"),
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
  CompareRunChatSurface: (props: {
    iteration?: { _id?: string } | null;
    isLoading?: boolean;
    fallbackTrace?: { messages?: Array<{ content?: unknown }> } | null;
    traceBlob?: { messages?: Array<{ content?: unknown }> } | null;
  }) => {
    // Mirror the active-trace selection the real surface does (blob ?? fallback)
    // so the streaming chat preview's message count/first message are assertable.
    const activeMessages =
      props.traceBlob?.messages ?? props.fallbackTrace?.messages ?? [];
    const firstMessage = activeMessages[0]?.content;
    return (
      <div
        data-testid="compare-run-chat-surface"
        data-iteration={props.iteration?._id ?? "none"}
        data-is-loading={String(Boolean(props.isLoading))}
        data-message-count={String(activeMessages.length)}
        data-first-message={
          typeof firstMessage === "string" ? firstMessage : ""
        }
      >
        {props.iteration?._id ?? "none"}
      </div>
    );
  },
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
  runEvalTestCase: (...args: unknown[]) => runEvalTestCaseMock(...args),
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
    const card = document.querySelector(
      `[data-compare-model-label="${modelLabel}"]`,
    );
    expect(card).not.toBeNull();
    return card as HTMLElement;
  }

  function getMetricRunningSpinnerCount(container: ParentNode): number {
    return container.querySelectorAll('[data-testid="metric-running-spinner"]')
      .length;
  }

  const threeModelCompareCase = {
    ...caseDoc,
    models: [
      { provider: "openai", model: "gpt-4" },
      { provider: "anthropic", model: "claude-4.5-sonnet" },
      { provider: "google", model: "gemini-2.5-pro" },
    ],
  };

  let activeCaseDoc = caseDoc;

  function getLatestTraceViewerProps() {
    const lastCall = mockTraceViewer.mock.calls.at(-1)?.[0];
    expect(lastCall).toBeDefined();
    return lastCall as {
      trace?: { messages?: Array<{ content?: unknown }> } | null;
      forcedViewMode?: string;
      isLoading?: boolean;
      expectedToolCalls?: Array<{
        toolName: string;
        arguments: Record<string, unknown>;
      }>;
    };
  }

  beforeEach(() => {
    activeCaseDoc = caseDoc;
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
        return [activeCaseDoc];
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

  it("opens compare run mode when the route requests run view", async () => {
    renderWithProviders(
      <TestTemplateEditor
        suiteIterations={[baseIteration]}
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
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("No compare run yet")).not.toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /retry all/i }),
    ).toBeInTheDocument();
  });

  it("runs compare cases with servers from host attachments", async () => {
    const user = userEvent.setup();

    useQueryMock.mockImplementation((name: string, args: unknown) => {
      if (name === "testSuites:listTestCases") {
        return [activeCaseDoc];
      }
      if (name === "testSuites:getTestSuite") {
        return {
          _id: "suite-1",
          hostAttachments: [
            {
              namedHostId: "host-1",
              hostName: "Host",
              resolvedServerNames: ["srv"],
            },
          ],
        };
      }
      if (name === "hostConfigsV2:getSuiteConfig") {
        return null;
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

    renderWithProviders(
      <TestTemplateEditor
        suiteIterations={[baseIteration]}
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
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /run$/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(1);
    });

    expect(streamEvalTestCaseMock.mock.calls[0]?.[0]).toMatchObject({
      serverIds: ["srv"],
      namedHostId: "host-1",
    });
  });

  it("runs compare cases with the selected attached host", async () => {
    const user = userEvent.setup();

    useQueryMock.mockImplementation((name: string, args: unknown) => {
      if (name === "testSuites:listTestCases") {
        return [activeCaseDoc];
      }
      if (name === "testSuites:getTestSuite") {
        return {
          _id: "suite-1",
          hostAttachments: [
            {
              namedHostId: "host-1",
              hostName: "MCPJam",
              resolvedServerNames: ["srv-a"],
            },
            {
              namedHostId: "host-2",
              hostName: "Claude",
              resolvedServerNames: ["srv-b"],
            },
          ],
        };
      }
      if (name === "hostConfigsV2:getSuiteConfig") {
        return null;
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

    renderWithProviders(
      <TestTemplateEditor
        suiteIterations={[baseIteration]}
        suiteId="suite-1"
        selectedTestCaseId="case-1"
        connectedServerNames={new Set(["srv-a", "srv-b"])}
        projectId={null}
        availableModels={[
          {
            provider: "openai",
            model: "gpt-4",
            label: "GPT-4",
          } as any,
        ]}
      />,
    );

    const hostSelect = await screen.findByLabelText("Host for the next run");
    expect(hostSelect).toHaveValue("host-1");

    await user.selectOptions(hostSelect, "host-2");
    await user.click(screen.getByRole("button", { name: /run$/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(1);
    });

    expect(streamEvalTestCaseMock.mock.calls[0]?.[0]).toMatchObject({
      serverIds: ["srv-b"],
      namedHostId: "host-2",
    });
  });

  it("shows the suite's default host read-only (no picker) when there are no attachments, and runs hostless-free", async () => {
    const user = userEvent.setup();

    useQueryMock.mockImplementation((name: string, args: unknown) => {
      if (name === "testSuites:listTestCases") {
        return [activeCaseDoc];
      }
      if (name === "testSuites:getTestSuite") {
        // Attachment-less suite: servers come from the legacy environment list.
        return {
          _id: "suite-1",
          environment: { servers: ["srv"] },
        };
      }
      if (name === "hostConfigsV2:getSuiteConfig") {
        // No v2 config written → the chip falls back to the MCPJam default.
        return null;
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

    renderWithProviders(
      <TestTemplateEditor
        suiteIterations={[baseIteration]}
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
      />,
    );

    // The host is shown read-only as "MCPJam" — never an empty/hostless state,
    // and there is no "Suite default" pseudo-option.
    const hostLabel = await screen.findByLabelText("Host for the next run");
    expect(hostLabel).toHaveTextContent(/MCPJam/i);
    expect(hostLabel.querySelector("select")).toBeNull();
    expect(screen.queryByText(/Suite default/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /run$/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(1);
    });

    // No namedHostId is sent; the server resolves the suite's own host config
    // (defaulting to MCPJam) rather than running hostless.
    const request = streamEvalTestCaseMock.mock.calls[0]?.[0];
    expect(request).toMatchObject({ serverIds: ["srv"] });
    expect(request?.namedHostId).toBeUndefined();
  });

  it("shows live compare results after Run switches the route into compare mode", async () => {
    const user = userEvent.setup();

    function RoutedEditor() {
      const [openCompare, setOpenCompare] = useState(false);
      return (
        <TestTemplateEditor
          suiteIterations={[baseIteration]}
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
          openCompareFromRoute={openCompare}
          onSelectTab={(tab) => setOpenCompare(tab === "runs")}
        />
      );
    }

    renderWithProviders(<RoutedEditor />);

    await user.click(screen.getByRole("button", { name: /run$/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(screen.queryByText("Loading results...")).not.toBeInTheDocument();
      expect(screen.getByTestId("compare-run-chat-surface")).toHaveTextContent(
        "iter-openai-gpt-4",
      );
    });
  });

  it("shows a loading spinner instead of config UI while route-open compare data is unresolved", async () => {
    // Iterations are now a prop, not a query — the remaining loading gates
    // are `testCases === undefined`, the init ref mismatch, and the route
    // anchor iteration. Withholding `testSuites:listTestCases` drives the
    // spinner here; once that query resolves the route can settle.
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
        return [activeCaseDoc];
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
        suiteIterations={[baseIteration]}
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
      />,
    );

    expect(screen.getByText("Loading results...")).toBeInTheDocument();
    expect(screen.queryByText("User prompt")).not.toBeInTheDocument();

    queriesReady = true;
    view.rerender(
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        <TestTemplateEditor
          suiteIterations={[baseIteration]}
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
      </PreferencesStoreProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /retry all/i }),
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
        suiteIterations={[newerQuickIteration, clickedIteration]}
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
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("compare-run-chat-surface")).toHaveAttribute(
        "data-iteration",
        clickedIteration._id,
      );
    });
  });

  it("renders the flat step-list editor for a single-turn case", async () => {
    renderWithProviders(
      <TestTemplateEditor
        suiteIterations={[baseIteration]}
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
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("User prompt")).toBeInTheDocument();
    });

    expect(screen.getByText("Steps")).toBeInTheDocument();
    expect(screen.queryByText("Prompt steps")).not.toBeInTheDocument();
  });

  it("runs compare across case-configured models and reuses the compare session id for per-model retry", async () => {
    const user = userEvent.setup();

    activeCaseDoc = threeModelCompareCase;

    renderWithProviders(
      <TestTemplateEditor
        suiteIterations={[baseIteration]}
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
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /run compare/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /run compare/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(3);
    });

    expect(updateTestCaseMutationMock).not.toHaveBeenCalled();

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

    useQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:listTestCases") return [draftCase];
      if (name === "testSuites:getTestSuite") {
        return { _id: "suite-1", environment: { servers: ["srv"] } };
      }
      return undefined;
    });

    renderWithProviders(
      <TestTemplateEditor
        suiteIterations={[]}
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

    await user.click(screen.getByRole("button", { name: /run$/i }));

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
        steps: [
          expect.objectContaining({
            id: "turn-1",
            kind: "prompt",
            prompt: "Find the latest incidents",
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
        suiteIterations={[baseIteration]}
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

    // Chat streams through the unified CompareRunChatSurface (one instance
    // across streaming → completed so the live widget subtree is preserved).
    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(1);
      expect(
        screen.getByTestId("compare-run-chat-surface"),
      ).toBeInTheDocument();
    });

    expect(screen.getByTestId("compare-run-chat-surface")).toHaveAttribute(
      "data-is-loading",
      "true",
    );
    expect(screen.getByTestId("compare-run-chat-surface")).toHaveAttribute(
      "data-message-count",
      "1",
    );
    expect(screen.getByTestId("compare-run-chat-surface")).toHaveAttribute(
      "data-first-message",
      "Q",
    );
    expect(screen.queryByText("Running GPT-4…")).not.toBeInTheDocument();
  });

  it("renders a chat preview (not generic spinner) before the first stream event when the case has expected tool calls", async () => {
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
        suiteIterations={[baseIteration]}
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
      expect(
        screen.getByTestId("compare-run-chat-surface"),
      ).toBeInTheDocument();
    });

    // Chat preview streams through CompareRunChatSurface while the run is in flight.
    expect(screen.getByTestId("compare-run-chat-surface")).toHaveAttribute(
      "data-is-loading",
      "true",
    );
    expect(screen.getByTestId("compare-run-chat-surface")).toHaveAttribute(
      "data-first-message",
      "Q",
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
        suiteIterations={[baseIteration]}
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

    // Chat now streams through the unified CompareRunChatSurface (fallbackTrace
    // = live streaming trace), preserved across the streaming → completed swap.
    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("compare-run-chat-surface")).toHaveAttribute(
        "data-first-message",
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
      const surface = screen.getByTestId("compare-run-chat-surface");
      expect(surface).toHaveAttribute("data-is-loading", "true");
      expect(surface).toHaveAttribute("data-message-count", "1");
      expect(surface).toHaveAttribute("data-first-message", "Streamed prompt");
    });
  });

  it("defaults to Chat tab when expected tool calls are on a non-first prompt turn (multi-turn case)", async () => {
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
        suiteIterations={[baseIteration]}
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

    // The pre-stream preview uses the first prompt turn in Chat mode.
    await waitFor(() => {
      expect(screen.getByTestId("compare-run-chat-surface")).toHaveAttribute(
        "data-is-loading",
        "true",
      );
      expect(screen.getByTestId("compare-run-chat-surface")).toHaveAttribute(
        "data-first-message",
        "First prompt",
      );
    });
  });

  it("only applies the host shell on Chat in the result column", async () => {
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
        suiteIterations={[baseIteration]}
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

    // No `[data-selected]` host-style markers should appear in the
    // result tree — host-style chrome only renders inside the Chat tab.
    expect(
      view.container.querySelector('[data-testid^="test-case-host-style-"]'),
    ).toBeNull();

    const card = getCompareCard("GPT-4");

    // Default tab is Chat, so the host shell is visible immediately.
    expect(card.querySelector('[data-host-style="claude"]')).not.toBeNull();

    // Single-model runs render through the Preview pane, which portals the
    // trace-view tab strip into the pane header (outside the compare card), so
    // the tab buttons are queried screen-wide. The "Results" tab was renamed to
    // "Tool Calls". The host-shell assertions still target the card body.
    await user.click(screen.getByRole("button", { name: /^Trace$/i }));
    expect(card.querySelector("[data-host-style]")).toBeNull();

    await user.click(screen.getByRole("button", { name: /^Chat$/i }));
    expect(card.querySelector('[data-host-style="claude"]')).not.toBeNull();

    await user.click(screen.getByRole("button", { name: /^Raw$/i }));
    expect(card.querySelector("[data-host-style]")).toBeNull();

    await user.click(screen.getByRole("button", { name: /^Tool Calls$/i }));
    expect(card.querySelector("[data-host-style]")).toBeNull();
  });

  it("surfaces stream errors without falling back to the suite executor", async () => {
    const user = userEvent.setup();

    streamEvalTestCaseMock.mockImplementation(
      async (
        _request: { model: string; provider: string; compareRunId?: string },
        onEvent: (event: { type: "error"; message: string }) => void,
      ) => {
        onEvent({
          type: "error",
          message: "Pinned stream failed",
        });
      },
    );

    renderWithProviders(
      <TestTemplateEditor
        suiteIterations={[baseIteration]}
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
      // The single-model run streams into the Preview pane, which portals the
      // result pill into the pane header (outside the compare-card wrapper).
      // Scope to the screen; "Failed" (exact) matches only the pill.
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
    expect(runEvalTestCaseMock).not.toHaveBeenCalled();
    expect(screen.getByText("Pinned stream failed")).toBeInTheDocument();
  });

  it("renders running status in the preview card header while a compare run is in flight", async () => {
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

    activeCaseDoc = threeModelCompareCase;

    renderWithProviders(
      <TestTemplateEditor
        suiteIterations={[baseIteration]}
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
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /run compare/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /run compare/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(3);
    });

    const runningCard = getCompareCard("Gemini 2.5 Pro");
    expect(within(runningCard).getByLabelText("Running")).toBeInTheDocument();
    expect(getMetricRunningSpinnerCount(runningCard)).toBe(0);

    finalModelDeferred.resolve();

    await waitFor(() => {
      expect(
        within(runningCard).queryByLabelText("Running"),
      ).not.toBeInTheDocument();
      expect(within(runningCard).getByLabelText("Passed")).toBeInTheDocument();
    });
  });

  it("clears running status after a running record completes", async () => {
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

    activeCaseDoc = threeModelCompareCase;

    renderWithProviders(
      <TestTemplateEditor
        suiteIterations={[baseIteration]}
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
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /run compare/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /run compare/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(3);
    });

    const compareCard = getCompareCard("Gemini 2.5 Pro");
    expect(within(compareCard).getByLabelText("Running")).toBeInTheDocument();
    expect(getMetricRunningSpinnerCount(compareCard)).toBe(0);

    finalModelDeferred.resolve();

    await waitFor(() => {
      expect(
        within(compareCard).queryByLabelText("Running"),
      ).not.toBeInTheDocument();
      expect(within(compareCard).getByLabelText("Passed")).toBeInTheDocument();
    });
  });

  it("does not apply cross-model winner accents after all models finish running", async () => {
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

    activeCaseDoc = threeModelCompareCase;

    renderWithProviders(
      <TestTemplateEditor
        suiteIterations={[baseIteration]}
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
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /run compare/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /run compare/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(3);
      expect(
        within(getCompareCard("GPT-4")).getByLabelText("Passed"),
      ).toBeInTheDocument();
    });

    finalModelDeferred.resolve();

    await waitFor(() => {
      expect(
        within(getCompareCard("Gemini 2.5 Pro")).getByLabelText("Passed"),
      ).toBeInTheDocument();
    });
  });

  it("shows pass/fail pills per compare column without metric rows", async () => {
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

    activeCaseDoc = threeModelCompareCase;

    renderWithProviders(
      <TestTemplateEditor
        suiteIterations={[baseIteration]}
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
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /run compare/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /run compare/i }));

    await waitFor(() => {
      expect(streamEvalTestCaseMock).toHaveBeenCalledTimes(3);
    });

    const openAiCard = getCompareCard("GPT-4");
    const openAiScope = within(openAiCard);
    const failedCard = getCompareCard("Gemini 2.5 Pro");

    await waitFor(() => {
      expect(openAiScope.getByLabelText("Passed")).toBeInTheDocument();
      expect(within(failedCard).getByText("Failed")).toBeInTheDocument();
    });

    expect(openAiScope.queryByText("Latency")).not.toBeInTheDocument();
    expect(within(failedCard).queryByText("Latency")).not.toBeInTheDocument();
  });
});
