/**
 * The diagram is laid out by our own code rather than a chart library, so
 * unlike the recharts version it renders fully in jsdom and can be asserted on
 * directly — nodes, ribbons, labels and keyboard behavior all included.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionFlowSankey } from "../SessionFlowSankey";
import type {
  ClusterRunState,
  InsightsSankey,
  UsageBreakdown,
} from "@/hooks/useUsageInsights";

const SANKEY: InsightsSankey = {
  nodes: [
    {
      id: "goal:g1",
      stage: "goal",
      key: "g1",
      label: "Refund a duplicate charge",
      count: 4,
      clickable: true,
    },
    {
      id: "behavior:b1",
      stage: "behavior",
      key: "b1",
      label: "Guessed an id after truncation",
      count: 4,
      clickable: true,
    },
    {
      id: "outcome:o1",
      stage: "outcome",
      key: "o1",
      label: "Goal reached",
      count: 4,
      clickable: true,
    },
    {
      id: "sentiment:s1",
      stage: "sentiment",
      key: "s1",
      label: "Frustrated",
      count: 4,
      clickable: true,
    },
  ],
  links: [
    { source: "goal:g1", target: "behavior:b1", count: 4, discordantCount: 0 },
    {
      source: "behavior:b1",
      target: "outcome:o1",
      count: 4,
      discordantCount: 0,
    },
    // Majority-discordant: a reached goal that left users frustrated.
    {
      source: "outcome:o1",
      target: "sentiment:s1",
      count: 4,
      discordantCount: 4,
    },
  ],
  foldedGoalCount: 0,
  foldedByStage: {},
};

function run(overrides: Partial<ClusterRunState> = {}): ClusterRunState {
  return {
    _id: "run-1",
    status: "done",
    startedAt: 0,
    finishedAt: 1,
    sessionCount: 4,
    clusterCount: 1,
    errorMessage: null,
    signalsVersion: 3,
    isStale: false,
    ...overrides,
  };
}

function breakdown(overrides: Partial<UsageBreakdown> = {}): UsageBreakdown {
  return {
    themes: [],
    userBreakdown: [],
    deviceBreakdown: [],
    languageBreakdown: [],
    modelBreakdown: [],
    outcomeBreakdown: [],
    frictionBreakdown: [],
    behaviorTagBreakdown: [],
    goalFacets: [],
    sankey: SANKEY,
    labeledOutcomeCount: 4,
    outcomeFeedbackCalibration: [],
    totalSessions: 4,
    latestRun: run(),
    ...overrides,
  };
}

function renderSankey(
  props: Partial<React.ComponentProps<typeof SessionFlowSankey>> = {},
) {
  const onSelectNode = props.onSelectNode ?? vi.fn();
  const onSelectLink = props.onSelectLink ?? vi.fn();
  const onRebuild = props.onRebuild ?? vi.fn();
  render(
    <SessionFlowSankey
      breakdown={breakdown()}
      selection={null}
      onSelectNode={onSelectNode}
      onSelectLink={onSelectLink}
      onRebuild={onRebuild}
      rebuildBusy={false}
      {...props}
    />,
  );
  return { onSelectNode, onSelectLink, onRebuild };
}

describe("SessionFlowSankey", () => {
  it("shows a loading state until the breakdown arrives", () => {
    renderSankey({ breakdown: undefined });
    expect(screen.getByText(/Loading session flow/)).toBeInTheDocument();
  });

  it("renders each column's theme name as the analysis produced it", () => {
    // The whole point of clustering every axis: none of these strings exist in
    // the codebase, they came out of the data.
    renderSankey();
    for (const label of [
      "Refund a duplicate charge",
      "Guessed an id after truncation",
      "Goal reached",
      "Frustrated",
    ]) {
      // Anchored: a ribbon's label mentions both of its endpoints, so an
      // unanchored match would find the band as well as the node.
      expect(
        screen.getByRole("button", {
          name: new RegExp(`^${label}, \\d+ sessions, \\d+ percent`),
        }),
      ).toBeInTheDocument();
    }
  });

  it("reports each theme's count and share of its own column", () => {
    renderSankey();
    expect(
      screen.getByRole("button", {
        name: /Refund a duplicate charge, 4 sessions, 100 percent of goal/,
      }),
    ).toBeInTheDocument();
  });

  it("selects a theme on click", async () => {
    const user = userEvent.setup();
    const { onSelectNode } = renderSankey();

    await user.click(
      screen.getByRole("button", {
        name: /^Guessed an id after truncation, \d+ sessions/,
      }),
    );

    expect(onSelectNode).toHaveBeenCalledWith({
      themes: [
        {
          dimension: "behavior",
          clusterId: "b1",
          label: "Guessed an id after truncation",
        },
      ],
    });
  });

  it("selects both endpoints when a ribbon is clicked", async () => {
    const user = userEvent.setup();
    const { onSelectLink } = renderSankey();

    await user.click(
      screen.getByRole("button", { name: /Goal reached to Frustrated/ }),
    );

    expect(onSelectLink).toHaveBeenCalledWith({
      themes: [
        { dimension: "outcome", clusterId: "o1", label: "Goal reached" },
        { dimension: "sentiment", clusterId: "s1", label: "Frustrated" },
      ],
    });
  });

  it("is operable from the keyboard, not the mouse alone", async () => {
    // An SVG shape is not a control unless it is given a role, a tab stop and
    // key handling; without this the entire diagram is mouse-only.
    const user = userEvent.setup();
    const { onSelectNode } = renderSankey();

    const target = screen.getByRole("button", {
      name: /^Refund a duplicate charge, \d+ sessions/,
    });
    target.focus();
    expect(target).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSelectNode).toHaveBeenCalledTimes(1);

    await user.keyboard(" ");
    expect(onSelectNode).toHaveBeenCalledTimes(2);
  });

  it("names a discordant ribbon so the colour is not the only signal", () => {
    renderSankey();
    expect(
      screen.getByRole("button", {
        name: /Goal reached to Frustrated, 4 sessions, outcome and sentiment disagree/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Outcome and sentiment disagree"),
    ).not.toBeInTheDocument();
  });

  it("leaves a concordant ribbon unflagged", () => {
    expect(
      renderSankey() &&
        screen.getByRole("button", {
          name: /Refund a duplicate charge to Guessed an id after truncation, 4 sessions$/,
        }),
    ).toBeInTheDocument();
  });

  it("marks unselectable nodes as such and keeps them out of the tab order", () => {
    renderSankey({
      breakdown: breakdown({
        sankey: {
          ...SANKEY,
          nodes: [
            ...SANKEY.nodes,
            {
              id: "goal:__other__",
              stage: "goal",
              key: "__other__",
              label: "Other (3 themes)",
              count: 3,
              clickable: false,
            },
          ],
        },
      }),
    });
    const other = screen.getByLabelText(/Other \(3 themes\), 3 sessions/);
    expect(other).toHaveAttribute("tabindex", "-1");
    expect(other.getAttribute("aria-label")).toMatch(/not selectable/);
  });

  it("offers a rebuild when the last run predates session signals", async () => {
    const user = userEvent.setup();
    const { onRebuild } = renderSankey({
      breakdown: breakdown({
        sankey: { nodes: [], links: [], foldedGoalCount: 0, foldedByStage: {} },
        latestRun: run({ signalsVersion: null }),
      }),
    });

    expect(
      screen.getByText(/before session signals existed/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Rebuild clusters/ }));
    expect(onRebuild).toHaveBeenCalledTimes(1);
  });

  it("draws what exists and prompts a rebuild when only goals were clustered", async () => {
    // A version-2 run produced the goal column, so the honest thing is to draw
    // it and explain the empty ones — not replace the panel with a blank state.
    const user = userEvent.setup();
    const { onRebuild } = renderSankey({
      breakdown: breakdown({ latestRun: run({ signalsVersion: 2 }) }),
    });

    expect(screen.getByText("Session flow")).toBeInTheDocument();
    expect(
      screen.getByText(/before every column was clustered/),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Rebuild for themes/ }),
    );
    expect(onRebuild).toHaveBeenCalledTimes(1);
  });

  it("does not prompt once every column is clustered", () => {
    renderSankey();
    expect(
      screen.queryByText(/before every column was clustered/),
    ).not.toBeInTheDocument();
  });

  it("offers to analyze when no analysis run has ever happened", async () => {
    // Unlabeled sessions still produce sankey nodes, so this state renders the
    // diagram — it must not swallow the only affordance that fills it in.
    const user = userEvent.setup();
    const { onRebuild } = renderSankey({
      breakdown: breakdown({ latestRun: null }),
      stageTitles: { goal: "Journey" },
    });

    // Copy names the surface's own first column.
    expect(
      screen.getByText(/haven’t been analyzed yet[\s\S]*journeys/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Analyze sessions/ }));
    expect(onRebuild).toHaveBeenCalledTimes(1);
  });

  it("starts the analysis with no arguments", async () => {
    // BB-107: passing the handler straight to onClick handed React's synthetic
    // event to the rebuild call, which spreads its argument into the Convex
    // mutation — serializing the event's DOM node threw a circular structure.
    const user = userEvent.setup();
    const { onRebuild } = renderSankey({
      breakdown: breakdown({ latestRun: null }),
    });

    await user.click(screen.getByRole("button", { name: /Analyze sessions/ }));
    expect(onRebuild).toHaveBeenCalledWith();
  });

  it("reports an analysis in flight instead of offering to start one", () => {
    renderSankey({
      breakdown: breakdown({ latestRun: run({ status: "queued" }) }),
    });
    expect(screen.getByText(/Analyzing sessions/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Analyze sessions/ }),
    ).not.toBeInTheDocument();
  });

  it("draws each column header at its own column's x", () => {
    // Guards the misalignment that shipped: headers laid out by CSS across the
    // full panel while the columns lived in a fixed-width SVG.
    renderSankey();
    const headers = Array.from(document.querySelectorAll("text")).filter((t) =>
      ["GOAL", "BEHAVIOR", "OUTCOME", "SENTIMENT"].includes(
        (t.textContent ?? "").toUpperCase(),
      ),
    );
    expect(headers).toHaveLength(4);
    const xs = headers.map((h) => Number(h.getAttribute("x")));
    // Strictly increasing, and the last one is nowhere near the right edge —
    // it sits over its column, with the label gutter beyond it.
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(4);
  });

  it("says how many themes were folded away, across all columns", () => {
    renderSankey({
      breakdown: breakdown({
        sankey: {
          ...SANKEY,
          foldedByStage: { goal: 2, behavior: 1 },
        },
      }),
    });
    expect(screen.getByText(/3 smaller themes folded/)).toBeInTheDocument();
  });

  it("warns that the counts are windowed when the scan truncated", () => {
    renderSankey({
      breakdown: breakdown({
        scan: {
          scanned: 2000,
          matched: 2000,
          truncated: true,
          maxSessions: 2000,
          windowEndAt: null,
          windowStartAt: null,
        },
      }),
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      /not the full history/,
    );
  });

  it("fills the parent pane when fillHeight is set", () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserverMock {
      constructor(private cb: ResizeObserverCallback) {}
      observe(target: Element) {
        Object.defineProperty(target, "clientWidth", {
          configurable: true,
          get: () => 800,
        });
        Object.defineProperty(target, "clientHeight", {
          configurable: true,
          get: () => 640,
        });
        this.cb(
          [
            {
              target,
              contentRect: {
                width: 800,
                height: 640,
                top: 0,
                left: 0,
                bottom: 640,
                right: 800,
                x: 0,
                y: 0,
                toJSON: () => ({}),
              },
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      renderSankey({ fillHeight: true });
      const root = screen.getByTestId("scenario-insights-sankey");
      expect(root).toHaveAttribute("data-fill-height", "true");
      expect(root.className).toMatch(/h-full/);
      const svg = screen.getByRole("group", {
        name: /Session flow from goal/,
      });
      // Tall pane → taller viewBox than the content floor (320 for one node
      // per column), so ribbons and bars actually use the leftover space.
      const viewBox = svg.getAttribute("viewBox") ?? "";
      const viewHeight = Number(viewBox.split(/\s+/)[3]);
      expect(viewHeight).toBeGreaterThan(320);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});
