import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TopicMapPanel,
  NO_OUTCOME_COLOR,
  colorForNode,
  topicMapNodeHoverLabel,
} from "../TopicMapPanel";
import {
  EMPTY_USAGE_FILTER,
  UNLABELED_OUTCOME,
  type UsageFilterState,
} from "@/hooks/scenario-usage-filters";

const { mockUseScenarioTopicMap, graphDataFrames } = vi.hoisted(() => ({
  mockUseScenarioTopicMap: vi.fn(),
  /** Every `graphData` object handed to the force graph, in render order. */
  graphDataFrames: [] as Array<{ nodes?: Array<{ id: string }> }>,
}));

/**
 * Minimal 2D-context stub that records every `globalAlpha` assignment.
 *
 * Dimming is a canvas concern — `drawNode` expresses it as
 * `ctx.globalAlpha = dimmed ? 0.16 : 1` — so it is invisible to the DOM unless
 * the mock actually runs the draw callback. Without this, a test can only assert
 * that nodes render at all, which stays green even if filtering is deleted.
 */
function makeRecordingCtx() {
  const alphas: number[] = [];
  const fills: string[] = [];
  const gradientStops: string[] = [];
  const noop = () => {};
  const ctx = {
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    arc: noop,
    arcTo: noop,
    moveTo: noop,
    lineTo: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    fillText: noop,
    measureText: () => ({ width: 10 }),
    createRadialGradient: () => ({
      addColorStop: (_offset: number, color: string) => {
        gradientStops.push(color);
      },
    }),
    globalCompositeOperation: "",
    shadowColor: "",
    shadowBlur: 0,
    // Recorded like globalAlpha: the node's paint colour is a canvas concern,
    // so the only way a test can see which colour a mode painted is to keep
    // every assignment.
    set fillStyle(value: string) {
      fills.push(value);
    },
    get fillStyle() {
      return fills[fills.length - 1] ?? "";
    },
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    set globalAlpha(value: number) {
      alphas.push(value);
    },
    get globalAlpha() {
      return alphas[alphas.length - 1] ?? 1;
    },
  };
  return { ctx, alphas, fills, gradientStops };
}

vi.mock("react-force-graph-2d", async () => {
  const React = await import("react");
  return {
    default: React.forwardRef(function MockForceGraph2D(
      props: {
        graphData?: { nodes?: Array<{ id: string }> };
        nodeCanvasObject?: (
          node: unknown,
          ctx: unknown,
          globalScale: number
        ) => void;
        onRenderFramePre?: (ctx: unknown) => void;
        onNodeClick?: (node: { id: string }) => void;
        onBackgroundClick?: () => void;
      },
      ref
    ) {
      React.useImperativeHandle(ref, () => ({
        zoomToFit: vi.fn(),
      }));
      if (props.graphData) graphDataFrames.push(props.graphData);
      // Halos are drawn in onRenderFramePre as radial gradients; record their
      // colour stops so "what colour is this cluster's halo" is assertable.
      const frame = makeRecordingCtx();
      try {
        props.onRenderFramePre?.(frame.ctx);
      } catch {
        // Ignore: halo drawing must not mask the node assertions.
      }
      return (
        <div
          data-testid="force-graph"
          data-halo-colors={frame.gradientStops.join("|")}
        >
          <button
            type="button"
            data-testid="force-graph-background"
            onClick={() => props.onBackgroundClick?.()}
          >
            Graph background
          </button>
          {(props.graphData?.nodes ?? []).map((node) => {
            // Run the real draw callback against a recording context so each
            // node's dimmed state becomes assertable from the DOM. The first
            // globalAlpha write is the dim decision.
            const { ctx, alphas, fills } = makeRecordingCtx();
            try {
              props.nodeCanvasObject?.(node, ctx, 1);
            } catch {
              // A draw failure must not silently mask the other assertions.
            }
            return (
              <button
                key={node.id}
                type="button"
                data-node-alpha={String(alphas[0] ?? 1)}
                data-node-fills={fills.join("|")}
                onClick={() => props.onNodeClick?.(node)}
              >
                Graph node {node.id}
              </button>
            );
          })}
        </div>
      );
    }),
  };
});

/** Colours the halo gradients were painted with this render. */
function haloColors(): string[] {
  return (
    (screen.getByTestId("force-graph").getAttribute("data-halo-colors") ?? "")
      // "|" and not "," — a colour string like "rgba(251, 113, 133, 0.08)" has
      // commas in it, so splitting on those shreds each stop into fragments.
      .split("|")
      .filter(Boolean)
  );
}

/**
 * A hex colour as `hexToRgba` renders its channels: "#4ade80" -> "74, 222, 128".
 * Halo gradients carry decimal rgba(), so hex substrings never match them.
 */
function rgbTriple(hex: string): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `${red}, ${green}, ${blue}`;
}

/** Every colour the mock recorded this node being filled with. */
function nodeFills(sessionId: string): string[] {
  return (
    screen
      .getByRole("button", {
        name: new RegExp(`graph node ${sessionId}`, "i"),
      })
      .getAttribute("data-node-fills") ?? ""
  )
    .split("|")
    .filter(Boolean);
}

/** True when the mock recorded this node as drawn dimmed. */
function isNodeDimmed(sessionId: string): boolean {
  const node = screen.getByRole("button", {
    name: new RegExp(`graph node ${sessionId}`, "i"),
  });
  return Number(node.getAttribute("data-node-alpha")) < 1;
}

vi.mock("@/hooks/useScenarioTopicMap", () => ({
  useTopicMap: (...args: unknown[]) => mockUseScenarioTopicMap(...args),
  useScenarioTopicMap: (...args: unknown[]) => mockUseScenarioTopicMap(...args),
  topicMapScopeFromInsights: (scope: { kind: string; scenarioId?: string; projectId?: string } | null) =>
    scope
      ? scope.kind === "swarm"
        ? { kind: "swarm", projectId: scope.projectId }
        : { kind: "scenario", scenarioId: scope.scenarioId }
      : null,
}));

const EMPTY_FILTER: UsageFilterState = {
  preset: "all",
  chips: [],
};

const SNAPSHOT = {
  version: 1,
  scenarioId: "scenario-1",
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

function createDefaultScenarioTopicMapHookValue() {
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
  const base = createDefaultScenarioTopicMapHookValue();
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
  graphDataFrames.length = 0;
  mockUseScenarioTopicMap.mockReset();
  mockUseScenarioTopicMap.mockReturnValue(
    createDefaultScenarioTopicMapHookValue()
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

describe("TopicMapPanel", () => {
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
      mockUseScenarioTopicMap.mockReturnValue({
        ...createDefaultScenarioTopicMapHookValue(),
        snapshot: null,
        isLoading: true,
      });

      const panelProps = {
        scenarioId: "scenario-1",
        filter: EMPTY_FILTER,
        onToggleChip: vi.fn(),
        onClearChip: vi.fn(),
        onRebuild: vi.fn(),
      };

      const { rerender } = render(<TopicMapPanel {...panelProps} />);
      expect(observed).toHaveLength(0);

      mockUseScenarioTopicMap.mockReturnValue(
        createDefaultScenarioTopicMapHookValue()
      );
      rerender(<TopicMapPanel {...panelProps} />);
      expect(observed.length).toBeGreaterThan(0);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  // The cooperative-wheel listener lives on the graph wrapper, which only
  // mounts once a snapshot exists. Data almost always arrives after the first
  // render, so an effect that read the wrapper once (before the loading branch
  // resolved) would leave a bare wheel to d3-zoom and re-trap the page scroll.
  describe("cooperative wheel zoom", () => {
    const panelProps = {
      scenarioId: "scenario-1",
      filter: EMPTY_FILTER,
      onToggleChip: vi.fn(),
      onClearChip: vi.fn(),
      onRebuild: vi.fn(),
      cooperativeWheelZoom: true,
    };

    /** Dispatch a wheel on the canvas and report whether it reached it. */
    function wheelReachesCanvas(init: WheelEventInit = {}) {
      const canvas = screen.getByTestId("force-graph");
      let reached = false;
      const onWheel = () => {
        reached = true;
      };
      canvas.addEventListener("wheel", onWheel);
      try {
        canvas.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init })
        );
      } finally {
        canvas.removeEventListener("wheel", onWheel);
      }
      return reached;
    }

    function renderThenLoad(props = panelProps) {
      mockUseScenarioTopicMap.mockReturnValue({
        ...createDefaultScenarioTopicMapHookValue(),
        snapshot: null,
        isLoading: true,
      });
      const view = render(<TopicMapPanel {...props} />);
      expect(screen.queryByTestId("force-graph")).toBeNull();

      mockUseScenarioTopicMap.mockReturnValue(
        createDefaultScenarioTopicMapHookValue()
      );
      view.rerender(<TopicMapPanel {...props} />);
      return view;
    }

    it("blocks a bare wheel once the graph mounts after loading", () => {
      renderThenLoad();
      expect(wheelReachesCanvas()).toBe(false);
    });

    it("lets a Ctrl/Cmd wheel (and trackpad pinch) through to zoom", () => {
      renderThenLoad();
      expect(wheelReachesCanvas({ ctrlKey: true })).toBe(true);
      expect(wheelReachesCanvas({ metaKey: true })).toBe(true);
    });

    it("removes the listener when the pane stops owning a scrolling page", () => {
      const view = renderThenLoad();
      view.rerender(
        <TopicMapPanel {...panelProps} cooperativeWheelZoom={false} />
      );
      expect(wheelReachesCanvas()).toBe(true);
    });

    it("leaves the wheel alone in the default (viewport-locked) layout", () => {
      renderThenLoad({ ...panelProps, cooperativeWheelZoom: false });
      expect(wheelReachesCanvas()).toBe(true);
    });
  });

  it("renders cluster list with summaries in the sidebar", () => {
    render(
      <TopicMapPanel
        scope={{ kind: "scenario", scenarioId: "scenario-1" }}
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
      <TopicMapPanel
        scope={{ kind: "scenario", scenarioId: "scenario-1" }}
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
    mockUseScenarioTopicMap.mockReturnValue({
      ...createDefaultScenarioTopicMapHookValue(),
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
      <TopicMapPanel
        scope={{ kind: "scenario", scenarioId: "scenario-1" }}
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
      <TopicMapPanel
        scope={{ kind: "scenario", scenarioId: "scenario-1" }}
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
      <TopicMapPanel
        scope={{ kind: "scenario", scenarioId: "scenario-1" }}
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
      <TopicMapPanel
        scope={{ kind: "scenario", scenarioId: "scenario-1" }}
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
      <TopicMapPanel
        scope={{ kind: "scenario", scenarioId: "scenario-1" }}
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
      <TopicMapPanel
        scope={{ kind: "scenario", scenarioId: "scenario-1" }}
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

  it("renders unclear as its own tint, not the missing-outcome grey", () => {
    const unclear = colorForNode(
      { clusterId: "cluster-a", outcome: "unclear" },
      "outcome",
      0
    );
    expect(unclear).not.toBe(NO_OUTCOME_COLOR);
    expect(unclear).toBe(
      colorForNode({ clusterId: "cluster-b", outcome: "unclear" }, "outcome", 5)
    );
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

describe("TopicMapPanel color-by mode", () => {
  function renderPanel() {
    return render(
      <TopicMapPanel
        scope={{ kind: "scenario", scenarioId: "scenario-1" }}
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );
  }

  it("defaults to theme and offers an outcome toggle", () => {
    mockUseScenarioTopicMap.mockReturnValue(outcomeAwareHookValue());
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
    mockUseScenarioTopicMap.mockReturnValue(outcomeAwareHookValue());
    renderPanel();

    expect(screen.queryByText("Unresolved")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Outcome" }));

    expect(screen.getByRole("button", { name: "Outcome" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByText("Unresolved")).toBeInTheDocument();
    expect(screen.getByText("Unclear")).toBeInTheDocument();
    expect(screen.getByText("Not analyzed")).toBeInTheDocument();
  });

  it("disables outcome mode on a pre-bump snapshot instead of painting it neutral", () => {
    // version 1 blobs carry no `outcome` on their nodes. Offering the mode
    // would paint every node grey and read as a bug rather than stale data.
    mockUseScenarioTopicMap.mockReturnValue(
      createDefaultScenarioTopicMapHookValue()
    );
    renderPanel();

    expect(screen.getByRole("button", { name: "Outcome" })).toBeDisabled();
  });

  it("still renders a pre-bump snapshot normally", () => {
    mockUseScenarioTopicMap.mockReturnValue(
      createDefaultScenarioTopicMapHookValue()
    );
    renderPanel();

    expect(screen.getByText("Password resets")).toBeInTheDocument();
    expect(screen.getByTestId("force-graph")).toBeInTheDocument();
  });

  it("explains an empty legend when no mapped session has an outcome", async () => {
    const user = userEvent.setup();
    const base = outcomeAwareHookValue();
    mockUseScenarioTopicMap.mockReturnValue({
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

  it("repaints the same nodes in place instead of restarting the layout", async () => {
    // The reported "canvas bounce": force-graph owns the node objects and
    // mutates x/y on them as the simulation settles, so handing it a fresh
    // array re-seeds every position and reheats. Baking the colour onto the
    // nodes did exactly that on every mode flip. Asserting node object
    // IDENTITY across the toggle is what pins the fix — a colour assertion
    // alone stays green however many times the layout is thrown away.
    const user = userEvent.setup();
    mockUseScenarioTopicMap.mockReturnValue(outcomeAwareHookValue());
    renderPanel();

    const beforeNodes = graphDataFrames[graphDataFrames.length - 1]?.nodes;
    const beforeFills = nodeFills("session-a");

    await user.click(screen.getByRole("button", { name: "Outcome" }));

    const afterNodes = graphDataFrames[graphDataFrames.length - 1]?.nodes;
    expect(afterNodes).toBe(beforeNodes);
    expect(afterNodes?.[0]).toBe(beforeNodes?.[0]);
    // ...and the repaint still happened: session-a is `completed`, whose
    // outcome colour differs from its cluster colour.
    const completed = colorForNode(
      { clusterId: "cluster-a", outcome: "completed" },
      "outcome"
    );
    expect(completed).not.toBe(
      colorForNode({ clusterId: "cluster-a" }, "theme", 0)
    );
    expect(beforeFills).not.toContain(completed);
    expect(nodeFills("session-a")).toContain(completed);
  });

  it("reverts to theme if the snapshot stops supporting outcomes", async () => {
    const user = userEvent.setup();
    mockUseScenarioTopicMap.mockReturnValue(outcomeAwareHookValue());
    const { rerender } = renderPanel();

    await user.click(screen.getByRole("button", { name: "Outcome" }));
    expect(screen.getByRole("button", { name: "Outcome" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    mockUseScenarioTopicMap.mockReturnValue(
      createDefaultScenarioTopicMapHookValue()
    );
    rerender(
      <TopicMapPanel
        scope={{ kind: "scenario", scenarioId: "scenario-1" }}
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

/**
 * The map narrows by a goal cluster chip plus the outcome ENUM chip — the state
 * layer, not the emergent outcome theme. Built here directly rather than via
 * the flow's selection helpers, which now speak themes.
 */
function goalOutcomeFilter(
  clusterId: string,
  outcome: string | null
): UsageFilterState {
  return {
    preset: "all",
    chips: [
      { kind: "cluster", clusterId, dimension: "goal" },
      {
        kind: "dimension",
        key: "outcome",
        value: outcome ?? UNLABELED_OUTCOME,
      },
    ],
  };
}

describe("TopicMapPanel outcome narrowing", () => {
  function renderWithFilter(filter: UsageFilterState) {
    return render(
      <TopicMapPanel
        scope={{ kind: "scenario", scenarioId: "scenario-1" }}
        filter={filter}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );
  }

  it("dims nodes outside the selected outcome, not just outside the goal", () => {
    // session-a is cluster-a/completed; session-b is cluster-b/unresolved.
    // Selecting cluster-a/unresolved must leave NOTHING lit in cluster-a —
    // previously the goal chip lit every outcome inside it.
    mockUseScenarioTopicMap.mockReturnValue(outcomeAwareHookValue());
    renderWithFilter(goalOutcomeFilter("cluster-a", "unresolved"));
    expect(isNodeDimmed("session-a")).toBe(true);
    expect(isNodeDimmed("session-b")).toBe(true);
  });

  it("leaves the matching node lit", () => {
    mockUseScenarioTopicMap.mockReturnValue(outcomeAwareHookValue());
    renderWithFilter(goalOutcomeFilter("cluster-a", "completed"));
    expect(isNodeDimmed("session-a")).toBe(false);
    // Different goal AND different outcome.
    expect(isNodeDimmed("session-b")).toBe(true);
  });

  it("dims nothing when nothing is selected", () => {
    mockUseScenarioTopicMap.mockReturnValue(outcomeAwareHookValue());
    renderWithFilter(EMPTY_USAGE_FILTER);
    expect(isNodeDimmed("session-a")).toBe(false);
    expect(isNodeDimmed("session-b")).toBe(false);
  });

  it("selects nodes with no outcome for the unlabeled sentinel", () => {
    const base = outcomeAwareHookValue();
    mockUseScenarioTopicMap.mockReturnValue({
      ...base,
      snapshot: {
        ...base.snapshot,
        nodes: [
          base.snapshot.nodes[0],
          // session-b carries no outcome at all.
          (({ outcome: _outcome, ...rest }) => rest)(base.snapshot.nodes[1]),
        ],
      },
    });
    renderWithFilter(goalOutcomeFilter("cluster-b", null));
    // The unanalyzed node in the selected goal is the one that stays lit.
    expect(isNodeDimmed("session-b")).toBe(false);
    expect(isNodeDimmed("session-a")).toBe(true);
  });

  it("does not dim the whole map on a pre-bump snapshot", () => {
    // A v1 snapshot has no outcome on any node, so a concrete outcome chip
    // would match nothing and blank the canvas — which reads as a broken map
    // rather than as stale data. The snapshot cannot honor the constraint, so
    // it is exempt from it; the cluster chip still narrows.
    mockUseScenarioTopicMap.mockReturnValue(
      createDefaultScenarioTopicMapHookValue()
    );
    renderWithFilter(goalOutcomeFilter("cluster-a", "unresolved"));
    expect(isNodeDimmed("session-a")).toBe(false);
    // The cluster constraint is still applied.
    expect(isNodeDimmed("session-b")).toBe(true);
  });
});

describe("TopicMapPanel cluster halos", () => {
  function renderPanel() {
    return render(
      <TopicMapPanel
        scope={{ kind: "scenario", scenarioId: "scenario-1" }}
        filter={EMPTY_USAGE_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );
  }

  it("paints theme-coloured halos only in theme mode", async () => {
    const user = userEvent.setup();
    mockUseScenarioTopicMap.mockReturnValue(outcomeAwareHookValue());
    renderPanel();

    const themeHalos = haloColors();
    expect(themeHalos.length).toBeGreaterThan(0);
    const themeRgb = rgbTriple(
      colorForNode({ clusterId: "cluster-a" }, "theme", 0)
    );
    expect(themeHalos.some((stop) => stop.includes(themeRgb))).toBe(true);

    await user.click(screen.getByRole("button", { name: "Outcome" }));
    expect(haloColors()).not.toEqual(themeHalos);
    expect(
      haloColors()
        .filter((stop) => !stop.startsWith("rgba(0,0,0"))
        .some((stop) => stop.includes(themeRgb))
    ).toBe(false);
  });

  it("does not paint an outcome colour into a halo", async () => {
    // Outcome-mode halos are a neutral grouping ring. A mixed-outcome cluster
    // must not pick one member's colour and assert it for the whole goal.
    const user = userEvent.setup();
    mockUseScenarioTopicMap.mockReturnValue(outcomeAwareHookValue());
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Outcome" }));

    const completed = colorForNode(
      { clusterId: "cluster-a", outcome: "completed" },
      "outcome"
    );
    const themeRgb = rgbTriple(
      colorForNode({ clusterId: "cluster-a" }, "theme", 0)
    );

    const stops = haloColors().filter((stop) => !stop.startsWith("rgba(0,0,0"));
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.some((stop) => stop.includes(themeRgb))).toBe(false);
    for (const stop of stops) {
      expect(stop).not.toContain(completed);
    }
  });
});

describe("TopicMapPanel wave filter", () => {
  it("hides nodes whose journeyRunId is outside the wave", () => {
    const base = createDefaultScenarioTopicMapHookValue();
    mockUseScenarioTopicMap.mockReturnValue({
      ...base,
      snapshot: {
        ...base.snapshot,
        projectId: "proj-1",
        nodes: [
          { ...base.snapshot.nodes[0], journeyRunId: "run-a" },
          { ...base.snapshot.nodes[1], journeyRunId: "run-b" },
        ],
      },
    });

    render(
      <TopicMapPanel
        scope={{ kind: "swarm", projectId: "proj-1" }}
        journeyRunIds={["run-a"]}
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: /graph node session-a/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /graph node session-b/i })
    ).toBeNull();
  });
});

describe("TopicMapPanel swarm empty / loading", () => {
  it("uses map copy and keeps headerActions while a swarm rebuild is running", () => {
    mockUseScenarioTopicMap.mockReturnValue({
      ...createDefaultScenarioTopicMapHookValue(),
      snapshot: null,
      isLoading: false,
      latestRun: {
        _id: "run-2",
        status: "running" as const,
        startedAt: Date.now(),
        finishedAt: null,
        sessionCount: 0,
        clusterCount: 0,
        errorMessage: null,
        topicMapReady: false,
        isStale: false,
      },
    });

    render(
      <TopicMapPanel
        scope={{ kind: "swarm", projectId: "proj-1" }}
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
        headerActions={
          <div data-testid="swarm-insights-view-toggle">toggle</div>
        }
      />,
    );

    expect(screen.getByText("Building cluster map")).toBeInTheDocument();
    expect(screen.queryByText("Building clusters")).toBeNull();
    expect(screen.getByTestId("swarm-insights-view-toggle")).toBeInTheDocument();
  });

  it("shows map-not-generated copy when done without a blob", () => {
    mockUseScenarioTopicMap.mockReturnValue({
      ...createDefaultScenarioTopicMapHookValue(),
      snapshot: null,
      isLoading: false,
      latestRun: {
        _id: "run-1",
        status: "done" as const,
        startedAt: 1,
        finishedAt: 2,
        sessionCount: 10,
        clusterCount: 3,
        errorMessage: null,
        topicMapReady: false,
        isStale: false,
      },
    });

    render(
      <TopicMapPanel
        scope={{ kind: "swarm", projectId: "proj-1" }}
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Cluster map not generated yet"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No clusters yet")).toBeNull();
  });
});

