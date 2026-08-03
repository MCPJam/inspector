/**
 * States and affordances of the session-flow panel.
 *
 * The SVG itself is not asserted here: recharts lays the diagram out from the
 * dimensions ResponsiveContainer measures, and jsdom reports 0×0, so nothing
 * inside it renders. The geometry-independent parts — which state is shown, what
 * the rebuild CTA offers, the legend, the truncation warning — are what this
 * file covers; the node/link math is unit-tested in `insights-sankey.test.ts`
 * and the panel wiring in `ChatboxUsagePanel.flow-selection.test.tsx`.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatboxInsightsSankey } from "../ChatboxInsightsSankey";
import type {
  ClusterRunState,
  InsightsSankey,
  UsageBreakdown,
} from "@/hooks/useUsageInsights";

const SANKEY: InsightsSankey = {
  nodes: [
    {
      id: "goal:c1",
      stage: "goal",
      key: "c1",
      label: "Invoice lookup",
      count: 4,
      clickable: true,
    },
    {
      id: "behavior:looping",
      stage: "behavior",
      key: "looping",
      label: "looping",
      count: 4,
      clickable: true,
    },
    {
      id: "outcome:errored",
      stage: "outcome",
      key: "errored",
      label: "errored",
      count: 4,
      clickable: true,
    },
    {
      id: "sentiment:frustrated",
      stage: "sentiment",
      key: "frustrated",
      label: "frustrated",
      count: 4,
      clickable: true,
    },
  ],
  links: [
    { source: "goal:c1", target: "behavior:looping", count: 4 },
    { source: "behavior:looping", target: "outcome:errored", count: 4 },
    { source: "outcome:errored", target: "sentiment:frustrated", count: 4 },
  ],
  foldedGoalCount: 0,
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
    signalsVersion: 2,
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
  props: Partial<React.ComponentProps<typeof ChatboxInsightsSankey>> = {},
) {
  const onRebuild = props.onRebuild ?? vi.fn();
  render(
    <ChatboxInsightsSankey
      breakdown={breakdown()}
      selection={null}
      onSelectNode={vi.fn()}
      onSelectLink={vi.fn()}
      onRebuild={onRebuild}
      rebuildBusy={false}
      {...props}
    />,
  );
  return { onRebuild };
}

describe("ChatboxInsightsSankey", () => {
  it("shows a loading state until the breakdown arrives", () => {
    renderSankey({ breakdown: undefined });
    expect(screen.getByText(/Loading session flow/)).toBeInTheDocument();
  });

  it("offers a rebuild when the last run predates session signals", async () => {
    // The old grid only had copy here. A run this old cannot produce any stage
    // but the flow's shape, so the useful thing to show is the way out.
    const user = userEvent.setup();
    const onRebuild = vi.fn();
    renderSankey({
      breakdown: breakdown({
        sankey: { nodes: [], links: [], foldedGoalCount: 0 },
        latestRun: run({ signalsVersion: null }),
      }),
      onRebuild,
    });

    expect(
      screen.getByText(/before session signals existed/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Rebuild clusters/ }));
    expect(onRebuild).toHaveBeenCalledTimes(1);
  });

  it("renders the diagram but prompts a rebuild when sentiment is missing", async () => {
    // A version-1 run produced every other stage, so the honest thing is to
    // draw what exists and explain why the fourth column is empty — not to
    // replace the whole panel with an empty state.
    const user = userEvent.setup();
    const onRebuild = vi.fn();
    renderSankey({
      breakdown: breakdown({ latestRun: run({ signalsVersion: 1 }) }),
      onRebuild,
    });

    expect(screen.getByText("Session flow")).toBeInTheDocument();
    expect(
      screen.getByText(/analyzed before sentiment existed/),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Rebuild for sentiment/ }),
    );
    expect(onRebuild).toHaveBeenCalledTimes(1);
  });

  it("does not prompt for a rebuild once sentiment is present", () => {
    renderSankey();
    expect(
      screen.queryByText(/analyzed before sentiment existed/),
    ).not.toBeInTheDocument();
  });

  it("disables the rebuild control while one is running", () => {
    renderSankey({
      breakdown: breakdown({ latestRun: run({ signalsVersion: 1 }) }),
      rebuildBusy: true,
    });
    expect(screen.getByRole("button", { name: /Rebuilding/ })).toBeDisabled();
  });

  it("labels each stage as deterministic or model-inferred", () => {
    // A reader deciding whether to trust a column needs to know which ones came
    // from a model. Behavior is the only one read straight off the transcript.
    renderSankey();
    expect(screen.getByText("Behavior").textContent).toContain(
      "from transcript",
    );
    for (const stage of ["Goal", "Outcome", "Sentiment"]) {
      expect(screen.getByText(stage).textContent).toContain("model");
    }
  });

  it("explains the discordant-link color rather than relying on it alone", () => {
    renderSankey();
    expect(
      screen.getByText("Outcome and sentiment disagree"),
    ).toBeInTheDocument();
  });

  it("says how many goals were folded away", () => {
    renderSankey({
      breakdown: breakdown({ sankey: { ...SANKEY, foldedGoalCount: 3 } }),
    });
    expect(screen.getByText(/3 smaller goals folded/)).toBeInTheDocument();
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
});
