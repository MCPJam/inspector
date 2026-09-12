/**
 * Narrowing a goal's session list to one stage of the user value chain.
 *
 * Vignesh's ask on Findings: read a finding, then see the session it is about.
 * For a STAGE finding that means the sessions which passed or failed at that
 * stage, not the goal's whole list.
 *
 * The rule worth pinning is that the stage chip is ADDITIVE. The persona's
 * sentiment and the hide-synthetic policy are what make this list agree with
 * the count that opened it, so a stage chip that replaced them would trade one
 * disagreement for another — and it would look right on any study where every
 * session belongs to one persona.
 */

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FindingsGoalSessions } from "../findings-goal-sessions";
import type { UsageFilterState } from "@/hooks/scenario-usage-filters";

const { mockUseGoalOutcomeDrilldown } = vi.hoisted(() => ({
  mockUseGoalOutcomeDrilldown: vi.fn(),
}));

vi.mock("@/hooks/useUsageInsights", () => ({
  useGoalOutcomeDrilldown: (...args: unknown[]) =>
    mockUseGoalOutcomeDrilldown(...args),
}));

const PERSONA_FILTERS: UsageFilterState = {
  preset: "all",
  chips: [
    { kind: "dimension", key: "sentiment", value: "frustrated" },
    { kind: "dimension", key: "synthetic", value: "hide" },
  ],
};

function lastArgs() {
  const calls = mockUseGoalOutcomeDrilldown.mock.calls;
  return calls[calls.length - 1]![0] as {
    clusterId: string | null;
    filters?: UsageFilterState;
  };
}

beforeEach(() => {
  mockUseGoalOutcomeDrilldown.mockReset();
  mockUseGoalOutcomeDrilldown.mockReturnValue({
    drilldown: {
      sessions: [],
      nextBefore: null,
      total: 0,
      totalTruncated: false,
    },
    isLoading: false,
  });
});

describe("stage narrowing on a scenario goal", () => {
  it("adds the stage chip on top of the persona's own filters", () => {
    render(
      <FindingsGoalSessions
        scope={{
          kind: "scenario",
          scenarioId: "scn-1",
          filters: PERSONA_FILTERS,
        }}
        goalId="cluster-export"
        expectedCount={2}
        stage={{ chainStage: "discovery", state: "failed" }}
        onOpenSession={vi.fn()}
      />,
    );

    const args = lastArgs();
    expect(args.clusterId).toBe("cluster-export");
    // All three, not just the stage. Dropping the sentiment would widen the
    // list back across personas; dropping hide-synthetic would let a rehearsal
    // into a list describing real people.
    expect(args.filters?.chips).toEqual([
      { kind: "dimension", key: "sentiment", value: "frustrated" },
      { kind: "dimension", key: "synthetic", value: "hide" },
      { kind: "dimension", key: "stage", value: "discovery:failed" },
    ]);
  });

  it("uses the chain's stage id, not the panel's", () => {
    // The panel calls the last stage `value`; the chain calls it `userValue`,
    // and the chip has to speak the chain's vocabulary or it matches nothing.
    render(
      <FindingsGoalSessions
        scope={{ kind: "scenario", scenarioId: "scn-1" }}
        goalId="cluster-export"
        expectedCount={2}
        stage={{ chainStage: "userValue", state: "passed" }}
        onOpenSession={vi.fn()}
      />,
    );

    expect(lastArgs().filters?.chips).toEqual([
      { kind: "dimension", key: "stage", value: "userValue:passed" },
    ]);
  });

  it("leaves the goal's filters untouched when no stage is narrowed", () => {
    // A stage with no verdict narrows to nothing. Filtering there would empty
    // a list whose own copy says the stage was never graded.
    render(
      <FindingsGoalSessions
        scope={{
          kind: "scenario",
          scenarioId: "scn-1",
          filters: PERSONA_FILTERS,
        }}
        goalId="cluster-export"
        expectedCount={2}
        stage={null}
        onOpenSession={vi.fn()}
      />,
    );

    expect(lastArgs().filters).toEqual(PERSONA_FILTERS);
  });

  it("never sends a stage chip on a swarm goal", () => {
    // A swarm goal pages by run id and its backend reader takes no chips, so a
    // stage chip there would be silently ignored rather than narrowing.
    render(
      <FindingsGoalSessions
        scope={{ kind: "swarm", projectId: "proj-1" }}
        goalId="run-1"
        expectedCount={2}
        stage={{ chainStage: "discovery", state: "failed" }}
        onOpenSession={vi.fn()}
      />,
    );

    const args = lastArgs() as unknown as Record<string, unknown>;
    expect(args.filters).toBeUndefined();
    expect(args.scope).toEqual({
      kind: "swarm",
      projectId: "proj-1",
      journeyRunIds: ["run-1"],
    });
  });
});
