/**
 * The per-trial chip vocabulary, and the one invariant it must never break.
 *
 * The sibling of `stage-chain-model.test.ts`, guarding the same rule over a
 * different population: a run's stage may be unmeasured across many trials, a
 * single trial's stage may be unmeasured on its own, and NEITHER may render as
 * a pass. The `passWords` regex is copied verbatim from that file on purpose —
 * two surfaces that disagree about what counts as a pass word would each be
 * individually green while the product says "healthy" somewhere.
 */
import { describe, expect, it } from "vitest";
import {
  STAGE_STATES,
  STAGE_STATE_LABELS,
  USER_VALUE_STAGES,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_OUTCOMES,
  type EvalRunDecisionChain,
  type StageResultRow,
  type StageState,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import {
  UNRECOGNIZED_STATE_LABEL,
  defaultSelectedTrialStage,
  deriveTrialStageChip,
  toTrialCardViews,
} from "../stage-trial-model";

function row(overrides: Partial<StageResultRow> = {}): StageResultRow {
  return { stage: "response", state: "passed", ...overrides } as StageResultRow;
}

/** Six rows in chain order, all passed unless overridden by stage. */
function chainOf(
  states: Partial<Record<UserValueStage, StageState>> = {},
): StageResultRow[] {
  return USER_VALUE_STAGES.map((stage) =>
    row({ stage, state: states[stage] ?? "passed" }),
  );
}

function verifiedChain(
  rows: StageResultRow[],
  firstFailedStage?: UserValueStage,
): EvalRunDecisionChain {
  return {
    status: "verified",
    stages: rows,
    analyzerVersion: 8,
    ...(firstFailedStage ? { firstFailedStage } : {}),
  } as EvalRunDecisionChain;
}

describe("deriveTrialStageChip", () => {
  it("says the OUTCOME for a passed stage, not the word 'passed'", () => {
    const chip = deriveTrialStageChip(row({ stage: "call", state: "passed" }));
    expect(chip.kind).toBe("passed");
    expect(chip.label).toBe(USER_VALUE_STAGE_OUTCOMES.call);
    expect(chip.toneClass).toContain("success");
  });

  it("says only the state word for a failed stage — the reason stays off the chip", () => {
    const chip = deriveTrialStageChip(
      row({ state: "failed", reason: "toolError" }),
    );
    expect(chip.kind).toBe("failed");
    expect(chip.label).toBe(STAGE_STATE_LABELS.failed);
    // The reason belongs on the detail card, where a sentence fits.
    expect(chip.label).not.toContain("tool error");
    expect(chip.toneClass).toContain("destructive");
  });

  it.each([
    ["notReached" as const],
    ["notMeasured" as const],
    ["notApplicable" as const],
  ])("renders %s in its own words, in a neutral tone", (state) => {
    const chip = deriveTrialStageChip(row({ state }));
    expect(chip.kind).toBe("unmeasured");
    // Read from the contract's map, never a hardcoded sentence.
    expect(chip.label).toBe(STAGE_STATE_LABELS[state]);
    expect(chip.toneClass).toContain("muted");
    expect(chip.toneClass).not.toContain("amber");
  });

  it("degrades rather than throwing on a state this build has no word for", () => {
    const chip = deriveTrialStageChip(
      row({ state: "judgeDeferred" as StageState }),
    );
    expect(chip.kind).toBe("unmeasured");
    expect(chip.label).toBe(UNRECOGNIZED_STATE_LABEL);
    expect(chip.toneClass).not.toContain("success");
  });

  it("INVARIANT: only a passed row ever wears a pass word", () => {
    // The same regex as the aggregate chip's invariant, deliberately. It
    // includes the six outcome verbs, so an outcome phrase leaking onto a
    // non-passed row is caught, not just the literal word "passed".
    const passWords =
      /\b(pass|passed|ok|healthy|good|connected|discovered|selected|made|returned|satisfied)\b/i;
    const states: StageState[] = [
      ...STAGE_STATES.filter((state) => state !== "passed"),
      "judgeDeferred" as StageState,
    ];
    for (const state of states) {
      for (const stage of USER_VALUE_STAGES) {
        const chip = deriveTrialStageChip(row({ stage, state }));
        const where = `${stage}/${state}`;
        expect(chip.kind, where).not.toBe("passed");
        expect(chip.toneClass, where).not.toContain("success");
        expect(chip.label, where).not.toMatch(passWords);
      }
    }
  });

  it("never renders a percentage or a wire spelling", () => {
    for (const state of STAGE_STATES) {
      const chip = deriveTrialStageChip(row({ state }));
      expect(chip.label).not.toMatch(/%/);
      expect(chip.label).not.toMatch(/[a-z][A-Z]/);
    }
  });

  it("never produces the aggregate-only kinds", () => {
    // `mixed` needs two trials and `noTrials` describes a run. Neither can
    // mean anything about one row, so neither may be reachable from one.
    for (const state of STAGE_STATES) {
      const chip = deriveTrialStageChip(row({ state }));
      expect(["passed", "failed", "unmeasured"]).toContain(chip.kind);
    }
  });
});

describe("the trial card row", () => {
  it("renders six cards in chain order with 01..06 ordinals", () => {
    const cards = toTrialCardViews(chainOf());
    expect(cards.map((card) => card.stage)).toEqual([...USER_VALUE_STAGES]);
    expect(cards.map((card) => card.ordinal)).toEqual([
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
    ]);
    expect(cards[0]?.label).toBe(USER_VALUE_STAGE_LABELS.connection);
  });

  it("NEVER SORTS — position is meaning, so a reordered chain stays reordered", () => {
    // `notReached` is derived from position upstream. Quietly re-sorting here
    // would repair a broken payload into a different, plausible-looking claim.
    const reversed = [...chainOf()].reverse();
    const cards = toTrialCardViews(reversed);
    expect(cards.map((card) => card.stage)).toEqual(
      [...USER_VALUE_STAGES].reverse(),
    );
    expect(cards[0]?.ordinal).toBe("01");
  });

  it("carries the delivery story across a clean trial", () => {
    const cards = toTrialCardViews(chainOf());
    expect(cards.map((card) => card.chip.label)).toEqual(
      USER_VALUE_STAGES.map((stage) => USER_VALUE_STAGE_OUTCOMES[stage]),
    );
  });
});

describe("defaultSelectedTrialStage", () => {
  it("opens on the contract's firstFailedStage, never a re-derived one", () => {
    // The rows say `selection` failed too, but the contract named `response`.
    // The contract wins: a second derivation that disagreed would look
    // authoritative while being wrong.
    const chain = verifiedChain(
      chainOf({ selection: "failed", response: "failed" }),
      "response",
    );
    expect(defaultSelectedTrialStage(chain)).toBe("response");
  });

  it("opens nothing on a delivered trial", () => {
    expect(defaultSelectedTrialStage(verifiedChain(chainOf()))).toBeNull();
  });

  it("opens the explained row when NO stage failed — the setup-abort shape", () => {
    // A policy block or setup abort measures nothing anywhere, and the only
    // thing worth reading is the reason. Leaving it closed hides the single
    // sentence that explains the trial.
    const rows = USER_VALUE_STAGES.map((stage) =>
      row({ stage, state: "notMeasured", reason: "blockedByPolicy" }),
    );
    expect(defaultSelectedTrialStage(verifiedChain(rows))).toBe("connection");
  });

  it("still opens nothing when the unmeasured rows explain nothing", () => {
    const rows = USER_VALUE_STAGES.map((stage) =>
      row({ stage, state: "notApplicable" }),
    );
    expect(defaultSelectedTrialStage(verifiedChain(rows))).toBeNull();
  });

  it("opens nothing for a withheld or absent chain", () => {
    expect(
      defaultSelectedTrialStage({
        status: "unverified",
        analyzerVersion: 8,
      } as EvalRunDecisionChain),
    ).toBeNull();
    expect(
      defaultSelectedTrialStage({ status: "absent" } as EvalRunDecisionChain),
    ).toBeNull();
  });
});
