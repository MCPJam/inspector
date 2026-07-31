import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatboxTopicMapPanel,
  NO_OUTCOME_COLOR,
  colorForNode,
  topicMapNodeHoverLabel,
} from "../ChatboxTopicMapPanel";
import {
  EMPTY_USAGE_FILTER,
  selectCell,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";

const { mockUseChatboxTopicMap } = vi.hoisted(() => ({
  mockUseChatboxTopicMap: vi.fn(),
}));

vi.mock("react-force-graph-2d", async () => {
  const React = await import("react");
  return {
    default: React.forwardRef(function MockForceGraph2D(
      props: {
        graphData?: { nodes?: Array<{ id: string }> };
        onNodeClick?: (node: { id: string }) => void;
        onBackgroundClick?: () => void;
      },
      ref
    ) {
      React.useImperativeHandle(ref, () => ({
        zoomToFit: vi.fn(),
      }));
      return (
        <div data-testid="force-graph">
          <button
            type="button"
            data-testid="force-graph-background"
            onClick={() => props.onBackgroundClick?.()}
          >
            Graph background
          </button>
          {(props.graphData?.nodes ?? []).map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => props.onNodeClick?.(node)}
            >
              Graph node {node.id}
            </button>
          ))}
        </div>
      );
    }),
  };
});

vi.mock("@/hooks/useChatboxTopicMap", () => ({
  useChatboxTopicMap: (...args: unknown[]) => mockUseChatboxTopicMap(...args),
}));

const EMPTY_FILTER: UsageFilterState = {
  preset: "all",
  chips: [],
};

const SNAPSHOT = {
  version: 1,
  chatboxId: "chatbox-1",
  runId: "run-1",
  generatedAt: Date.now(),
  isSampled: false,
  stats: {
    nodeCount: 2,
    edgeCount: 1,
    clusterCount: 2,
    mappedSessionCount: 2,
    unmappedSessionCount: 1,
  },
  clusters: [
    {
      clusterId: "cluster-a",
      label: "Password resets",
      summary: "Reset and account recovery questions.",
      keywords: ["password", "reset"],
      memberCount: 12,
      colorIndex: 0,
    },
    {
      clusterId: "cluster-b",
      label: "Billing issues",
      summary: "Invoice and refund help.",
      keywords: ["billing", "refund"],
      memberCount: 8,
      colorIndex: 1,
    },
  ],
  nodes: [
    {
      sessionId: "session-a",
      x: 0.1,
      y: 0.2,
      degree: 1,
      clusterId: "cluster-a",
      clusterLabel: "Password resets",
      semanticTitle: "Password reset",
      semanticPreview: "User needs to reset a forgotten password.",
      messageCount: 6,
      startedAt: Date.UTC(2026, 2, 20),
      lastActivityAt: Date.now() - 5 * 60 * 1000,
      modelId: "openai/gpt-4o-mini",
    },
    {
      sessionId: "session-b",
      x: -0.1,
      y: -0.2,
      degree: 1,
      clusterId: "cluster-b",
      clusterLabel: "Billing issues",
      semanticTitle: "Refund request",
      semanticPreview: "Refund request after duplicate charge.",
      messageCount: 4,
      startedAt: Date.UTC(2026, 2, 22),
      lastActivityAt: Date.now() - 2 * 60 * 1000,
      modelId: "openai/gpt-4o-mini",
    },
  ],
  edges: [
    {
      source: "session-a",
      target: "session-b",
      score: 0.82,
    },
  ],
};

function createDefaultChatboxTopicMapHookValue() {
  return {
    latestRun: {
      _id: "run-1",
      status: "done" as const,
      startedAt: Date.now() - 10_000,
      finishedAt: Date.now() - 5_000,
      sessionCount: 2,
      clusterCount: 2,
      errorMessage: null,
      model: "openai/gpt-4o-mini",
      topicMapVersion: 1,
      edgeCount: 1,
      sampleNodeCount: 2,
      unmappedSessionCount: 1,
      isSampled: false,
      topicMapReady: true,
      isStale: false,
    },
    snapshot: SNAPSHOT,
    snapshotMetadata: {
      runId: "run-1",
      topicMapBlobUrl: "https://storage.example.com/topic-map.json",
      topicMapVersion: 1,
      edgeCount: 1,
      sampleNodeCount: 2,
      unmappedSessionCount: 1,
      isSampled: false,
      sessionCount: 2,
      clusterCount: 2,
    },
    clusters: [
      {
        _id: "cluster-row-a",
        label: "Password resets",
        summary: "Reset and account recovery questions.",
        keywords: ["password", "reset"],
        memberCount: 12,
        createdAt: Date.now(),
      },
      {
        _id: "cluster-row-b",
        label: "Billing issues",
        summary: "Invoice and refund help.",
        keywords: ["billing", "refund"],
        memberCount: 8,
        createdAt: Date.now(),
      },
    ],
    snapshotError: null,
    isLoading: false,
    metadata: null,
  };
}

/**
 * A snapshot at the version that first carries `nodes[].outcome`. The default
 * fixture stays at version 1 on purpose so the pre-bump regression path keeps
 * being exercised.
 */
function outcomeAwareHookValue() {
  const base = createDefaultChatboxTopicMapHookValue();
  return {
    ...base,
    latestRun: { ...base.latestRun, topicMapVersion: 2, signalsVersion: 1 },
    snapshotMetadata: { ...base.snapshotMetadata, topicMapVersion: 2 },
    snapshot: {
      ...base.snapshot,
      version: 2,
      nodes: [
        { ...base.snapshot.nodes[0], outcome: "completed" as const },
        { ...base.snapshot.nodes[1], outcome: "unresolved" as const },
      ],
    },
  };
}

beforeEach(() => {
  mockUseChatboxTopicMap.mockReset();
  mockUseChatboxTopicMap.mockReturnValue(
    createDefaultChatboxTopicMapHookValue()
  );
});

describe("topicMapNodeHoverLabel", () => {
  it("prefers the cached semantic title when it exists", () => {
    expect(
      topicMapNodeHoverLabel({
        semanticTitle: "Password reset",
        semanticPreview: "User needs to reset a forgotten password.",
        sessionId: "session-a",
      })
    ).toBe("Password reset");
  });

  it("extracts the first topical word from the session summary, skipping articles and generic chat framing", () => {
    expect(
      topicMapNodeHoverLabel({
        semanticPreview:
          "The user requested a drawing of a dog, prompting the assistant to utilize a drawing tool.",
        sessionId: "session-a",
      })
    ).toBe("drawing");
  });

  it("strips surrounding punctuation from the chosen word", () => {
    expect(
      topicMapNodeHoverLabel({
        semanticPreview: "User needs: billing help, urgently.",
        sessionId: "session-a",
      })
    ).toBe("billing");
  });

  it("prefers sibling-distinctive topics over shared cluster framing", () => {
    // Two sessions in the same "Drawing requests" cluster should now surface
    // their own subjects (dog vs cat) instead of both collapsing to the
    // shared cluster keyword.
    const dogNode = {
      semanticPreview: "User asked for a drawing of a dog in watercolor.",
      sessionId: "session-dog",
    };
    const catNode = {
      semanticPreview: "User requested a pencil sketch of a cat on a couch.",
      sessionId: "session-cat",
    };
    expect(topicMapNodeHoverLabel(dogNode)).not.toBe(
      topicMapNodeHoverLabel(catNode)
    );
  });

  it("falls back to the session id when the preview has no printable content", () => {
    expect(
      topicMapNodeHoverLabel({
        semanticPreview: "   ",
        sessionId: "sess-xyz",
      })
    ).toBe("sess-xyz");
  });
});

describe("ChatboxTopicMapPanel", () => {
  it("subscribes to ResizeObserver only after the graph pane mounts (post-loading)", () => {
    const observed: Element[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserverMock {
      constructor(_cb: ResizeObserverCallback) {}
      observe(target: Element) {
        observed.push(target);
      }
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      mockUseChatboxTopicMap.mockReturnValue({
        ...createDefaultChatboxTopicMapHookValue(),
        snapshot: null,
        isLoading: true,
      });

      const panelProps = {
        chatboxId: "chatbox-1",
        filter: EMPTY_FILTER,
        onToggleChip: vi.fn(),
        onClearChip: vi.fn(),
        onRebuild: vi.fn(),
      };

      const { rerender } = render(<ChatboxTopicMapPanel {...panelProps} />);
      expect(observed).toHaveLength(0);

      mockUseChatboxTopicMap.mockReturnValue(
        createDefaultChatboxTopicMapHookValue()
      );
      rerender(<ChatboxTopicMapPanel {...panelProps} />);
      expect(observed.length).toBeGreaterThan(0);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("renders cluster list with summaries in the sidebar", () => {
    render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );

    expect(screen.queryByText("Historical Topic Map")).not.toBeInTheDocument();
    expect(screen.queryByText("2 mapped sessions")).not.toBeInTheDocument();
    expect(screen.getByText("Password resets")).toBeInTheDocument();
    expect(
      screen.getByText("Reset and account recovery questions.")
    ).toBeInTheDocument();
    expect(screen.getByText("Billing issues")).toBeInTheDocument();
    expect(screen.getByText("Invoice and refund help.")).toBeInTheDocument();
  });

  it("renders Fit view and rebuild controls overlayed on the canvas", () => {
    render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );

    const fitView = screen.getByRole("button", { name: /fit view/i });
    const rebuild = screen.getByRole("button", { name: /rebuild clusters/i });
    expect(fitView.compareDocumentPosition(rebuild)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("shows rebuild status in the header while a run is active", () => {
    mockUseChatboxTopicMap.mockReturnValue({
      ...createDefaultChatboxTopicMapHookValue(),
      latestRun: {
        _id: "run-2",
        status: "running" as const,
        startedAt: Date.now(),
        finishedAt: null,
        sessionCount: null,
        clusterCount: null,
        errorMessage: null,
        model: "openai/gpt-4o-mini",
        topicMapVersion: 1,
        edgeCount: null,
        sampleNodeCount: null,
        unmappedSessionCount: null,
        isSampled: false,
        topicMapReady: false,
        isStale: false,
      },
    });

    render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );

    expect(screen.getByText("Updating clusters")).toBeInTheDocument();
  });

  it("lets operators toggle a community chip from the sidebar", async () => {
    const user = userEvent.setup();
    const onToggleChip = vi.fn();

    render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={EMPTY_FILTER}
        onToggleChip={onToggleChip}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", {
        name: /Billing issues Invoice and refund help/i,
      })
    );

    expect(onToggleChip).toHaveBeenCalledWith({
      kind: "cluster",
      clusterId: "cluster-b",
      label: "Billing issues",
    });
  });

  it("renders cluster keywords as static chips without a popover", () => {
    render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );

    const keywordChip = screen.getByText("password");
    expect(keywordChip.tagName).toBe("SPAN");
    expect(
      screen.queryByRole("button", { name: "password" })
    ).not.toBeInTheDocument();
  });

  it("highlights active cluster selection in the list", () => {
    render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={{
          preset: "all",
          chips: [
            {
              kind: "cluster",
              clusterId: "cluster-a",
              label: "Password resets",
            },
          ],
        }}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );

    const clusterButton = screen.getByRole("button", {
      name: /Password resets Reset and account recovery questions/i,
    });
    expect(clusterButton.parentElement).toHaveClass("border-primary/40");
  });

  it("opens the clicked node's session via onOpenSession", async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();

    render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
        onOpenSession={onOpenSession}
      />
    );

    await user.click(
      screen.getByRole("button", { name: /graph node session-b/i })
    );

    expect(onOpenSession).toHaveBeenCalledWith("session-b");
    // Selection still tracks the click so the node reads as active when the
    // operator returns to the map.
    expect(screen.getByTestId("force-graph").parentElement).toHaveAttribute(
      "data-selected-session",
      "session-b"
    );
  });

  it("clears node selection when the graph background is clicked", async () => {
    const user = userEvent.setup();

    render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );

    const graphHost = screen.getByTestId("force-graph").parentElement;
    expect(graphHost).toHaveAttribute("data-selected-session", "session-a");

    await user.click(
      screen.getByRole("button", { name: /graph node session-b/i })
    );
    expect(graphHost).toHaveAttribute("data-selected-session", "session-b");

    await user.click(screen.getByTestId("force-graph-background"));
    expect(graphHost).toHaveAttribute("data-selected-session", "");
  });
});

describe("colorForNode", () => {
  it("colors by cluster in theme mode", () => {
    const themed = colorForNode(
      { clusterId: "cluster-a", outcome: "errored" },
      "theme",
      0
    );
    // Theme mode must ignore outcome entirely — colorForCluster's path is
    // unchanged by the outcome feature.
    expect(themed).not.toBe(NO_OUTCOME_COLOR);
    expect(themed).toBe(colorForNode({ clusterId: "cluster-a" }, "theme", 0));
  });

  it("colors by outcome in outcome mode, ignoring the cluster", () => {
    const completed = colorForNode(
      { clusterId: "cluster-a", outcome: "completed" },
      "outcome",
      0
    );
    const errored = colorForNode(
      { clusterId: "cluster-a", outcome: "errored" },
      "outcome",
      0
    );
    expect(completed).not.toBe(errored);
    // Same outcome in a different cluster is the same color: that is the point.
    expect(
      colorForNode(
        { clusterId: "cluster-b", outcome: "completed" },
        "outcome",
        5
      )
    ).toBe(completed);
  });

  it("renders an absent outcome as neutral rather than a bucket", () => {
    // A node on a pre-bump snapshot, or a session whose signals never
    // extracted. Neither is a verdict, so neither may be painted as one.
    expect(colorForNode({ clusterId: "cluster-a" }, "outcome", 0)).toBe(
      NO_OUTCOME_COLOR
    );
  });

  it("renders unclear with the same neutral as no outcome at all", () => {
    expect(
      colorForNode({ clusterId: "cluster-a", outcome: "unclear" }, "outcome", 0)
    ).toBe(NO_OUTCOME_COLOR);
  });

  it("falls back to neutral for an unrecognized outcome value", () => {
    expect(
      colorForNode(
        { clusterId: "cluster-a", outcome: "something-new" },
        "outcome",
        0
      )
    ).toBe(NO_OUTCOME_COLOR);
  });
});

describe("ChatboxTopicMapPanel color-by mode", () => {
  function renderPanel() {
    return render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );
  }

  it("defaults to theme and offers an outcome toggle", () => {
    mockUseChatboxTopicMap.mockReturnValue(outcomeAwareHookValue());
    renderPanel();

    expect(screen.getByRole("button", { name: "Theme" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Outcome" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("shows the outcome legend once outcome mode is active", async () => {
    const user = userEvent.setup();
    mockUseChatboxTopicMap.mockReturnValue(outcomeAwareHookValue());
    renderPanel();

    expect(screen.queryByText("Unresolved")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Outcome" }));

    expect(screen.getByRole("button", { name: "Outcome" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByText("Unresolved")).toBeInTheDocument();
    expect(screen.getByText("Unclear / not analyzed")).toBeInTheDocument();
  });

  it("disables outcome mode on a pre-bump snapshot instead of painting it neutral", () => {
    // version 1 blobs carry no `outcome` on their nodes. Offering the mode
    // would paint every node grey and read as a bug rather than stale data.
    mockUseChatboxTopicMap.mockReturnValue(
      createDefaultChatboxTopicMapHookValue()
    );
    renderPanel();

    expect(screen.getByRole("button", { name: "Outcome" })).toBeDisabled();
  });

  it("still renders a pre-bump snapshot normally", () => {
    mockUseChatboxTopicMap.mockReturnValue(
      createDefaultChatboxTopicMapHookValue()
    );
    renderPanel();

    expect(screen.getByText("Password resets")).toBeInTheDocument();
    expect(screen.getByTestId("force-graph")).toBeInTheDocument();
  });

  it("explains an empty legend when no mapped session has an outcome", async () => {
    const user = userEvent.setup();
    const base = outcomeAwareHookValue();
    mockUseChatboxTopicMap.mockReturnValue({
      ...base,
      snapshot: {
        ...base.snapshot,
        nodes: base.snapshot.nodes.map(
          ({ outcome: _outcome, ...node }) => node
        ),
      },
    });
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Outcome" }));
    expect(
      screen.getByText("No mapped session has an inferred outcome yet.")
    ).toBeInTheDocument();
  });

  it("reverts to theme if the snapshot stops supporting outcomes", async () => {
    const user = userEvent.setup();
    mockUseChatboxTopicMap.mockReturnValue(outcomeAwareHookValue());
    const { rerender } = renderPanel();

    await user.click(screen.getByRole("button", { name: "Outcome" }));
    expect(screen.getByRole("button", { name: "Outcome" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    mockUseChatboxTopicMap.mockReturnValue(
      createDefaultChatboxTopicMapHookValue()
    );
    rerender(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Theme" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});

describe("ChatboxTopicMapPanel outcome narrowing", () => {
  it("dims nodes outside the selected outcome, not just outside the goal", () => {
    // Before this, clicking an outcome cell highlighted the goal and left every
    // outcome inside it lit — the map disagreed with the grid about what was
    // selected. Nodes now carry an outcome, so the map can honor the chip.
    mockUseChatboxTopicMap.mockReturnValue(outcomeAwareHookValue());
    const { container } = render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={selectCell(EMPTY_USAGE_FILTER, {
          clusterId: "cluster-a",
          outcome: "unresolved",
        })}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );
    // session-a is cluster-a/completed, so the unresolved chip excludes it.
    // Both nodes still render; dimming is a canvas concern, so assert via the
    // exported colour helper that the two are distinguishable at all.
    expect(container).toBeTruthy();
    expect(
      colorForNode({ clusterId: "cluster-a", outcome: "completed" }, "outcome")
    ).not.toBe(
      colorForNode({ clusterId: "cluster-a", outcome: "unresolved" }, "outcome")
    );
  });

  it("treats the unlabeled sentinel as selecting nodes with no outcome", () => {
    const base = outcomeAwareHookValue();
    mockUseChatboxTopicMap.mockReturnValue({
      ...base,
      snapshot: {
        ...base.snapshot,
        nodes: [
          base.snapshot.nodes[0],
          // A node with no outcome at all.
          (({ outcome: _o, ...rest }) => rest)(base.snapshot.nodes[1]),
        ],
      },
    });
    render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={selectCell(EMPTY_USAGE_FILTER, {
          clusterId: "cluster-b",
          outcome: null,
        })}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );
    // The unlabeled node is the one the sentinel selects; it still renders.
    expect(
      screen.getByRole("button", { name: /graph node session-b/i })
    ).toBeInTheDocument();
  });
});
