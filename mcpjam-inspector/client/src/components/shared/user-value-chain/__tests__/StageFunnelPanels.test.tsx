/**
 * The funnel panels: what they do when the query answers, and what they do
 * when it cannot.
 *
 * `useQuery` throws when the query is not deployed yet — the expected state
 * during the dark window — and an `ErrorBoundary` only catches what its
 * DESCENDANTS throw. So each exported panel is a thin wrapper whose only job
 * is to put the boundary ABOVE the component that owns the query. That split,
 * rather than a boundary at each mount site, is what makes the guarantee the
 * panel's own: a future caller cannot forget to wrap it.
 *
 * `convex/react` is mocked here so both halves can be driven from one file —
 * a throwing query and a successful one. What the mock cannot prove is that a
 * MISSING PROVIDER is one of the things that throws; that is Convex's own
 * behaviour, and it is covered where it actually matters, by
 * `ScenarioUsagePanel.test.tsx` rendering the real tree with no provider and
 * still passing.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const convex = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("convex/react", () => convex);

const {
  ScenarioStageFunnelPanel,
  SuiteRunStageFunnelAvailability,
  SwarmRunStageFunnelPanels,
} = await import("../StageFunnelPanels");
import type { ChatSessionStageFunnel } from "../user-value-chain-types";

const STAGES = [
  "connection",
  "discovery",
  "selection",
  "call",
  "response",
  "userValue",
] as const;

const SUMMARY: ChatSessionStageFunnel = {
  source: "user_testing",
  total: 7,
  counted: 7,
  exclusions: { absent: 0, deriving: 0, stale: 0, failed: 0 },
  stages: STAGES.map((stage) => ({
    stage,
    passed: 4,
    failed: 3,
    eligible: 7,
    notMeasured: 0,
    notApplicable: 0,
    notReached: 0,
    observations: 7,
    passRate: 4 / 7,
  })),
  firstFailedStage: {},
  notMeasured: false,
  truncated: false,
};

/** The dark-ship state: the query is not deployed, so calling it throws. */
function queryThrows() {
  convex.useQuery.mockImplementation(() => {
    throw new Error("Could not find Convex client!");
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ScenarioStageFunnelPanel — the query answers", () => {
  it("renders the funnel and names the population", () => {
    convex.useQuery.mockReturnValue(SUMMARY);
    render(<ScenarioStageFunnelPanel scenarioId="scenario-1" />);

    expect(screen.getByLabelText("User value chain")).toBeTruthy();
    expect(document.body.textContent).toContain("Real User Testing sessions");
    expect(document.body.textContent).toContain("7 of 7 sessions measured");
  });

  it("passes the scenario to the query and skips without one", () => {
    convex.useQuery.mockReturnValue(SUMMARY);
    render(<ScenarioStageFunnelPanel scenarioId="scenario-1" />);
    expect(convex.useQuery.mock.calls[0][1]).toEqual({
      scenarioId: "scenario-1",
    });

    vi.clearAllMocks();
    convex.useQuery.mockReturnValue(undefined);
    render(<ScenarioStageFunnelPanel scenarioId={undefined} />);
    expect(convex.useQuery.mock.calls[0][1]).toBe("skip");
  });

  it("renders nothing while the query is still loading", () => {
    // `undefined` is in flight and `null` is a scenario we cannot read.
    // Neither is "no sessions", which the funnel itself reports as notMeasured.
    for (const value of [undefined, null]) {
      convex.useQuery.mockReturnValue(value);
      const { container } = render(
        <ScenarioStageFunnelPanel scenarioId="scenario-1" />,
      );
      expect(container.textContent).toBe("");
    }
  });
});

describe("ScenarioStageFunnelPanel — the query cannot answer", () => {
  it("renders nothing instead of throwing", () => {
    queryThrows();
    const { container } = render(
      <ScenarioStageFunnelPanel scenarioId="scenario-1" />,
    );
    expect(container.textContent).toBe("");
  });

  it("does not take its host down with it", () => {
    // The User Testing sessions surface in miniature: a sibling rendered
    // beside the panel must still be there.
    queryThrows();
    const { getByTestId } = render(
      <div>
        <span data-testid="sibling">the rest of the page</span>
        <ScenarioStageFunnelPanel scenarioId="scenario-1" />
      </div>,
    );
    expect(getByTestId("sibling").textContent).toBe("the rest of the page");
  });
});

describe("SwarmRunStageFunnelPanels — the query answers", () => {
  it("renders one funnel per run, never one folded across runs", () => {
    // Two runs against different hosts have different denominators; a
    // combined bar would describe neither.
    convex.useQuery.mockReturnValue({ ...SUMMARY, source: "swarm" });
    render(<SwarmRunStageFunnelPanels journeyRunIds={["run-1", "run-2"]} />);

    expect(screen.getAllByLabelText("User value chain")).toHaveLength(2);
    expect(screen.getAllByText(/Sessions in this swarm run/)).toHaveLength(2);
  });

  it("queries each run by its own id", () => {
    convex.useQuery.mockReturnValue({ ...SUMMARY, source: "swarm" });
    render(<SwarmRunStageFunnelPanels journeyRunIds={["run-1", "run-2"]} />);
    expect(convex.useQuery.mock.calls.map((call) => call[1])).toEqual([
      { journeyRunId: "run-1" },
      { journeyRunId: "run-2" },
    ]);
  });

  it("renders nothing at all for an empty run list — not even its spacing", () => {
    // The caller passes a possibly-empty set and cannot easily guard on it (an
    // empty Set is truthy), so the spacing rides on this component rather than
    // on a wrapper at the mount site. A wrapper would reserve padding for a
    // funnel that never appears, leaving a blank band above the session list.
    convex.useQuery.mockReturnValue({ ...SUMMARY, source: "swarm" });
    const { container } = render(
      <SwarmRunStageFunnelPanels
        journeyRunIds={[]}
        className="shrink-0 space-y-2 px-4 pt-3"
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("SwarmRunStageFunnelPanels — the query cannot answer", () => {
  it("renders nothing instead of throwing", () => {
    queryThrows();
    const { container } = render(
      <SwarmRunStageFunnelPanels journeyRunIds={["run-1", "run-2"]} />,
    );
    expect(container.textContent).toBe("");
  });

  it("does not take its host down with it", () => {
    queryThrows();
    const { getByTestId } = render(
      <div>
        <span data-testid="sibling">the rest of the page</span>
        <SwarmRunStageFunnelPanels journeyRunIds={["run-1"]} />
      </div>,
    );
    expect(getByTestId("sibling").textContent).toBe("the rest of the page");
  });
});

describe("SuiteRunStageFunnelAvailability — the probe that opens the rail", () => {
  it("reports true only when the rollup actually answered", () => {
    convex.useQuery.mockReturnValue(SUMMARY);
    const onChange = vi.fn();
    render(
      <SuiteRunStageFunnelAvailability
        suiteRunId="run-1"
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenCalledWith("run-1", true);
  });

  it.each([
    ["still loading", undefined],
    ["a run with no rollup", null],
  ])("reports false while %s", (_label, value) => {
    convex.useQuery.mockReturnValue(value);
    const onChange = vi.fn();
    render(
      <SuiteRunStageFunnelAvailability
        suiteRunId="run-1"
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenCalledWith("run-1", false);
  });

  it("renders nothing and never reports when the query throws", () => {
    // The dark-ship state. Undeployed must read as "no funnel", and the probe
    // must not take the run-detail page down with it.
    queryThrows();
    const onChange = vi.fn();
    const { container } = render(
      <div>
        <span data-testid="sibling">the rest of the page</span>
        <SuiteRunStageFunnelAvailability
          suiteRunId="run-1"
          onChange={onChange}
        />
      </div>,
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toBe("the rest of the page");
  });

  it("names the run each answer is about, so a stale one is detectable", () => {
    // The run selector reuses one view across runs. An answer that did not
    // name its run could not be told apart from the previous run's, and a
    // stale `true` would open an empty rail on the run you switched to.
    convex.useQuery.mockReturnValue(SUMMARY);
    const onChange = vi.fn();
    const { rerender } = render(
      <SuiteRunStageFunnelAvailability
        suiteRunId="run-1"
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenLastCalledWith("run-1", true);

    convex.useQuery.mockReturnValue(null);
    rerender(
      <SuiteRunStageFunnelAvailability
        suiteRunId="run-2"
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenLastCalledWith("run-2", false);
  });

  it("re-arms after a failing run: a later run is still probed", () => {
    // An ErrorBoundary that has caught stays in its fallback for the life of
    // the element, so the boundary is keyed by run. Without the key, one
    // transient failure would hide the chain on every run after it.
    queryThrows();
    const onChange = vi.fn();
    const { rerender } = render(
      <SuiteRunStageFunnelAvailability
        suiteRunId="run-1"
        onChange={onChange}
      />,
    );
    expect(onChange).not.toHaveBeenCalled();

    convex.useQuery.mockReturnValue(SUMMARY);
    rerender(
      <SuiteRunStageFunnelAvailability
        suiteRunId="run-2"
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenCalledWith("run-2", true);
  });
});
