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
    expect(args.filters).toEqual({
      preset: "all",
      chips: [
        { kind: "dimension", key: "sentiment", value: "frustrated" },
        { kind: "dimension", key: "synthetic", value: "hide" },
        { kind: "dimension", key: "stage", value: "discovery:failed" },
      ],
    });
  });

  it("spells the chip as <chainStage>:<state>", () => {
    // Only the chip's SHAPE. The chain id arrives as a prop here, so this
    // cannot prove the panel-to-chain mapping — `findings-goal-inspect` is
    // where that translation happens and where it is asserted.
    render(
      <FindingsGoalSessions
        scope={{ kind: "scenario", scenarioId: "scn-1" }}
        goalId="cluster-export"
        expectedCount={2}
        stage={{ chainStage: "userValue", state: "passed" }}
        onOpenSession={vi.fn()}
      />,
    );

    expect(lastArgs().filters).toEqual({
      preset: "all",
      chips: [{ kind: "dimension", key: "stage", value: "userValue:passed" }],
    });
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

  it("drops a session the live query stopped returning", async () => {
    // The drilldown is REACTIVE. A session regraded while the goal is open
    // stops matching the stage that opened it, and the old list kept it —
    // appending only unseen ids can never express a removal. Clicking it then
    // landed on a transcript that no longer failed where the header said.
    const session = (id: string) => ({
      _id: id,
      firstMessagePreview: id,
      lastActivityAt: 1,
    });
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("sess-a"), session("sess-b")],
        total: 2,
        nextBefore: null,
      },
      isLoading: false,
    });

    const props = {
      scope: {
        kind: "scenario" as const,
        scenarioId: "scn-1",
        filters: PERSONA_FILTERS,
      },
      goalId: "cluster-export",
      expectedCount: 2,
      stage: { chainStage: "discovery" as const, state: "failed" as const },
      onOpenSession: vi.fn(),
    };
    const { rerender, findAllByTestId, queryAllByTestId } = render(
      <FindingsGoalSessions {...props} />,
    );
    expect(await findAllByTestId("findings-goal-session")).toHaveLength(2);

    // Same page, one row fewer.
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("sess-a")],
        total: 1,
        nextBefore: null,
      },
      isLoading: false,
    });
    rerender(<FindingsGoalSessions {...props} />);

    expect(queryAllByTestId("findings-goal-session")).toHaveLength(1);
  });

  it("settles when the query re-allocates its answer every render", async () => {
    // A double built with `mockImplementation` hands back a FRESH object each
    // call, which is exactly what the real query does not do. The effect that
    // stores pages keys on that result, so without a bail-out it goes
    // set state → render → new object → set state until the worker dies —
    // which is how this surfaced: an `ERR_IPC_CHANNEL_CLOSED` on CI with no
    // failing assertion, not a red test.
    let calls = 0;
    mockUseGoalOutcomeDrilldown.mockImplementation(() => {
      calls += 1;
      return {
        drilldown: {
          sessions: [
            { _id: "sess-a", firstMessagePreview: "a", lastActivityAt: 1 },
          ],
          total: 1,
          nextBefore: null,
        },
        isLoading: false,
      };
    });

    const { findAllByTestId } = render(
      <FindingsGoalSessions
        scope={{
          kind: "scenario",
          scenarioId: "scn-1",
          filters: PERSONA_FILTERS,
        }}
        goalId="cluster-export"
        expectedCount={1}
        stage={{ chainStage: "discovery", state: "failed" }}
        onOpenSession={vi.fn()}
      />,
    );
    expect(await findAllByTestId("findings-goal-session")).toHaveLength(1);

    // A handful of renders is normal; a runaway is not. The number is a
    // ceiling, not a target — it only has to be far below "forever".
    expect(calls).toBeLessThan(15);
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
