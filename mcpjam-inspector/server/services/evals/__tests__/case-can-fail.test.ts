import { describe, expect, it, vi } from "vitest";
import {
  CASE_PASSES_WITH_EMPTY_ANSWER,
  CASE_PASSES_WITH_EMPTY_ANSWER_MESSAGE,
  caseAuthoringWarnings,
  checkStoredCaseCanFail,
  goalCompletionJudgeRoleOf,
  recordRunVacuousCases,
  resolveEffectiveCasePredicates,
  withCaseAuthoringWarnings,
} from "../case-can-fail.js";

const prompt = (text = "Summarize my open tickets.") => ({
  id: "p1",
  kind: "prompt" as const,
  prompt: text,
});
const toolCallAssert = {
  id: "a1",
  kind: "assert" as const,
  assertion: {
    type: "toolCalledWith" as const,
    toolName: "list_tickets",
    args: { args: {} },
  },
};
const noToolErrorsDefault = [{ type: "noToolErrors" as const }];
const suiteWithDefaults = { defaultPredicates: noToolErrorsDefault };
const requiredJudgeSuite = {
  ...suiteWithDefaults,
  judgeConfig: { goalCompletion: { enabled: true, role: "required" } },
};

describe("checkStoredCaseCanFail", () => {
  it("flags a case whose only check is an inherited noToolErrors default", () => {
    const result = checkStoredCaseCanFail(
      { steps: [prompt()], isNegativeTest: false },
      suiteWithDefaults,
    );
    expect(result.vacuous).toBe(true);
  });

  it("reads suite defaults: the case's own (empty) list alone would miss them", () => {
    expect(
      resolveEffectiveCasePredicates({ steps: [prompt()] }, suiteWithDefaults),
    ).toEqual(noToolErrorsDefault);
    expect(
      resolveEffectiveCasePredicates(
        { predicates: { mode: "replace", list: [] } },
        suiteWithDefaults,
      ),
    ).toBeUndefined();
  });

  it("is not vacuous when a step expects a tool call", () => {
    const result = checkStoredCaseCanFail(
      { steps: [prompt(), toolCallAssert] },
      suiteWithDefaults,
    );
    expect(result).toMatchObject({ verdict: "can_fail", vacuous: false });
  });

  it("grades a per-turn check an empty answer fails", () => {
    const result = checkStoredCaseCanFail(
      {
        steps: [
          prompt(),
          {
            id: "a2",
            kind: "assert",
            assertion: { type: "responseContains", needle: "ticket" },
          },
        ],
      },
      suiteWithDefaults,
    );
    expect(result.verdict).toBe("can_fail");
  });

  it("counts widget checks as can't tell", () => {
    const result = checkStoredCaseCanFail(
      {
        steps: [
          prompt(),
          {
            id: "w1",
            kind: "assert",
            assertion: {
              kind: "textVisible",
              toolName: "show_board",
              text: "Board",
            },
          },
        ],
      },
      suiteWithDefaults,
    );
    expect(result.verdict).toBe("cannot_tell");
  });

  it("skips negative tests", () => {
    expect(
      checkStoredCaseCanFail(
        { steps: [prompt()], isNegativeTest: true },
        suiteWithDefaults,
      ).verdict,
    ).toBe("not_applicable");
  });

  it("falls back to legacy query/expectedToolCalls when a case has no steps", () => {
    expect(
      checkStoredCaseCanFail(
        {
          query: "list tickets",
          expectedToolCalls: [{ toolName: "list_tickets", arguments: {} }],
        },
        suiteWithDefaults,
      ).verdict,
    ).toBe("can_fail");
  });

  it("can't tell when the suite's goal-completion judge is required", () => {
    expect(
      checkStoredCaseCanFail({ steps: [prompt()] }, requiredJudgeSuite),
    ).toMatchObject({ verdict: "cannot_tell", vacuous: false });
    // The case opted out of the judge: nothing gates it any more.
    expect(
      checkStoredCaseCanFail(
        {
          steps: [prompt()],
          judgeConfigOverride: { goalCompletion: { enabled: false } },
        },
        requiredJudgeSuite,
      ).verdict,
    ).toBe("vacuous");
  });
});

describe("goalCompletionJudgeRoleOf", () => {
  it("layers the suite's setting and the case's opt-out like the backend", () => {
    // The default judge is on and advisory.
    expect(goalCompletionJudgeRoleOf({}, {})).toBe("advisory");
    expect(goalCompletionJudgeRoleOf({}, requiredJudgeSuite)).toBe("required");
    expect(
      goalCompletionJudgeRoleOf(
        {},
        { judgeConfig: { goalCompletion: { role: "gating" } } },
      ),
    ).toBe("gating");
    expect(
      goalCompletionJudgeRoleOf(
        {},
        {
          judgeConfig: { goalCompletion: { enabled: false, role: "required" } },
        },
      ),
    ).toBeUndefined();
    // The case's setting is layered last, so it decides either way.
    expect(
      goalCompletionJudgeRoleOf(
        { judgeConfigOverride: { goalCompletion: { enabled: true } } },
        {
          judgeConfig: { goalCompletion: { enabled: false, role: "required" } },
        },
      ),
    ).toBe("required");
  });
});

describe("caseAuthoringWarnings", () => {
  it("warns with the mirrored code and message on a case that can never fail", () => {
    expect(
      caseAuthoringWarnings({ steps: [prompt()] }, suiteWithDefaults),
    ).toEqual([
      {
        code: CASE_PASSES_WITH_EMPTY_ANSWER,
        message: CASE_PASSES_WITH_EMPTY_ANSWER_MESSAGE,
      },
    ]);
    expect(CASE_PASSES_WITH_EMPTY_ANSWER).toBe("case_passes_with_empty_answer");
  });

  it("says nothing about a case that can fail, or one it cannot read", () => {
    expect(
      caseAuthoringWarnings(
        { steps: [prompt(), toolCallAssert] },
        suiteWithDefaults,
      ),
    ).toEqual([]);
    expect(
      caseAuthoringWarnings({ steps: [prompt()] }, requiredJudgeSuite),
    ).toEqual([]);
    expect(caseAuthoringWarnings(undefined, null)).toEqual([]);
    // An unread suite hides the defaults and judge that decide the verdict.
    expect(caseAuthoringWarnings({ steps: [prompt()] }, null)).toEqual([]);
  });

  it("appends the warning to each committed batch entry it applies to", () => {
    const result = withCaseAuthoringWarnings(
      {
        committed: [
          { index: 0, warnings: [{ code: "OTHER", message: "kept" }] },
          { index: 1 },
        ],
        failed: [],
      },
      [{ steps: [prompt()] }, { steps: [prompt(), toolCallAssert] }],
      suiteWithDefaults,
    );
    expect(result.committed[0].warnings?.map((w) => w.code)).toEqual([
      "OTHER",
      CASE_PASSES_WITH_EMPTY_ANSWER,
    ]);
    expect(result.committed[1].warnings).toBeUndefined();
    expect(result.failed).toEqual([]);
  });
});

describe("recordRunVacuousCases", () => {
  it("records the vacuous case ids using the run's own resolver", async () => {
    const mutation = vi.fn().mockResolvedValue({ recorded: true });
    const ids = await recordRunVacuousCases(
      { mutation },
      "run-1",
      [
        { _id: "tc-vacuous", steps: [prompt()] },
        { _id: "tc-real", steps: [prompt(), toolCallAssert] },
      ],
      () => noToolErrorsDefault,
      {},
    );
    expect(ids).toEqual(["tc-vacuous"]);
    expect(mutation).toHaveBeenCalledWith("testSuites:recordRunVacuousCases", {
      runId: "run-1",
      testCaseIds: ["tc-vacuous"],
    });
  });

  it("writes nothing when no case is vacuous", async () => {
    const mutation = vi.fn();
    await recordRunVacuousCases(
      { mutation },
      "run-1",
      [{ _id: "tc-real", steps: [prompt(), toolCallAssert] }],
      () => noToolErrorsDefault,
      {},
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it("does not guess when the judge setting is unknown or gating", async () => {
    const mutation = vi.fn();
    const cases = [{ _id: "tc", steps: [prompt()] }];
    expect(
      await recordRunVacuousCases(
        { mutation },
        "run-1",
        cases,
        () => [],
        undefined,
      ),
    ).toEqual([]);
    expect(
      await recordRunVacuousCases(
        { mutation },
        "run-1",
        cases,
        () => [],
        requiredJudgeSuite,
      ),
    ).toEqual([]);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("never fails the run start when the backend refuses", async () => {
    const mutation = vi.fn().mockRejectedValue(new Error("unknown function"));
    await expect(
      recordRunVacuousCases(
        { mutation },
        "run-1",
        [{ _id: "tc", steps: [prompt()] }],
        () => undefined,
        {},
      ),
    ).resolves.toEqual(["tc"]);
  });
});
