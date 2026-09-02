/**
 * The chip vocabulary, exhaustively.
 *
 * Every assertion here is about a chip NOT over-claiming. The load-bearing one
 * is the invariant at the bottom: a stage that measured nothing can never wear
 * a word a reader would take for a pass, whatever combination of honest
 * not-verdicts its tally happens to carry.
 */
import { describe, expect, it } from "vitest";
import {
  STAGE_STATE_LABELS,
  USER_VALUE_STAGES,
  USER_VALUE_STAGE_OUTCOMES,
  type EvalStageTally,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import { GOLDEN_STAGE_ANALYTICS } from "@/test/stage-analytics-fixtures";
import {
  defaultSelectedStage,
  deriveStageChip,
  toStageCardViews,
} from "../stage-chain-model";
import { overallSlice } from "../stage-analytics-model";

function tally(overrides: Partial<EvalStageTally> = {}): EvalStageTally {
  return {
    stage: "response",
    applicable: 0,
    reached: 0,
    notReached: 0,
    reachUnknown: 0,
    measured: 0,
    passed: 0,
    failed: 0,
    notMeasured: 0,
    notApplicable: 0,
    excluded: {},
    reasons: [],
    ...overrides,
  } as EvalStageTally;
}

describe("deriveStageChip", () => {
  const cases: {
    name: string;
    input: Partial<EvalStageTally>;
    kind: string;
    contains: string;
  }[] = [
    {
      name: "some passed and some failed is MIXED, before either pure verdict",
      input: { applicable: 3, reached: 3, measured: 3, passed: 1, failed: 2 },
      kind: "mixed",
      contains: "mixed — 1 passed, 2 failed of 3 measured",
    },
    {
      name: "everything measured failed",
      input: { applicable: 2, reached: 2, measured: 2, passed: 0, failed: 2 },
      kind: "failed",
      contains: "failed in 2 of 2 measured",
    },
    {
      name: "everything measured passed, said as the stage's own outcome",
      input: { applicable: 4, reached: 4, measured: 4, passed: 4, failed: 0 },
      kind: "passed",
      contains: USER_VALUE_STAGE_OUTCOMES.response,
    },
    {
      name: "nothing measured, an earlier stage failed",
      input: { applicable: 3, reached: 0, notReached: 3 },
      kind: "unmeasured",
      contains: STAGE_STATE_LABELS.notReached,
    },
    {
      name: "nothing measured, reached and undecided",
      input: { applicable: 3, reached: 3, notMeasured: 3 },
      kind: "unmeasured",
      contains: STAGE_STATE_LABELS.notMeasured,
    },
    {
      name: "nothing measured, nothing captured",
      input: { applicable: 2, reachUnknown: 2 },
      kind: "unmeasured",
      contains: "nothing captured — reach undecidable",
    },
    {
      name: "the stage does not apply to any case here",
      input: { applicable: 0, notApplicable: 3 },
      kind: "unmeasured",
      contains: STAGE_STATE_LABELS.notApplicable,
    },
    {
      name: "nothing at all",
      input: {},
      kind: "noTrials",
      contains: "no trials",
    },
  ];

  for (const row of cases) {
    it(row.name, () => {
      const chip = deriveStageChip(tally(row.input));
      expect(chip.kind).toBe(row.kind);
      expect(chip.label).toContain(row.contains);
    });
  }

  it("takes the DOMINANT unmeasured state when several are present", () => {
    const chip = deriveStageChip(
      tally({ applicable: 5, reached: 1, notReached: 1, notMeasured: 4 }),
    );
    expect(chip.label).toContain("4 ");
    expect(chip.label).toContain(STAGE_STATE_LABELS.notMeasured);
  });

  it("breaks a tie MOST-ALARMING-FIRST", () => {
    // Two apiece. `notReached` says an earlier stage failed and this one never
    // got its chance, which is the more consequential of the two facts.
    const chip = deriveStageChip(
      tally({ applicable: 4, reached: 2, notReached: 2, notMeasured: 2 }),
    );
    expect(chip.label).toContain(STAGE_STATE_LABELS.notReached);
  });

  it("prefers mixed over failed when even one trial passed", () => {
    // 1 of 100 passing is still not "it failed": the population is what makes
    // the finding actionable and collapsing it loses exactly that.
    const chip = deriveStageChip(
      tally({
        applicable: 100,
        reached: 100,
        measured: 100,
        passed: 1,
        failed: 99,
      }),
    );
    expect(chip.kind).toBe("mixed");
  });

  it("INVARIANT: never says passed when nothing was measured", () => {
    // Every combination of the four honest not-verdicts, at three magnitudes.
    // Not one of them may produce a pass word, a pass kind, or the success
    // tone — that is the whole reason `STAGE_STATES` has five members.
    const passWords =
      /\b(pass|passed|ok|healthy|good|connected|discovered|selected|made|returned|satisfied)\b/i;
    const counts = [0, 1, 7];
    for (const notReached of counts) {
      for (const notMeasured of counts) {
        for (const reachUnknown of counts) {
          for (const notApplicable of counts) {
            const chip = deriveStageChip(
              tally({
                applicable: notReached + notMeasured + reachUnknown,
                reached: notMeasured,
                notReached,
                notMeasured,
                reachUnknown,
                notApplicable,
                measured: 0,
                passed: 0,
                failed: 0,
              }),
            );
            const where = `${notReached}/${notMeasured}/${reachUnknown}/${notApplicable}`;
            expect(chip.kind, where).not.toBe("passed");
            expect(chip.toneClass, where).not.toContain("success");
            expect(chip.label, where).not.toMatch(passWords);
          }
        }
      }
    }
  });

  it("says the honest states in WORDS, never as a zero percent", () => {
    for (const chip of [
      deriveStageChip(tally({ applicable: 2, reached: 0, notReached: 2 })),
      deriveStageChip(tally({})),
    ]) {
      expect(chip.label).not.toMatch(/%/);
      expect(chip.label).not.toMatch(/[a-z][A-Z]/);
    }
  });
});

describe("the card row", () => {
  const overall = overallSlice(GOLDEN_STAGE_ANALYTICS)!;

  it("renders six cards in USER_VALUE_STAGES order, numbered by position", () => {
    const cards = toStageCardViews(overall.stages);
    expect(cards.map((card) => card.stage)).toEqual([...USER_VALUE_STAGES]);
    expect(cards.map((card) => card.ordinal)).toEqual([
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
    ]);
  });

  it("never sorts — position is how notReached is derived", () => {
    const reversed = [...overall.stages].reverse();
    expect(toStageCardViews(reversed).map((card) => card.stage)).toEqual(
      [...USER_VALUE_STAGES].reverse(),
    );
  });
});

describe("defaultSelectedStage", () => {
  function cardsFor(
    broken: Partial<Record<UserValueStage, "failed" | "mixed">>,
  ) {
    return toStageCardViews(
      USER_VALUE_STAGES.map((stage) => {
        if (broken[stage] === "failed") {
          return tally({
            stage,
            applicable: 2,
            reached: 2,
            measured: 2,
            failed: 2,
          });
        }
        if (broken[stage] === "mixed") {
          return tally({
            stage,
            applicable: 2,
            reached: 2,
            measured: 2,
            passed: 1,
            failed: 1,
          });
        }
        return tally({
          stage,
          applicable: 2,
          reached: 2,
          measured: 2,
          passed: 2,
        });
      }),
    );
  }

  it("opens on the FIRST break in chain order", () => {
    // A failure at `selection` explains the one at `response` after it, so
    // opening on the later card would put a reader in front of a consequence.
    expect(
      defaultSelectedStage(
        cardsFor({ selection: "failed", response: "failed" }),
      ),
    ).toBe("selection");
  });

  it("counts mixed as a break", () => {
    expect(defaultSelectedStage(cardsFor({ response: "mixed" }))).toBe(
      "response",
    );
  });

  it("opens nothing on a clean run", () => {
    // No break means no "what happened" to answer, and auto-opening anyway
    // would manufacture a question the run did not raise.
    expect(defaultSelectedStage(cardsFor({}))).toBeNull();
  });

  it("opens nothing when the chain measured nothing", () => {
    const cards = toStageCardViews(
      USER_VALUE_STAGES.map((stage) =>
        tally({ stage, applicable: 2, reachUnknown: 2 }),
      ),
    );
    expect(defaultSelectedStage(cards)).toBeNull();
  });

  it("finds the golden document's real break at selection", () => {
    expect(defaultSelectedStage(toStageCardViews(overallStages()))).toBe(
      "selection",
    );
  });

  function overallStages() {
    return overallSlice(GOLDEN_STAGE_ANALYTICS)!.stages;
  }
});
