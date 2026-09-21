/**
 * `mapGoalStageFunnel` — the funnel a goal breaks down into.
 *
 * The tests below are written against the ways this mapping could quietly lie
 * rather than the ways it could crash. Three in particular, because each one
 * produces a panel that looks completely fine:
 *
 *  1. A stage nobody was graded on rendering as a PASS. "No failures recorded"
 *     and "it worked" are the same green button, and only one of them is true.
 *  2. `passRate` used as the discriminator. It is `null` on an empty
 *     denominator, and `null` compares false against everything, so the lie in
 *     (1) is one `===` away at all times.
 *  3. The break stage read as "the stage with the most failures" instead of
 *     "the stage most sessions failed FIRST at" — a late stage inherits every
 *     failure an early one caused.
 *
 * Fixtures derive `eligible`, `observations` and `passRate` from `passed` and
 * `failed` the way `chatSessionStageAggregate.ts` does, so a test cannot pass
 * by describing a funnel the backend could never emit.
 */

import { describe, expect, it } from "vitest";
import { USER_VALUE_STAGES, type UserValueStage } from "@mcpjam/sdk/contract";
import type {
  ChatSessionStageFunnel,
  StageTally,
} from "@/components/shared/user-value-chain/user-value-chain-types";
import {
  mapGoalStageFunnel,
  stageStateFromTally,
} from "@/components/scenarios/findings/scenario-findings-stages";

type TallySpec = {
  passed?: number;
  failed?: number;
  notMeasured?: number;
  notApplicable?: number;
  notReached?: number;
};

function tally(stage: UserValueStage, spec: TallySpec = {}): StageTally {
  const passed = spec.passed ?? 0;
  const failed = spec.failed ?? 0;
  const notMeasured = spec.notMeasured ?? 0;
  const notApplicable = spec.notApplicable ?? 0;
  const notReached = spec.notReached ?? 0;
  const eligible = passed + failed;
  return {
    stage,
    passed,
    failed,
    eligible,
    notMeasured,
    notApplicable,
    notReached,
    observations: eligible + notMeasured + notApplicable + notReached,
    // Rule 2 of the fold: no denominator means no rate. Kept here so a fixture
    // cannot hand the mapper a 0 where the backend would hand it a null.
    passRate: eligible === 0 ? null : passed / eligible,
  };
}

function funnelOf(
  rows: Partial<Record<UserValueStage, TallySpec>>,
  over: Partial<
    Pick<
      ChatSessionStageFunnel,
      "total" | "counted" | "exclusions" | "firstFailedStage" | "truncated"
    >
  > = {},
): ChatSessionStageFunnel {
  const stages = USER_VALUE_STAGES.map((stage) => tally(stage, rows[stage]));
  const counted =
    over.counted ?? Math.max(0, ...stages.map((row) => row.observations));
  return {
    source: "user_testing",
    total: over.total ?? counted,
    counted,
    exclusions: over.exclusions ?? {
      absent: 0,
      deriving: 0,
      stale: 0,
      failed: 0,
    },
    stages,
    firstFailedStage: over.firstFailedStage ?? {},
    notMeasured: stages.every((row) => row.observations === 0),
    truncated: over.truncated ?? false,
  };
}

describe("a stage state, from its tally", () => {
  it("is unknown when nobody was eligible, however much else is known", () => {
    // The whole point. Four sessions observed this stage and not one of them
    // produced a verdict, so there is nothing to report — not a pass.
    expect(
      stageStateFromTally(
        tally("discovery", { notReached: 3, notMeasured: 1 }),
      ),
    ).toBe("none");
  });

  it("earns ok only when every eligible session passed", () => {
    expect(stageStateFromTally(tally("connection", { passed: 4 }))).toBe("ok");
    // One failure is not a rounding error.
    expect(
      stageStateFromTally(tally("connection", { passed: 99, failed: 1 })),
    ).toBe("warn");
  });

  it("keeps ok honest when the ungraded outnumber the graded", () => {
    // 3 graded, all passed, 5 unmeasured. `ok` is over the eligible three and
    // the meta line has to carry the other five (asserted below).
    expect(
      stageStateFromTally(tally("call", { passed: 3, notMeasured: 5 })),
    ).toBe("ok");
  });

  it("is fail only when no eligible session passed", () => {
    expect(stageStateFromTally(tally("response", { failed: 4 }))).toBe("fail");
  });
});

describe("mapGoalStageFunnel", () => {
  it("answers null rather than inventing an unmeasured model", () => {
    // `null` from the query means "cannot answer this goal" — a deleted
    // cluster, a non-goal axis. A zero funnel means "measured, and it was
    // nothing". Collapsing them here would undo the distinction.
    expect(mapGoalStageFunnel(null)).toBeNull();
    expect(mapGoalStageFunnel(undefined)).toBeNull();
  });

  it("renders an ungraded stage as unknown with no evidence at all", () => {
    const mapped = mapGoalStageFunnel(
      funnelOf({
        connection: { passed: 5 },
        discovery: { notReached: 5 },
      }),
    );

    expect(mapped?.stages.discovery.state).toBe("none");
    // No row: the panel falls through to EMPTY_STAGE_COPY, which says in words
    // that this is not evidence the stage passed. A row would have to claim a
    // tone, and there is no honest tone here.
    expect(mapped?.stages.discovery.evidence).toEqual([]);
  });

  it("maps the chain's userValue onto the panel's value column", () => {
    const mapped = mapGoalStageFunnel(funnelOf({ userValue: { failed: 2 } }));

    expect(mapped?.stages.value.state).toBe("fail");
    expect(mapped?.stages.value.evidence[0]?.observation).toBe(
      "User value failed in every graded session.",
    );
    // The chain's own id must not leak through as a seventh column.
    expect(Object.keys(mapped!.stages)).not.toContain("userValue");
  });

  it("names every non-eligible bucket in the meta line", () => {
    const mapped = mapGoalStageFunnel(
      funnelOf({
        selection: {
          passed: 3,
          failed: 1,
          notReached: 2,
          notMeasured: 1,
          notApplicable: 4,
        },
      }),
    );

    const row = mapped?.stages.selection.evidence[0];
    expect(row?.tone).toBe("warn");
    expect(row?.observation).toBe(
      "Selection failed in 1 of 4 graded sessions.",
    );
    // Where the other seven went. Without this the reader is free to read the
    // denominator as the whole population.
    expect(row?.meta).toBe(
      "4 graded · 2 never got here · 1 not measured · 4 not applicable",
    );
  });

  it("passes the scan-limit flag through for the caller to footnote", () => {
    const mapped = mapGoalStageFunnel(
      funnelOf({ connection: { passed: 1 } }, { truncated: true }),
    );
    expect(mapped?.truncated).toBe(true);
  });
});

describe("where these sessions break", () => {
  it("reads first failures, not the stage with the most failures", () => {
    // `response` fails in more sessions than `discovery` — because discovery
    // broke first and everything downstream inherited it. The diagnosis is
    // discovery, and an implementation summing per-stage `failed` says
    // response.
    const mapped = mapGoalStageFunnel(
      funnelOf(
        {
          connection: { passed: 10 },
          discovery: { passed: 4, failed: 6 },
          response: { failed: 8 },
        },
        { counted: 10, total: 10, firstFailedStage: { discovery: 6 } },
      ),
    );

    expect(mapped?.diagnosisStage).toBe("discovery");
    expect(mapped?.diagnosis.title).toBe(
      "Discovery is where these sessions break.",
    );
    expect(mapped?.diagnosis.detail).toBe(
      "6 of 10 graded sessions failed first at Discovery.",
    );
    // And the panel opens on it.
    expect(mapped?.defaultStage).toBe("discovery");
  });

  it("gives a tie to the earlier stage in the chain", () => {
    const mapped = mapGoalStageFunnel(
      funnelOf(
        { call: { failed: 3 }, response: { failed: 3 } },
        { counted: 6, total: 6, firstFailedStage: { call: 3, response: 3 } },
      ),
    );

    // Both broke three sessions. The earlier one is the one worth fixing, and
    // an implementation iterating object keys would answer whichever the
    // backend happened to serialize first.
    expect(mapped?.diagnosisStage).toBe("call");
  });

  it("says nothing broke when nothing broke, and says it over a denominator", () => {
    const mapped = mapGoalStageFunnel(
      funnelOf(
        { connection: { passed: 8 }, userValue: { passed: 8 } },
        { counted: 8, total: 12 },
      ),
    );

    expect(mapped?.diagnosisStage).toBeNull();
    expect(mapped?.diagnosis.title).toBe(
      "No graded session failed a stage in this goal.",
    );
    // 12 scanned, 8 with a chain. The four without one are not a pass either.
    expect(mapped?.diagnosis.detail).toBe(
      "8 of 12 sessions carried a chain, and none of them broke.",
    );
  });

  it("distinguishes nothing broke from nothing was graded", () => {
    const mapped = mapGoalStageFunnel(
      funnelOf(
        {},
        {
          counted: 0,
          total: 9,
          exclusions: { absent: 7, deriving: 2, stale: 0, failed: 0 },
        },
      ),
    );

    // The pair a reader is most likely to confuse. This one must not read as
    // a clean bill of health.
    expect(mapped?.diagnosis.title).toBe(
      "No session in this goal has a graded chain yet.",
    );
    expect(mapped?.diagnosis.detail).toBe(
      "9 sessions scanned: 7 never derived, 2 still deriving.",
    );
    expect(mapped?.diagnosisStage).toBeNull();
    for (const stage of USER_VALUE_STAGES) {
      const id = stage === "userValue" ? "value" : stage;
      expect(mapped?.stages[id as "connection"].state).toBe("none");
    }
  });
});

describe("which stage the panel opens on", () => {
  it("prefers a red stage over an empty one when there is no first-failure tally", () => {
    // A legacy funnel can carry stage rows with an empty `firstFailedStage`.
    // Opening on `value` would leave the red column unread two along.
    const mapped = mapGoalStageFunnel(
      funnelOf({ discovery: { failed: 3 }, call: { passed: 1, failed: 1 } }),
    );

    expect(mapped?.defaultStage).toBe("discovery");
    // Blame still lands, from the states rather than the tally.
    expect(mapped?.diagnosisStage).toBe("discovery");
  });

  it("falls to a warn stage when nothing is red", () => {
    const mapped = mapGoalStageFunnel(
      funnelOf({ connection: { passed: 4 }, call: { passed: 3, failed: 1 } }),
    );

    expect(mapped?.defaultStage).toBe("call");
    // A warn is not a diagnosis. Nothing broke outright, so nothing is blamed.
    expect(mapped?.diagnosisStage).toBeNull();
  });

  it("falls to value when every stage is unknown", () => {
    expect(mapGoalStageFunnel(funnelOf({}))?.defaultStage).toBe("value");
  });
});
