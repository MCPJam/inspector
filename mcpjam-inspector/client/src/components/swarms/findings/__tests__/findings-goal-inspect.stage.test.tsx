/**
 * The inspect panel deciding WHICH sessions a selected stage is about.
 *
 * `findings-goal-sessions.stage.test.tsx` covers the chip once a narrowing has
 * been chosen. This covers choosing it, which is where the two things that can
 * silently go wrong live: translating the panel's stage id into the chain's,
 * and following the stage's own verdict rather than assuming failure.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FindingsGoalInspect } from "../findings-goal-inspect";
import { JOURNEY_STAGES, type JourneyStageId } from "../journey-stages";
import type { GoalFindingsModel, StageState } from "../findings-derivation";
import type { UsageFilterState } from "@/hooks/scenario-usage-filters";

const { mockUseGoalOutcomeDrilldown } = vi.hoisted(() => ({
  mockUseGoalOutcomeDrilldown: vi.fn(),
}));

vi.mock("@/hooks/useUsageInsights", () => ({
  useGoalOutcomeDrilldown: (...args: unknown[]) =>
    mockUseGoalOutcomeDrilldown(...args),
}));

function goal(states: Partial<Record<JourneyStageId, StageState>>) {
  const stages = {} as GoalFindingsModel["stages"];
  for (const stage of JOURNEY_STAGES) {
    const state = states[stage.id] ?? "none";
    stages[stage.id] = {
      state,
      evidence:
        state === "none"
          ? []
          : [
              {
                tone: state,
                observation: `${stage.title} row`,
                meta: "2 graded",
              },
            ],
    };
  }
  return {
    journeyRefId: "cluster-export",
    runId: "cluster-export",
    title: "Export the board",
    sessions: 2,
    sentiment: { label: "Stalled", tone: "fail" },
    stages,
    diagnosisStage: null,
    diagnosis: { title: "", detail: "" },
    defaultStage: "connection",
  } satisfies GoalFindingsModel;
}

function chipsFromLastCall(): UsageFilterState["chips"] | undefined {
  const calls = mockUseGoalOutcomeDrilldown.mock.calls;
  const args = calls[calls.length - 1]![0] as { filters?: UsageFilterState };
  return args.filters?.chips;
}

function renderInspect(
  model: GoalFindingsModel,
  selectedStage: JourneyStageId,
) {
  return render(
    <FindingsGoalInspect
      goal={model}
      selectedStage={selectedStage}
      onSelectStage={vi.fn()}
      onOpenSession={vi.fn()}
      sessionScope={{ kind: "scenario", scenarioId: "scn-1" }}
    />,
  );
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

describe("which sessions a selected stage narrows to", () => {
  it("translates the panel's `value` into the chain's `userValue`", () => {
    // The one stage id the two vocabularies disagree on. A chip carrying the
    // panel's spelling would match no row at all and silently empty the list.
    renderInspect(goal({ value: "ok" }), "value");

    expect(chipsFromLastCall()).toEqual([
      { kind: "dimension", key: "stage", value: "userValue:passed" },
    ]);
  });

  it("follows the stage's own verdict rather than assuming failure", () => {
    renderInspect(goal({ discovery: "ok" }), "discovery");
    expect(chipsFromLastCall()).toEqual([
      { kind: "dimension", key: "stage", value: "discovery:passed" },
    ]);
  });

  it("treats a warning stage as its failures", () => {
    // `warn` means some sessions failed here. The row reads "failed in 1 of 4",
    // so the list behind it is those failures.
    renderInspect(goal({ discovery: "warn" }), "discovery");
    expect(chipsFromLastCall()).toEqual([
      { kind: "dimension", key: "stage", value: "discovery:failed" },
    ]);
  });

  it("narrows to nothing on a stage with no verdict", () => {
    // Filtering here would empty a list whose own copy says the stage was
    // never graded, which reads as "no sessions" rather than "not measured".
    renderInspect(goal({}), "selection");
    expect(chipsFromLastCall()).toBeUndefined();
  });

  it("shows only the new stage's sessions after switching, never both", async () => {
    // The list ACCUMULATES pages in state, so switching stages has to remount
    // it. Asserting on element identity was not enough: the panel remounts the
    // subtree for other reasons too, so that test passed with the key reverted.
    // This asserts the consequence a reader would actually see.
    mockUseGoalOutcomeDrilldown.mockImplementation((args: unknown) => {
      const { filters } = args as { filters?: UsageFilterState };
      const value = filters?.chips.find((c) => "key" in c && c.key === "stage");
      const stage =
        value && "value" in value ? String(value.value) : "none:none";
      return {
        drilldown: {
          sessions: [
            {
              _id: `sess-${stage}`,
              firstMessagePreview: `transcript for ${stage}`,
              lastActivityAt: 1,
            },
          ],
          nextBefore: null,
          total: 1,
          totalTruncated: false,
        },
        isLoading: false,
      };
    });

    const model = goal({ connection: "ok", discovery: "fail" });
    const { rerender } = renderInspect(model, "connection");
    expect(
      await screen.findByText('"transcript for connection:passed"'),
    ).toBeInTheDocument();

    rerender(
      <FindingsGoalInspect
        goal={model}
        selectedStage="discovery"
        onSelectStage={vi.fn()}
        onOpenSession={vi.fn()}
        sessionScope={{ kind: "scenario", scenarioId: "scn-1" }}
      />,
    );

    expect(
      await screen.findByText('"transcript for discovery:failed"'),
    ).toBeInTheDocument();
    // The previous stage's session must be GONE, not listed above the new one.
    expect(
      screen.queryByText('"transcript for connection:passed"'),
    ).not.toBeInTheDocument();
  });
});
