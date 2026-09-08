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

// The probe's boundary must not FILE the dark-ship window. Mocked rather than
// spied so the assertion is about what the boundary decided, not about whether
// Sentry happened to be configured in this test process.
const { reportBoundaryError } = vi.hoisted(() => ({
  reportBoundaryError: vi.fn(),
}));
vi.mock("@/lib/error-reporting", () => ({
  reportBoundaryError,
  reportCaught: vi.fn(),
}));

const {
  isConvexQueryUnavailable,
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

  it("does not render a card for a run with no sessions", () => {
    convex.useQuery.mockReturnValue({ ...SUMMARY, source: "swarm", total: 0 });
    const { container } = render(
      <SwarmRunStageFunnelPanels journeyRunIds={["run-empty"]} />,
    );
    expect(container.textContent).toBe("");
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

  it("reports false and renders nothing when the query throws", () => {
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
    expect(onChange).toHaveBeenCalledWith("run-1", false);
    expect(container.textContent).toBe("the rest of the page");
  });

  it("files NOTHING with Sentry/PostHog for the dark-ship window", () => {
    // The probe is mounted on every run-detail visit and the query is
    // deliberately undeployed, so an unconditional boundary report turns the
    // intended state into one issue and one event per run VIEWED — noise
    // indistinguishable from a real regression, at the moment one would
    // matter most.
    queryThrows();
    render(
      <SuiteRunStageFunnelAvailability suiteRunId="run-1" onChange={vi.fn()} />,
    );
    expect(reportBoundaryError).not.toHaveBeenCalled();
  });

  it("DOES file a failure that is not one of the two expected shapes", () => {
    // The suppression is a predicate, not a mute button: a probe that stopped
    // reporting everything would swallow the real bug it exists to surface.
    convex.useQuery.mockImplementation(() => {
      throw new Error("TypeError: cannot read properties of undefined");
    });
    const onChange = vi.fn();
    render(
      <SuiteRunStageFunnelAvailability
        suiteRunId="run-1"
        onChange={onChange}
      />,
    );
    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
    // And the rail still closes either way.
    expect(onChange).toHaveBeenCalledWith("run-1", false);
  });

  it("clears a previous answer when the SAME run's probe then fails", () => {
    // The boundary key re-arms the probe across runs, but a query that throws
    // after answering for the run still on screen renders the fallback
    // silently. Without `onError` the caller would keep the last good `true`
    // and hold the rail open over a funnel that is no longer there.
    convex.useQuery.mockReturnValue(SUMMARY);
    const onChange = vi.fn();
    const { rerender } = render(
      <SuiteRunStageFunnelAvailability
        suiteRunId="run-1"
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenLastCalledWith("run-1", true);

    queryThrows();
    rerender(
      <SuiteRunStageFunnelAvailability
        suiteRunId="run-1"
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenLastCalledWith("run-1", false);
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
    // The failing run reports "no funnel" rather than staying silent.
    expect(onChange).toHaveBeenLastCalledWith("run-1", false);

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

describe("isConvexQueryUnavailable", () => {
  it.each([
    ["an undeployed function", "Could not find public function for 'x:y'"],
    ["no ConvexProvider", "Could not find Convex client!"],
  ])("recognises %s", (_label, message) => {
    expect(isConvexQueryUnavailable(new Error(message))).toBe(true);
  });

  it.each([
    ["a real bug", "Cannot read properties of undefined (reading 'stages')"],
    ["an auth refusal", "Authenticated user required"],
    ["an empty message", ""],
  ])("does NOT recognise %s", (_label, message) => {
    expect(isConvexQueryUnavailable(new Error(message))).toBe(false);
  });

  it("survives an error with no message at all", () => {
    // The predicate runs inside a boundary that is already handling a failure;
    // throwing from here would be the second failure, at the worst moment.
    expect(
      isConvexQueryUnavailable({ message: undefined } as unknown as Error),
    ).toBe(false);
  });
});
