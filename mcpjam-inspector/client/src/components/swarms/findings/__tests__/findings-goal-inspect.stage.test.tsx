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
                // DELIBERATELY not stage-specific. The evidence row above
                // the session list is keyed on this text, so a per-stage
                // string would remount the subtree on its own and no test
                // here could tell `sessionsKey` from that ancestor.
                observation: "A row",
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
    notRun: false,
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
    // The page in view REPLACES itself, so this passes with or without the
    // remount key — it pins the page swap, not the key. The test below pins
    // the key, which guards the state the swap does not touch.
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

  it("does not carry a loaded page across a stage switch", async () => {
    // What `sessionsKey` actually guards. The page in view reconciles itself,
    // but `before` and the pages already fetched are component state: once the
    // reader has clicked "Load more", dropping the key leaves the previous
    // stage's SECOND page rendered under this stage's header.
    mockUseGoalOutcomeDrilldown.mockImplementation((args: unknown) => {
      const { filters, before } = args as {
        filters?: UsageFilterState;
        before?: number;
      };
      const chip = filters?.chips.find((c) => "key" in c && c.key === "stage");
      const stage = chip && "value" in chip ? String(chip.value) : "none:none";
      const page = before === undefined ? "p1" : "p2";
      return {
        drilldown: {
          sessions: [
            {
              _id: `sess-${stage}-${page}`,
              firstMessagePreview: `${stage} ${page}`,
              lastActivityAt: 1,
            },
          ],
          nextBefore: before === undefined ? 100 : null,
          total: 2,
          totalTruncated: false,
        },
        isLoading: false,
      };
    });

    const model = goal({ connection: "ok", discovery: "fail" });
    const { rerender } = renderInspect(model, "connection");
    await screen.findByText('"connection:passed p1"');
    await userEvent.click(screen.getByRole("button", { name: /Load/ }));
    expect(
      await screen.findByText('"connection:passed p2"'),
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
      await screen.findByText('"discovery:failed p1"'),
    ).toBeInTheDocument();
    // The cursor came along for the ride without the key, and page two of the
    // PREVIOUS stage stayed on screen under this stage's header.
    expect(
      screen.queryByText('"connection:passed p2"'),
    ).not.toBeInTheDocument();
  });

  it("does not carry a loaded page across a filter change", async () => {
    // Same state, different trigger. The tab rebuilds `sessionScope` when a
    // filter chip changes, and a cursor held over from the old cohort would
    // page the new one from the wrong place — rows from one population under a
    // header counting another.
    mockUseGoalOutcomeDrilldown.mockImplementation((args: unknown) => {
      const { scope, before } = args as {
        scope?: { scenarioId?: string };
        before?: number;
      };
      const page = before === undefined ? "p1" : "p2";
      return {
        drilldown: {
          sessions: [
            {
              _id: `sess-${scope?.scenarioId}-${page}`,
              firstMessagePreview: `${scope?.scenarioId} ${page}`,
              lastActivityAt: 1,
            },
          ],
          nextBefore: before === undefined ? 100 : null,
          total: 2,
          totalTruncated: false,
        },
        isLoading: false,
      };
    });

    const model = goal({ discovery: "fail" });
    const scoped = (filters: UsageFilterState) => (
      <FindingsGoalInspect
        goal={model}
        selectedStage="discovery"
        onSelectStage={vi.fn()}
        onOpenSession={vi.fn()}
        sessionScope={{ kind: "scenario", scenarioId: "scn-1", filters }}
      />
    );

    const { rerender } = render(scoped({ preset: "all", chips: [] }));
    await screen.findByText('"scn-1 p1"');
    await userEvent.click(screen.getByRole("button", { name: /Load/ }));
    expect(await screen.findByText('"scn-1 p2"')).toBeInTheDocument();

    rerender(
      scoped({
        preset: "all",
        chips: [{ kind: "dimension", key: "sentiment", value: "frustrated" }],
      }),
    );

    await screen.findByText('"scn-1 p1"');
    expect(screen.queryByText('"scn-1 p2"')).not.toBeInTheDocument();
  });

  it("keeps a thrown drilldown inside the list, not over the whole panel", async () => {
    // A backend that does not know the `stage` dimension rejects the chip at
    // argument validation and the hook throws. Without the boundary that
    // reaches the tab's own boundary and blanks the whole of Findings.
    mockUseGoalOutcomeDrilldown.mockImplementation(() => {
      throw new Error("unknown filter dimension: stage");
    });

    renderInspect(goal({ connection: "ok", discovery: "fail" }), "discovery");

    expect(
      await screen.findByTestId("findings-goal-sessions-error"),
    ).toBeInTheDocument();
    // The panel around it survives: the reader can still move between stages.
    expect(screen.getByTestId("findings-stage-connection")).toBeInTheDocument();
    expect(screen.getByTestId("findings-stage-discovery")).toBeInTheDocument();
  });
});
