import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareUsageThreadDetail } from "../ShareUsageThreadDetail";

const {
  mockMessageView,
  mockAdaptTraceToUiMessages,
  mockRequestJudge,
  mockNavigateApp,
  mockUseQuery,
  mockThreadState,
  mockBrowserArtifactsState,
  mockHydrateTurnTraceSpans,
  mockTraceViewer,
  mockTurnTracesState,
  mockHostConfigState,
  mockCopyToClipboard,
  mockScoreState,
} = vi.hoisted(() => ({
  mockScoreState: { error: false },
  mockMessageView: vi.fn(),
  mockAdaptTraceToUiMessages: vi.fn(),
  mockRequestJudge: vi.fn().mockResolvedValue(null),
  mockNavigateApp: vi.fn(),
  mockUseQuery: vi.fn(() => undefined),
  mockThreadState: {
    sourceType: "scenario",
    synthetic: false as boolean,
    readiness: undefined as unknown,
    goalScore: undefined as unknown,
    runAttemptStatus: undefined as unknown,
    analysisPhase: undefined as string | undefined,
  },
  mockBrowserArtifactsState: {
    artifacts: undefined as unknown,
  },
  mockHydrateTurnTraceSpans: vi.fn(
    async (..._args: unknown[]) => [] as unknown[],
  ),
  mockTraceViewer: vi.fn(),
  mockTurnTracesState: {
    traces: [] as unknown[],
  },
  // The session's pinned historical host config — what the header's
  // client/model chip reads the CLIENT from. `null` is the ordinary answer for
  // a session written before the pin existed.
  mockCopyToClipboard: vi.fn().mockResolvedValue(true),
  mockHostConfigState: {
    config: null as {
      hostStyle?: string;
      currentHostName?: string | null;
      modelId?: string;
    } | null | undefined,
  },
}));

// `useQuery` is here for SessionChecksSection, which subscribes to
// `chatSessionChecks:getCheckRunsForSession`. Undefined = still loading, which
// is the state that keeps the panel out of every assertion in this file; the
// panel's own behavior is covered in SessionChecksSection.test.tsx. The args
// are captured so the id WIRING can be asserted here — that is the one thing
// the panel's own suite cannot check, since it is handed the id directly.
vi.mock("convex/react", () => ({
  useAction: () => mockRequestJudge,
  useMutation: () => vi.fn().mockResolvedValue({ queued: true }),
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

// Analyze now is offered to members only; the check is a Convex query.
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => true,
}));

vi.mock("@/hooks/useSharedChatThreads", () => ({
  useSharedChatThread: () => ({
    thread: {
      // The chatSessions doc id the checks panel keys on. Distinct field from
      // the `threadId` prop on purpose — the component must read this one.
      _id: "session-doc-1",
      chatSessionId: "wire-uuid",
      projectId: "project-1",
      sourceType: mockThreadState.sourceType,
      synthetic: mockThreadState.synthetic,
      readiness: mockThreadState.readiness,
      goalScore: mockThreadState.goalScore,
      runAttemptStatus: mockThreadState.runAttemptStatus,
      analysisPhase: mockThreadState.analysisPhase,
      messagesBlobUrl: "https://storage.example.com/thread.json",
      modelId: "openai/gpt-oss-120b",
      recordedContext: {
        toolSnapshots: [
          {
            hash: "frozen-catalog",
            snapshot: {
              servers: [
                { serverId: "recorded-server", tools: [{ name: "search" }] },
              ],
            },
          },
        ],
      },
      visitorDisplayName: "Marcelo Jimenez",
      messageCount: 2,
      startedAt: Date.now() - 1000,
      lastActivityAt: Date.now(),
    },
  }),
  useSharedChatWidgetSnapshots: () => ({
    snapshots: [],
  }),
  // Absent from this factory the transcript subtree threw on every test in the
  // file and rendered the ErrorBoundary fallback instead — green, but not
  // exercising the tree it claims to. The assertions here sit outside that
  // boundary, so nothing was wrong, just unwatched.
  useSharedChatTurnScores: () => {
    if (mockScoreState.error) throw new Error("scores unavailable");
    return { scores: [] };
  },
  useSharedChatTurnTraces: () => ({
    traces: mockTurnTracesState.traces,
  }),
  useSessionBrowserArtifacts: () => ({
    artifacts: mockBrowserArtifactsState.artifacts,
  }),
  useSessionHistoricalHostConfig: () => ({
    config: mockHostConfigState.config,
  }),
}));

// The header chip resolves model NAMES through the hosted catalog. Pinned to
// the static fallback here so the label under test is the component's
// resolution order and not a live fetch.
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (...args: unknown[]) => mockCopyToClipboard(...args),
}));

vi.mock("@/hooks/use-hosted-model-catalog", () => ({
  useHostedModelCatalog: () => ({
    hostedCatalog: [
      {
        id: "openai/gpt-oss-120b",
        name: "GPT-OSS 120B",
        provider: "openai",
        hosted: true,
      },
    ],
    status: "live",
  }),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

// The `sessionAnchored` decision is made HERE, not in the utility, so the
// utility's own suite cannot catch this component passing the wrong flag.
// Only the fetching helper is replaced — `expectedTurnTraceSpanCount` and
// `turnTraceWallClockRange` are pure and stay real, so the span-load-failure
// and anchor assertions below exercise the wiring rather than a stub of it.
vi.mock("@/components/evals/turn-trace-spans", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/evals/turn-trace-spans")
  >()),
  hydrateTurnTraceSpans: (...args: unknown[]) =>
    mockHydrateTurnTraceSpans(...args),
}));

// Stubbed so the Trace tab is cheap to render AND so the wall-clock anchor it
// is handed can be asserted — the offsets alone do not tell the reader when
// anything happened.
vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: (props: Record<string, unknown>) => {
    mockTraceViewer(props);
    return <div data-testid="trace-viewer" />;
  },
}));

vi.mock("@/components/evals/trace-viewer-adapter", () => ({
  adaptTraceToUiMessages: (...args: unknown[]) =>
    mockAdaptTraceToUiMessages(...args),
  snapshotsToTraceWidgetSnapshots: (snapshots: unknown[]) => snapshots,
}));

vi.mock("@/components/chat-v2/thread/message-view", () => ({
  MessageView: (props: Record<string, unknown>) => {
    mockMessageView(props);
    return <div data-testid="message-view" />;
  },
}));

vi.mock("@mcpjam/chat-ui", () => ({
  hydrateMessageTimestamps: (messages: unknown[]) => messages,

}));

vi.mock(
  "@/components/chat-v2/history/convert-promotable-session-dialog",
  () => ({
    ConvertPromotableSessionDialog: ({
      open,
      sessionId,
      onImported,
    }: {
      open: boolean;
      sessionId: string | null;
      onImported: (r: { suiteId: string; testCaseId: string }) => void;
    }) => (
      <div
        data-testid="promote-dialog"
        data-open={String(open)}
        data-session-id={sessionId ?? ""}
      >
        <button
          type="button"
          onClick={() =>
            onImported({ suiteId: "suite-1", testCaseId: "case-1" })
          }
        >
          simulate import
        </button>
      </div>
    ),
  }),
);

// Stubs, not reimplementations of the real builders (those are covered in
// lib/__tests__/eval-route-url.test.ts). The route TYPE is in the stub path
// on purpose: without it a promote that asked for the wrong kind of eval
// route would produce the same URL and pass unnoticed.
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: (...args: unknown[]) => mockNavigateApp(...args),
  buildEvalsPath: (route: Record<string, unknown>) =>
    `/evals/${route.type}/${route.suiteId}/${route.testId}`,
  buildEvaluatePath: (route: Record<string, unknown>) =>
    `/evaluate/${route.type}/${route.suiteId}/${route.testId}`,
}));

describe("ShareUsageThreadDetail", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockScoreState.error = false;
    mockThreadState.sourceType = "scenario";
    mockTurnTracesState.traces = [];
    mockHydrateTurnTraceSpans.mockResolvedValue([]);
    mockThreadState.synthetic = false;
    mockThreadState.readiness = undefined;
    mockThreadState.goalScore = undefined;
    mockThreadState.analysisPhase = undefined;
    mockBrowserArtifactsState.artifacts = undefined;
    mockHostConfigState.config = { hostStyle: "claude" };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ role: "assistant", content: [] }],
    } as Response);
    mockAdaptTraceToUiMessages.mockReturnValue({
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              text: "Collapsed in share usage traces",
              state: "done",
            },
          ],
        },
      ],
      toolRenderOverrides: {},
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("keeps the configured transcript after a ratings failure and retries on session change", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockScoreState.error = true;
    const { rerender } = render(<ShareUsageThreadDetail threadId="thread-1" />);
    await waitFor(() => expect(mockTraceViewer).toHaveBeenCalledWith(expect.objectContaining({
      hostSnapshot: expect.objectContaining({ hostStyle: "claude" }),
      widgetPolicy: "live", frame: "none", interactive: false,
    })));
    expect(mockTraceViewer.mock.lastCall?.[0].renderAssistantTurnFooter).toBeUndefined();
    mockScoreState.error = false;
    rerender(<ShareUsageThreadDetail threadId="thread-2" />);
    await waitFor(() => expect(mockTraceViewer.mock.lastCall?.[0].renderAssistantTurnFooter).toEqual(expect.any(Function)));
    consoleError.mockRestore();
  });

  it("waits for the pinned host before mounting Chat and leaves Raw accessible", async () => {
    mockHostConfigState.config = undefined;
    render(<ShareUsageThreadDetail threadId="thread-1" />);
    expect(await screen.findByText("Loading host configuration…")).toBeInTheDocument();
    expect(mockTraceViewer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    await waitFor(() => expect(mockTraceViewer).toHaveBeenCalled());
  });

  it("offers Analyze now in the header of a User Testing session still waiting on its pass", async () => {
    mockThreadState.analysisPhase = "owed";
    const { rerender } = render(
      <ShareUsageThreadDetail threadId="thread-1" />,
    );
    expect(
      await screen.findByTestId("share-usage-analyze-now"),
    ).toHaveTextContent("Analyze now");
    // Final: nothing Analyze now could change, so no button.
    mockThreadState.analysisPhase = "final";
    rerender(<ShareUsageThreadDetail threadId="thread-1" />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("share-usage-analyze-now"),
      ).not.toBeInTheDocument(),
    );
  });

  it("links a direct session to its Playground conversation", async () => {
    mockThreadState.sourceType = "direct";
    render(<ShareUsageThreadDetail threadId="thread-1" />);
    expect(
      await screen.findByRole("link", { name: "Open in Playground" }),
    ).toHaveAttribute(
      "href",
      "/playground?conversation=wire-uuid&project=project-1",
    );
  });

  it("renders formatted share traces with collapsed reasoning", async () => {
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Trace" })).toBeInTheDocument();
      expect(mockAdaptTraceToUiMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          toolResultDisplay: "attached-to-tool",
        }),
      );
      expect(mockTraceViewer).toHaveBeenCalledWith(
        expect.objectContaining({
          reasoningDisplayMode: "collapsible",
          widgetPolicy: "live",
        }),
      );
    });
  });

  it("fades Raw's scroll edges from the same switch as Chat", async () => {
    // Both panes of a session scroll, and the complaint that started this was
    // about the edge, not about what was behind it — so one flag covers both
    // rather than a caller having to remember two.
    render(<ShareUsageThreadDetail threadId="thread-1" fadeScrollEdges />);

    // `TraceViewer` only mounts off the Chat tab, so the assertion has to get
    // there first — asserting on the landing tab would pass for the wrong
    // reason (a spy that was never called cannot disagree).
    fireEvent.click(await screen.findByRole("button", { name: "Raw" }));

    await waitFor(() => {
      expect(mockTraceViewer).toHaveBeenCalledWith(
        expect.objectContaining({ rawFadeScrollEdges: true }),
      );
    });
  });

  it("passes the frozen tool catalog into the shared Raw trace viewer", async () => {
    render(<ShareUsageThreadDetail threadId="thread-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Raw" }));
    await waitFor(() =>
      expect(mockTraceViewer).toHaveBeenCalledWith(
        expect.objectContaining({
          trace: expect.objectContaining({
            recordedContext: expect.objectContaining({
              toolSnapshots: expect.arrayContaining([
                expect.objectContaining({ hash: "frozen-catalog" }),
              ]),
            }),
          }),
        }),
      ),
    );
  });

  it("leaves Raw alone on a surface that did not ask for the fade", async () => {
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Raw" }));

    await waitFor(() => {
      expect(mockTraceViewer).toHaveBeenCalledWith(
        expect.objectContaining({ rawFadeScrollEdges: false }),
      );
    });
  });

  it("uses the inspector renderer with the pinned host and live MCP Apps", async () => {
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => {
      expect(mockTraceViewer).toHaveBeenCalledWith(
        expect.objectContaining({ frame: "none", widgetPolicy: "live", interactive: false, hostSnapshot: expect.objectContaining({ hostStyle: "claude" }), adaptedTrace: expect.objectContaining({ messages: expect.any(Array) }) }),
      );
    });
  });

  it("renders scenario threads with collapsible reasoning in chat mode", async () => {
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => {
      expect(mockTraceViewer).toHaveBeenCalledWith(
        expect.objectContaining({
          reasoningDisplayMode: "collapsible",
        }),
      );
    });
  });

  it("auto-runs the judge for an ungraded swarm session", async () => {
    mockThreadState.sourceType = "swarm";

    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => {
      expect(mockRequestJudge).toHaveBeenCalledWith({ sessionId: "thread-1" });
    });
  });

  it("hides the Replay tab when the session has no browser artifacts", async () => {
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Replay" }),
    ).not.toBeInTheDocument();
  });

  it("shows the Replay tab and renders the artifacts view when artifacts exist", async () => {
    mockBrowserArtifactsState.artifacts = {
      widgetRenderObservations: [
        {
          toolCallId: "tc-1",
          toolName: "create_view",
          serverId: "server-1",
          promptIndex: 0,
          status: "rendered",
          screenshotUrl: null,
          elapsedMs: 1200,
          ts: 1,
        },
      ],
      browserInteractionSteps: [
        {
          toolCallId: "tc-1",
          stepIndex: 0,
          promptIndex: 0,
          action: "left_click",
          coordinateX: 10,
          coordinateY: 20,
          screenshotUrl: null,
          elapsedMs: 80,
          ts: 2,
        },
      ],
    };

    render(<ShareUsageThreadDetail threadId="thread-1" />);

    const appTab = await screen.findByRole("button", { name: "Replay" });
    await userEvent.click(appTab);

    // Render-observation card from BrowserArtifactsView (the same component the
    // eval replay uses). The per-step interaction timeline now lives on the
    // Trace tab (`Interact · …` spans), not in the Replay tab.
    expect(
      await screen.findByTestId("browser-artifacts-view"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("render-observation-card")).toBeInTheDocument();
    expect(screen.queryByText("Computer Use timeline")).toBeNull();
  });

  it("falls back to Chat when the active browser view loses its artifacts (session switch)", async () => {
    // Cursor Bugbot (PR 2610): viewMode is component state that survives a
    // threadId switch; with the Browser tab hidden, a stale "browser" mode
    // must not strand the user on an orphaned empty panel.
    mockBrowserArtifactsState.artifacts = {
      widgetRenderObservations: [
        {
          toolCallId: "tc-1",
          toolName: "create_view",
          serverId: "server-1",
          promptIndex: 0,
          status: "rendered",
          screenshotUrl: null,
          elapsedMs: 1200,
          ts: 1,
        },
      ],
      browserInteractionSteps: [],
    };

    const { rerender } = render(<ShareUsageThreadDetail threadId="thread-1" />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Replay" }),
    );
    expect(
      await screen.findByTestId("browser-artifacts-view"),
    ).toBeInTheDocument();

    // The next session has no artifacts (same mounted component instance).
    mockBrowserArtifactsState.artifacts = {
      widgetRenderObservations: [],
      browserInteractionSteps: [],
    };
    rerender(<ShareUsageThreadDetail threadId="thread-2" />);

    await waitFor(() => {
      expect(
        screen.queryByTestId("browser-artifacts-view"),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Replay" }),
    ).not.toBeInTheDocument();
    // Chat content renders instead of a blank panel. findBy: the messages
    // blob re-fetch on thread switch is async — don't depend on the previous
    // thread's messages state being retained (CodeRabbit, PR 2610).
    expect(
      await screen.findByTestId("trace-viewer"),
    ).toBeInTheDocument();
  });
});

describe("ShareUsageThreadDetail — promote affordance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockThreadState.sourceType = "scenario";
    mockThreadState.synthetic = false;
    mockThreadState.readiness = undefined;
    mockThreadState.goalScore = undefined;
    mockThreadState.runAttemptStatus = undefined;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ role: "assistant", content: [] }],
    } as Response);
    mockAdaptTraceToUiMessages.mockReturnValue({
      messages: [{ id: "assistant-1", role: "assistant", parts: [] }],
      toolRenderOverrides: {},
    });
  });

  const PROMOTE = { projectId: "proj-1", canPromote: true };

  it("renders for a member on a User Testing session", async () => {
    render(<ShareUsageThreadDetail threadId="thread-1" promote={PROMOTE} />);
    expect(
      await screen.findByTestId("share-usage-promote-to-test-case"),
    ).toBeInTheDocument();
  });

  it("is absent for a project guest", async () => {
    render(
      <ShareUsageThreadDetail
        threadId="thread-1"
        promote={{ ...PROMOTE, canPromote: false }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Chat/ })).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("share-usage-promote-to-test-case"),
    ).not.toBeInTheDocument();
    // Nor does the guest pay for the dialog's project queries.
    expect(screen.queryByTestId("promote-dialog")).not.toBeInTheDocument();
  });

  it("is absent entirely when the surface passes no capability", async () => {
    // The host share-usage dialog: no project scope, no promote UI. Assert
    // the BUTTON, not the dialog — the dialog is never mounted without the
    // prop, so asserting its absence would pass even if the button leaked.
    render(<ShareUsageThreadDetail threadId="thread-1" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Chat/ })).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("share-usage-promote-to-test-case"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("promote-dialog")).not.toBeInTheDocument();
  });

  it("is absent on a direct session, which keeps its own adapter", async () => {
    mockThreadState.sourceType = "direct";
    render(<ShareUsageThreadDetail threadId="thread-1" promote={PROMOTE} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Chat/ })).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("share-usage-promote-to-test-case"),
    ).not.toBeInTheDocument();
  });

  /**
   * A swarm session is promotable only when its run attempt SUCCEEDED. The
   * transcript renders the same either way, so before BB-247 the button was
   * live on every row and a non-succeeded one answered with a raw Convex
   * stack trace inside the dialog.
   */
  describe("swarm sessions whose run did not succeed", () => {
    beforeEach(() => {
      mockThreadState.sourceType = "swarm";
    });

    it("stays enabled when the attempt succeeded", async () => {
      mockThreadState.runAttemptStatus = "succeeded";
      render(<ShareUsageThreadDetail threadId="thread-1" promote={PROMOTE} />);

      const button = await screen.findByTestId(
        "share-usage-promote-to-test-case",
      );
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute("aria-disabled");
      expect(
        screen.queryByTestId("share-usage-promote-blocked"),
      ).not.toBeInTheDocument();
    });

    it.each([
      ["failed", /did not finish/i],
      ["rate_limited", /rate limit/i],
      ["running", /still running/i],
      // What the backend actually sends for an attempt it could not identify
      // (`chatSessions.ts` returns the literal `null`, never `undefined`), so
      // this is the real unclaimed-session path rather than a synthetic one.
      [null, /outcome is unknown/i],
    ])("disables the button on a %s attempt", async (status, copy) => {
      mockThreadState.runAttemptStatus = status;
      const user = userEvent.setup();
      render(<ShareUsageThreadDetail threadId="thread-1" promote={PROMOTE} />);

      const button = await screen.findByTestId(
        "share-usage-promote-to-test-case",
      );
      // `aria-disabled`, not `disabled`: the control keeps focus so keyboard
      // and touch users can reach its explanation.
      expect(button).toHaveAttribute("aria-disabled", "true");

      // Inert all the same — opening the dialog is the path that rendered the
      // server error.
      await user.click(button);
      expect(
        screen.getByTestId("promote-dialog").getAttribute("data-open"),
      ).toBe("false");

      // The reason reaches a mouse (title) and assistive tech (description).
      expect(button).toHaveAttribute("title", expect.stringMatching(copy));
      expect(button).toHaveAccessibleDescription(copy);
    });

    /**
     * A failed attempt often persists no transcript at all, and that shell
     * renders before the header — so neither the disabled button nor its
     * hover reason is reachable there. The reason has to appear in the empty
     * state itself or the reader is left guessing.
     */
    it("explains the blocked state when there is no transcript either", async () => {
      mockThreadState.runAttemptStatus = "failed";
      mockAdaptTraceToUiMessages.mockReturnValue({
        messages: [],
        toolRenderOverrides: {},
      });
      render(<ShareUsageThreadDetail threadId="thread-1" promote={PROMOTE} />);

      expect(
        await screen.findByTestId("share-usage-empty-promote-blocked"),
      ).toHaveTextContent(/did not finish/i);
    });

    it("blocks when the backend reports no status at all", async () => {
      // Older backend, or an attempt row that claims no session. Absence is
      // not permission.
      mockThreadState.runAttemptStatus = undefined;
      render(<ShareUsageThreadDetail threadId="thread-1" promote={PROMOTE} />);

      expect(
        await screen.findByTestId("share-usage-promote-to-test-case"),
      ).toHaveAttribute("aria-disabled", "true");
    });
  });

  it("opens the dialog on this thread and navigates to the created case", async () => {
    const user = userEvent.setup();
    render(<ShareUsageThreadDetail threadId="thread-1" promote={PROMOTE} />);

    const dialog = await screen.findByTestId("promote-dialog");
    expect(dialog.getAttribute("data-open")).toBe("false");
    expect(dialog.getAttribute("data-session-id")).toBe("thread-1");

    await user.click(screen.getByTestId("share-usage-promote-to-test-case"));
    await waitFor(() =>
      expect(
        screen.getByTestId("promote-dialog").getAttribute("data-open"),
      ).toBe("true"),
    );

    // Default behavior lands the user on the artifact they just created.
    await user.click(screen.getByText("simulate import"));
    await waitFor(() =>
      expect(mockNavigateApp).toHaveBeenCalledWith("/evaluate/test-edit/suite-1/case-1"),
    );
  });

  it("lets a surface override onImported instead of navigating", async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    render(
      <ShareUsageThreadDetail
        threadId="thread-1"
        promote={{ ...PROMOTE, onImported }}
      />,
    );

    await user.click(
      await screen.findByTestId("share-usage-promote-to-test-case"),
    );
    await user.click(screen.getByText("simulate import"));

    await waitFor(() =>
      expect(onImported).toHaveBeenCalledWith({
        suiteId: "suite-1",
        testCaseId: "case-1",
      }),
    );
    // The override REPLACES the default navigation; it must not also fire.
    expect(mockNavigateApp).not.toHaveBeenCalled();
  });

  it("closes an open dialog when the capability is withdrawn", async () => {
    // A parent can withdraw `promote` while this component stays mounted on
    // the same thread — e.g. filtering a selected swarm row out of the list.
    // Without resetting, restoring the filter would resurrect a dialog the
    // user had implicitly dismissed.
    const user = userEvent.setup();
    const { rerender } = render(
      <ShareUsageThreadDetail threadId="thread-1" promote={PROMOTE} />,
    );

    await user.click(
      await screen.findByTestId("share-usage-promote-to-test-case"),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("promote-dialog").getAttribute("data-open"),
      ).toBe("true"),
    );

    rerender(
      <ShareUsageThreadDetail
        threadId="thread-1"
        promote={{ ...PROMOTE, canPromote: false }}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId("promote-dialog")).not.toBeInTheDocument(),
    );

    // Restoring the capability must NOT bring the dialog back open.
    rerender(<ShareUsageThreadDetail threadId="thread-1" promote={PROMOTE} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("promote-dialog").getAttribute("data-open"),
      ).toBe("false"),
    );
  });
});

/**
 * BB-153 span anchoring, at the level where the DECISION is made.
 *
 * `hydrateTurnTraceSpans` has its own suite, but it is handed `sessionAnchored`
 * — it cannot notice this component computing the flag from the wrong field, or
 * inverting it. These two cases are the whole routing contract.
 */
describe("ShareUsageThreadDetail — span anchoring by sourceType", () => {
  const TRACES = [{ turnIndex: 0, spanCount: 2, blobUrl: "https://b/0.json" }];

  const anchoredArg = () =>
    (
      mockHydrateTurnTraceSpans.mock.calls[0] as unknown as [
        unknown,
        { sessionAnchored?: boolean } | undefined,
      ]
    )[1]?.sessionAnchored;

  beforeEach(() => {
    mockTurnTracesState.traces = TRACES;
  });

  it("keeps an eval session's own offsets", async () => {
    // Eval blobs are already anchored at the run start; rebasing them would
    // displace every span by the persist round-trip.
    mockThreadState.sourceType = "eval";
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => expect(mockHydrateTurnTraceSpans).toHaveBeenCalled());
    expect(anchoredArg()).toBe(true);
  });

  // `"scenario"` IS the User Testing tab: `/user-testing/:id` → Sessions →
  // `ScenarioUsagePanel` → this component. Prathmesh reported the 0.0s
  // collapse on Swarm AND User Testing; both reach the fix through this one
  // call, and this is the case that says so.
  it("rebases a User Testing session", async () => {
    mockThreadState.sourceType = "scenario";
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => expect(mockHydrateTurnTraceSpans).toHaveBeenCalled());
    expect(anchoredArg()).toBe(false);
  });

  it("rebases a swarm session — the sourceType this component was built for", async () => {
    mockThreadState.sourceType = "swarm";
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => expect(mockHydrateTurnTraceSpans).toHaveBeenCalled());
    expect(anchoredArg()).toBe(false);
  });
});

/**
 * The other half of BB-153, on the surface that used to stay quiet about it.
 *
 * With no recorded spans the viewer does not draw a blank timeline — it
 * synthesizes one from `estimatedDurationMs`. The swarm pane says so; this
 * detail did not, so two views of the same session disagreed about whether
 * anything was wrong.
 */
describe("ShareUsageThreadDetail — span load failure", () => {
  const openTrace = async () => {
    // The tab bar only mounts once the transcript blob has resolved.
    await userEvent.click(await screen.findByRole("button", { name: "Trace" }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockThreadState.sourceType = "scenario";
    mockThreadState.synthetic = false;
    mockThreadState.readiness = undefined;
    mockThreadState.goalScore = undefined;
    mockThreadState.analysisPhase = undefined;
    mockBrowserArtifactsState.artifacts = undefined;
    // The transcript must load: the Trace tab only exists once the detail is
    // past its loader.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ role: "assistant", content: [] }],
    } as Response);
    mockAdaptTraceToUiMessages.mockReturnValue({
      messages: [{ id: "assistant-1", role: "assistant", parts: [] }],
      toolRenderOverrides: {},
    });
    mockTurnTracesState.traces = [
      {
        turnIndex: 0,
        startedAt: 1_000_000,
        endedAt: 1_005_000,
        spanCount: 2,
        spansBlobUrl: "https://b/0.json",
      },
    ];
  });

  it("says the durations are estimated when rows claim spans and none load", async () => {
    mockHydrateTurnTraceSpans.mockResolvedValue([]);
    render(<ShareUsageThreadDetail threadId="thread-1" />);
    await openTrace();

    const warning = await screen.findByTestId("share-usage-span-error");
    // The wording has to correct the timeline, not agree with it: with no
    // spans and no `estimatedDurationMs` the viewer prints "No timing data
    // recorded", which is a claim about the session (cubic).
    expect(warning).toHaveTextContent("not because none was recorded");
    // The transcript is unaffected — that is why this cannot share `error`,
    // whose branch replaces the whole viewer.
    expect(screen.getByTestId("trace-viewer")).toBeInTheDocument();
  });

  it("stays quiet when the spans loaded", async () => {
    mockHydrateTurnTraceSpans.mockResolvedValue([
      { id: "s1", name: "step", category: "step", startMs: 0, endMs: 10 },
    ]);
    render(<ShareUsageThreadDetail threadId="thread-1" />);
    await openTrace();

    await waitFor(() =>
      expect(screen.getByTestId("trace-viewer")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("share-usage-span-error"),
    ).not.toBeInTheDocument();
  });

  it("stays quiet for a session that recorded no spans at all", async () => {
    // Nothing to load is not a failure, and calling it one would put a warning
    // on every session traced before spans were captured.
    mockTurnTracesState.traces = [
      { turnIndex: 0, startedAt: 1_000_000, endedAt: 1_005_000, spanCount: 0 },
    ];
    mockHydrateTurnTraceSpans.mockResolvedValue([]);
    render(<ShareUsageThreadDetail threadId="thread-1" />);
    await openTrace();

    await waitFor(() =>
      expect(screen.getByTestId("trace-viewer")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("share-usage-span-error"),
    ).not.toBeInTheDocument();
  });

  it("gives an eval session no absolute anchor rather than a wrong one", async () => {
    // Eval spans are anchored at the RUN start (that is why they are not
    // rebased), while these rows carry each turn's PERSIST time — the earliest
    // of which lands after turn 1 finished. Handing that to the timeline would
    // label span offset 0 with a clock time minutes off (coderabbit).
    mockThreadState.sourceType = "eval";
    mockTurnTracesState.traces = [
      { turnIndex: 0, startedAt: 1_000_000, endedAt: 1_005_000, spanCount: 0 },
      { turnIndex: 1, startedAt: 1_008_000, endedAt: 1_012_000, spanCount: 0 },
    ];
    render(<ShareUsageThreadDetail threadId="thread-1" />);
    await openTrace();

    await waitFor(() => expect(mockTraceViewer).toHaveBeenCalled());
    expect(mockTraceViewer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        traceStartedAtMs: null,
        traceEndedAtMs: null,
      }),
    );
  });

  it("anchors the timeline on the earliest turn start", async () => {
    mockTurnTracesState.traces = [
      { turnIndex: 1, startedAt: 1_008_000, endedAt: 1_012_000, spanCount: 0 },
      { turnIndex: 0, startedAt: 1_000_000, endedAt: 1_005_000, spanCount: 0 },
    ];
    render(<ShareUsageThreadDetail threadId="thread-1" />);
    await openTrace();

    await waitFor(() => expect(mockTraceViewer).toHaveBeenCalled());
    expect(mockTraceViewer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        traceStartedAtMs: 1_000_000,
        traceEndedAtMs: 1_012_000,
      }),
    );
  });
});

/**
 * BB-197 — session identity in the header.
 *
 * Research (Sep 4): a reader with the transcript open forgot which model
 * produced it, and share was an icon they did not read as "send this to
 * someone". Both answers now live in the header of the ONE detail component
 * Swarm and User Testing share.
 */
describe("ShareUsageThreadDetail — session identity header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockThreadState.sourceType = "scenario";
    mockThreadState.synthetic = false;
    mockThreadState.readiness = undefined;
    mockThreadState.goalScore = undefined;
    mockThreadState.analysisPhase = undefined;
    mockBrowserArtifactsState.artifacts = undefined;
    mockHostConfigState.config = null;
    mockCopyToClipboard.mockResolvedValue(true);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ role: "assistant", content: [] }],
    } as Response);
    mockAdaptTraceToUiMessages.mockReturnValue({
      messages: [{ id: "assistant-1", role: "assistant", parts: [] }],
      toolRenderOverrides: {},
    });
  });

  it("names the client and the model in the session header", async () => {
    // The whole point of the chip: the reader learns which model produced the
    // transcript without opening Raw or the trace tabs.
    mockHostConfigState.config = {
      hostStyle: "chatgpt",
      currentHostName: "Emmanuel's staging bot",
      modelId: "openai/gpt-oss-120b",
    };
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("session-client-model")).toHaveTextContent(
        "ChatGPT · GPT-OSS 120B",
      ),
    );
  });

  it("still names the model when the session pinned no client", async () => {
    // No pinned host config is the ordinary state for older sessions. The
    // model is still known, and half an answer beats none.
    mockHostConfigState.config = null;
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("session-client-model")).toHaveTextContent(
        "GPT-OSS 120B",
      ),
    );
  });

  it("copies the session link from a labeled share control", async () => {
    // Labeled, not an icon: readers did not recognize the copy icon as the way
    // to send a session to a teammate.
    render(
      <ShareUsageThreadDetail
        threadId="thread-1"
        sessionLink="https://app.test/swarms/session-doc-1"
      />,
    );

    const share = await screen.findByRole("button", {
      name: /share this session/i,
    });
    await userEvent.click(share);

    await waitFor(() =>
      expect(mockCopyToClipboard).toHaveBeenCalledWith(
        "https://app.test/swarms/session-doc-1",
      ),
    );
  });
});
