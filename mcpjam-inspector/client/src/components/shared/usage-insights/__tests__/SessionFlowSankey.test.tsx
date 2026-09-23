/**
 * The diagram is laid out by our own code rather than a chart library, so
 * unlike the recharts version it renders fully in jsdom and can be asserted on
 * directly — nodes, ribbons, labels and keyboard behavior all included.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFlowSankey } from "../SessionFlowSankey";

// Analyze now is shown to members only; the check is a Convex query.
const member = vi.hoisted(() => ({ value: true as boolean | undefined }));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => member.value,
}));
beforeEach(() => {
  member.value = true;
});
import type {
  InsightsAnalysisSummary,
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

function analysis(
  overrides: Partial<InsightsAnalysisSummary> = {},
): InsightsAnalysisSummary {
  return {
    total: 4,
    analyzed: 4,
    pending: 0,
    running: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    awaitingTaxonomy: 0,
    unassigned: 0,
    staleAssignments: 0,
    projectionPending: 0,
    projectionFailed: 0,
    deferredUntil: null,
    lastAnalyzedAt: 1,
    failures: {},
    skips: {},
    sampled: false,
    taxonomies: [],
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
    analysis: analysis(),
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

  it("gives each question column its own hue instead of foreground black", () => {
    renderSankey({
      breakdown: breakdown({
        sankey: {
          ...SANKEY,
          stages: [
            { id: "goal", label: "Goal" },
            { id: "behavior", label: "Behavior" },
            { id: "outcome", label: "Outcome" },
            { id: "sentiment", label: "Sentiment" },
            {
              id: "question:q1",
              label: "Likeness",
              questionId: "q1",
              version: 1,
            },
            {
              id: "question:q2",
              label: "View",
              questionId: "q2",
              version: 1,
            },
          ],
          nodes: [
            ...SANKEY.nodes,
            {
              id: "question:q1:yes",
              stage: "question:q1",
              key: "yes",
              label: "Yes",
              count: 1,
              clickable: true,
              questionVersion: 1,
            },
            {
              id: "question:q2:yes",
              stage: "question:q2",
              key: "yes",
              label: "Yes",
              count: 1,
              clickable: true,
              questionVersion: 1,
            },
          ],
          links: [
            ...SANKEY.links,
            {
              source: "sentiment:s1",
              target: "question:q1:yes",
              count: 1,
              discordantCount: 0,
            },
            {
              source: "question:q1:yes",
              target: "question:q2:yes",
              count: 1,
              discordantCount: 0,
            },
          ],
        },
      }),
    });
    const fills = screen
      .getAllByRole("button", { name: /^Yes, 1 sessions/ })
      .map((node) => node.querySelector("rect")?.getAttribute("fill"));
    expect(fills).toHaveLength(2);
    expect(fills[0]).toBeTruthy();
    expect(fills[1]).toBeTruthy();
    expect(fills[0]).not.toBe(fills[1]);
    for (const fill of fills) {
      expect(fill).not.toMatch(/foreground|#000\b/);
    }
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
      breakdown: breakdown({ analysis: undefined }),
      stageTitles: { goal: "Journey" },
    });

    // Copy names the surface's own first column.
    expect(
      screen.getByText(/haven’t been analyzed yet[\s\S]*journeys/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Analyze sessions/ }));
    expect(onRebuild).toHaveBeenCalledTimes(1);
    // No arguments: wiring the callback straight to `onClick` handed it a
    // React synthetic event, which Convex could not serialize ("Converting
    // circular structure to JSON"), so analysis never started.
    expect(onRebuild.mock.calls[0]).toEqual([]);
  });

  it("calls unanswered question nodes analyzing while a run is in flight", () => {
    renderSankey({
      breakdown: breakdown({
        analysis: analysis({ pending: 1 }),
        sankey: {
          ...SANKEY,
          stages: [
            { id: "goal", label: "Goal" },
            { id: "behavior", label: "Behavior" },
            { id: "outcome", label: "Outcome" },
            { id: "sentiment", label: "Sentiment" },
            {
              id: "question:q1",
              label: "Likeness",
              questionId: "q1",
              version: 1,
            },
          ],
          nodes: [
            ...SANKEY.nodes,
            {
              id: "question:q1:__unanswered__",
              stage: "question:q1",
              key: "__unanswered__",
              label: "Not answered",
              count: 2,
              clickable: false,
            },
          ],
        },
      }),
    });
    expect(screen.getByText("Analyzing…")).toBeInTheDocument();
    expect(screen.queryByText("Not answered")).not.toBeInTheDocument();
  });

  it("reports an analysis in flight instead of offering to start one", () => {
    renderSankey({
      breakdown: breakdown({ analysis: analysis({ pending: 4 }) }),
    });
    expect(screen.getByText(/Analyzing 4 sessions/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Analyze sessions/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps offering to analyze on a surface that waits to be asked", () => {
    // The same state WITHOUT the promise. The benchmark diagram is the paid
    // one and deliberately waits, so the default must not change.
    renderSankey({ breakdown: breakdown({ analysis: undefined }) });
    expect(
      screen.getByRole("button", { name: /Analyze sessions/ }),
    ).toBeInTheDocument();
  });

  it("stops advertising a rebuild while one is already running", () => {
    // True on every surface, not just the self-analyzing ones: this branch
    // used to offer "Rebuild clusters" during a rebuild.
    renderSankey({
      breakdown: breakdown({
        sankey: { nodes: [], links: [], foldedGoalCount: 0, foldedByStage: {} },
        analysis: analysis({ running: 4 }),
      }),
    });

    expect(screen.getByText(/Analyzing 4 sessions/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Rebuild clusters/ }),
    ).not.toBeInTheDocument();
  });

  it("offers no voluntary rebuild on an empty flow a completed analysis produced", () => {
    // Voluntary re-analysis is gated off (#5277): analysis runs on its own as
    // sessions settle. Analyze now appears only where its reason can help,
    // and "analyzed, themes still coming" is not one of those.
    const onAnalyzeNow = vi.fn();
    const { onRebuild } = renderSankey({
      breakdown: breakdown({
        sankey: { nodes: [], links: [], foldedGoalCount: 0, foldedByStage: {} },
        analysis: analysis(),
      }),
      onAnalyzeNow,
    });

    expect(
      screen.getByText("Grouping sessions into themes"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Analyze now/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /rebuild clusters/i }),
    ).not.toBeInTheDocument();
    expect(onRebuild).not.toHaveBeenCalled();
  });

  /** One session, analyzed or not, with no theme yet: placeholders only. */
  const PLACEHOLDERS: InsightsSankey = {
    nodes: (["goal", "behavior", "outcome", "sentiment"] as const).map(
      (stage) => ({
        id: `${stage}:__analyzing__`,
        stage,
        key: "__analyzing__",
        label: "Analyzing",
        count: 1,
        clickable: false,
      }),
    ),
    links: [],
    foldedGoalCount: 0,
    foldedByStage: {},
  };

  it("says why a flow of placeholders is empty instead of drawing it (2026-09-22)", async () => {
    const user = userEvent.setup();
    const onAnalyzeNow = vi.fn();
    const soon = Date.now() + 2 * 60_000;
    renderSankey({
      breakdown: breakdown({
        sankey: PLACEHOLDERS,
        analysis: analysis({
          total: 1,
          analyzed: 0,
          owed: 1,
          pending: 1,
          nextAnalysisAt: soon,
        }),
      }),
      onAnalyzeNow,
    });

    expect(
      screen.queryByTestId("scenario-insights-sankey"),
    ).not.toBeInTheDocument();
    const status = screen.getByTestId("session-flow-status");
    expect(status).toHaveAttribute("data-status", "waiting");
    expect(status).toHaveTextContent("Waiting for the session to go quiet");
    // Not "Analyzing": nothing runs until the door opens.
    expect(screen.queryByText(/Analyzing/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Analyze now/ }));
    // No arguments: the rebuild path serializes whatever it is handed.
    expect(onAnalyzeNow.mock.calls).toEqual([[]]);
  });

  it("hides Analyze now from a reader who is not a member", () => {
    member.value = false;
    renderSankey({
      breakdown: breakdown({
        sankey: PLACEHOLDERS,
        analysis: analysis({ total: 1, analyzed: 0, owed: 1, pending: 1 }),
      }),
      onAnalyzeNow: vi.fn(),
    });
    expect(screen.getByTestId("session-flow-status")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Analyze now/ }),
    ).not.toBeInTheDocument();
  });

  it("names a guest-owned study's reason and offers nothing", () => {
    renderSankey({
      breakdown: breakdown({
        sankey: PLACEHOLDERS,
        analysis: analysis({
          total: 1,
          analyzed: 0,
          skipped: 1,
          skips: { guest_owned: 1 },
        }),
      }),
      onAnalyzeNow: vi.fn(),
    });
    expect(screen.getByTestId("session-flow-status")).toHaveTextContent(
      "Sign in to analyze sessions",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says a drawn flow is still waiting on a session, in one line", () => {
    renderSankey({
      breakdown: breakdown({
        analysis: analysis({ owed: 1, pending: 1 }),
      }),
    });
    expect(screen.getByTestId("scenario-insights-sankey")).toBeInTheDocument();
    expect(
      screen.getByText("Waiting for the session to go quiet"),
    ).toBeInTheDocument();
  });

  it("labels draft themes under the title", () => {
    renderSankey({
      breakdown: breakdown({
        analysis: analysis({
          themes: { reason: "draft", sessionsUntilStable: 7 },
        }),
      }),
    });
    expect(screen.getByTestId("session-flow-themes-note")).toHaveTextContent(
      "Early themes. They settle after 7 more sessions.",
    );
  });

  it("draws each column header at its own column's x", () => {
    // Guards the misalignment that shipped: headers laid out by CSS across the
    // full panel while the columns lived in a fixed-width SVG.
    renderSankey();
    const headers = screen.getByTestId("sankey-column-headers");
    const xs = Array.from(headers.querySelectorAll("[data-column-x]")).map(
      (node) => Number(node.getAttribute("data-column-x")),
    );
    expect(xs).toHaveLength(4);
    // Strictly increasing, and the last one is nowhere near the right edge —
    // it sits over its column, with the label gutter beyond it.
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(4);
  });

  it("keeps the Session flow header outside the scrolling chart pane", () => {
    renderSankey({ scrollLayout: true });
    const flowHeader = screen.getByTestId("sankey-flow-header");
    const headers = screen.getByTestId("sankey-column-headers");
    const pane = screen.getByTestId("sankey-chart-pane");
    const chart = screen.getByRole("group", {
      name: /Session flow from goal/,
    });
    expect(flowHeader).toHaveTextContent("Session flow");
    expect(pane.contains(flowHeader)).toBe(false);
    expect(headers.closest("svg")).toBeNull();
    expect(headers.closest(".sticky")).not.toBeNull();
    expect(pane.contains(headers)).toBe(true);
    expect(pane.contains(chart)).toBe(true);
    expect(pane.className).toMatch(/overflow-auto/);
  });

  it("keeps catalog column order when nothing is persisted", () => {
    renderSankey({ stageOrderKey: "swarm:fresh" });
    const ids = Array.from(
      screen
        .getByTestId("sankey-column-headers")
        .querySelectorAll("[data-column-id]"),
    ).map((node) => node.getAttribute("data-column-id"));
    expect(ids).toEqual(["goal", "behavior", "outcome", "sentiment"]);
  });

  it("pins question hues to the question id, not the dragged slot", () => {
    const withQuestions = breakdown({
      sankey: {
        ...SANKEY,
        stages: [
          { id: "goal", label: "Goal" },
          { id: "behavior", label: "Behavior" },
          { id: "outcome", label: "Outcome" },
          { id: "sentiment", label: "Sentiment" },
          {
            id: "question:q1",
            label: "Likeness",
            questionId: "q1",
            version: 1,
          },
          {
            id: "question:q2",
            label: "View",
            questionId: "q2",
            version: 1,
          },
        ],
        nodes: [
          ...SANKEY.nodes,
          {
            id: "question:q1:yes",
            stage: "question:q1",
            key: "yes",
            label: "Yes",
            count: 1,
            clickable: true,
            questionVersion: 1,
          },
          {
            id: "question:q2:yes",
            stage: "question:q2",
            key: "yes",
            label: "Yes",
            count: 1,
            clickable: true,
            questionVersion: 1,
          },
        ],
        links: [
          ...SANKEY.links,
          {
            source: "sentiment:s1",
            target: "question:q1:yes",
            count: 1,
            discordantCount: 0,
          },
          {
            source: "question:q1:yes",
            target: "question:q2:yes",
            count: 1,
            discordantCount: 0,
          },
        ],
      },
    });
    const { unmount } = render(
      <SessionFlowSankey
        breakdown={withQuestions}
        selection={null}
        onSelectNode={vi.fn()}
        onSelectLink={vi.fn()}
        onRebuild={vi.fn()}
        rebuildBusy={false}
      />,
    );
    const catalogFills = Object.fromEntries(
      screen.getAllByRole("button", { name: /^Yes, 1 sessions/ }).map((node) => [
        node.getAttribute("aria-label"),
        node.querySelector("rect")?.getAttribute("fill"),
      ]),
    );
    unmount();

    localStorage.setItem(
      "sankey-stage-order",
      JSON.stringify({
        "swarm:hues": [
          "question:q2",
          "question:q1",
          "goal",
          "behavior",
          "outcome",
          "sentiment",
        ],
      }),
    );
    try {
      render(
        <SessionFlowSankey
          breakdown={withQuestions}
          selection={null}
          onSelectNode={vi.fn()}
          onSelectLink={vi.fn()}
          onRebuild={vi.fn()}
          rebuildBusy={false}
          stageOrderKey="swarm:hues"
        />,
      );
      const ids = Array.from(
        screen
          .getByTestId("sankey-column-headers")
          .querySelectorAll("[data-column-id]"),
      ).map((node) => node.getAttribute("data-column-id"));
      expect(ids[0]).toBe("question:q2");
      expect(ids[1]).toBe("question:q1");
      const reorderedFills = Object.fromEntries(
        screen
          .getAllByRole("button", { name: /^Yes, 1 sessions/ })
          .map((node) => [
            node.getAttribute("aria-label"),
            node.querySelector("rect")?.getAttribute("fill"),
          ]),
      );
      expect(reorderedFills).toEqual(catalogFills);
    } finally {
      localStorage.removeItem("sankey-stage-order");
    }
  });

  it("hides a catalog column and restores it from the add menu", async () => {
    const user = userEvent.setup();
    try {
      renderSankey({ stageOrderKey: "swarm:hide" });
      await user.click(
        screen.getByRole("button", { name: "Remove Sentiment column" }),
      );
      const ids = () =>
        Array.from(
          screen
            .getByTestId("sankey-column-headers")
            .querySelectorAll("[data-column-id]"),
        ).map((node) => node.getAttribute("data-column-id"));
      expect(ids()).toEqual(["goal", "behavior", "outcome"]);
      expect(
        screen.queryByRole("button", { name: "Remove Sentiment column" }),
      ).toBeNull();
      await user.click(screen.getByRole("button", { name: "Add column" }));
      await user.click(screen.getByRole("menuitem", { name: "Sentiment" }));
      expect(ids()).toEqual(["goal", "behavior", "outcome", "sentiment"]);
    } finally {
      localStorage.removeItem("sankey-stage-order");
    }
  });

  it("applies a saved column order and marks headers as draggable", () => {
    localStorage.setItem(
      "sankey-stage-order",
      JSON.stringify({
        "swarm:test": ["sentiment", "goal", "behavior", "outcome"],
      }),
    );
    try {
      renderSankey({ stageOrderKey: "swarm:test" });
      const headers = screen.getByTestId("sankey-column-headers");
      expect(headers).toHaveAttribute("data-reorderable", "true");
      const ids = Array.from(
        headers.querySelectorAll("[data-column-id]"),
      ).map((node) => node.getAttribute("data-column-id"));
      expect(ids).toEqual(["sentiment", "goal", "behavior", "outcome"]);
    } finally {
      localStorage.removeItem("sankey-stage-order");
    }
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
    expect(screen.getByText(/not the full history/)).toBeInTheDocument();
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

  it("fills the leftover parent on the scroll layout and stretches the ribbons into it", () => {
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
      renderSankey({ scrollLayout: true });
      const root = screen.getByTestId("scenario-insights-sankey");
      expect(root).toHaveAttribute("data-fill-remaining", "true");
      expect(root.className).toMatch(/flex-1/);
      const pane = screen.getByTestId("sankey-chart-pane");
      const svg = screen.getByRole("group", {
        name: /Session flow from goal/,
      });
      const viewBox = svg.getAttribute("viewBox") ?? "";
      const viewHeight = Number(viewBox.split(/\s+/)[3]);
      // Tall leftover parent → taller viewBox than the content floor, so
      // the columns use the space instead of leaving a dead region below.
      expect(viewHeight).toBeGreaterThan(320);
      expect(pane.className).toMatch(/flex-1/);
      expect(pane.className).toMatch(/overflow-auto/);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("stretches a wide six-column chart from the drawn width so headers stay on the bars", () => {
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
      renderSankey({
        scrollLayout: true,
        breakdown: breakdown({
          sankey: {
            ...SANKEY,
            stages: [
              { id: "goal", label: "Goal" },
              { id: "behavior", label: "Behavior" },
              { id: "outcome", label: "Outcome" },
              { id: "sentiment", label: "Sentiment" },
              {
                id: "question:q1",
                label: "Likeness",
                questionId: "q1",
                version: 1,
              },
              {
                id: "question:q2",
                label: "View",
                questionId: "q2",
                version: 1,
              },
            ],
            nodes: [
              ...SANKEY.nodes,
              {
                id: "question:q1:yes",
                stage: "question:q1",
                key: "yes",
                label: "Yes",
                count: 1,
                clickable: true,
                questionVersion: 1,
              },
              {
                id: "question:q2:yes",
                stage: "question:q2",
                key: "yes",
                label: "Yes",
                count: 1,
                clickable: true,
                questionVersion: 1,
              },
            ],
          },
        }),
      });
      const svg = screen.getByRole("group", {
        name: /Session flow from goal/,
      });
      const viewBox = svg.getAttribute("viewBox") ?? "";
      const [, , viewWidth, viewHeight] = viewBox.split(/\s+/).map(Number);
      // 6 columns → viewWidth 1560, min drawn width 1140. Stretch must use
      // 1140, not the 800px pane — that was the letterbox that threw headers.
      expect(viewWidth).toBe(1560);
      expect(viewHeight).toBe(Math.round((640 / 1140) * 1560));
      expect(svg).toHaveStyle({ minWidth: "1140px" });
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});
