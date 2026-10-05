import { describe, expect, it, vi } from "vitest";
import {
  CASE_PASSES_WITH_EMPTY_ANSWER,
  caseAuthoringWarnings,
  checkStoredCaseCanFail,
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

describe("checkStoredCaseCanFail", () => {
  it("flags a case whose only check is an inherited noToolErrors default", () => {
    const result = checkStoredCaseCanFail(
      { steps: [prompt()], isNegativeTest: false },
      noToolErrorsDefault,
    );
    expect(result.vacuous).toBe(true);
  });

  it("reads suite defaults: the case's own (empty) list alone would miss them", () => {
    expect(
      resolveEffectiveCasePredicates(
        { steps: [prompt()] },
        noToolErrorsDefault,
      ),
    ).toEqual(noToolErrorsDefault);
    expect(
      resolveEffectiveCasePredicates(
        { predicates: { mode: "replace", list: [] } },
        noToolErrorsDefault,
      ),
    ).toBeUndefined();
  });

  it("is not vacuous when a step expects a tool call", () => {
    const result = checkStoredCaseCanFail(
      { steps: [prompt(), toolCallAssert] },
      noToolErrorsDefault,
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
      noToolErrorsDefault,
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
      noToolErrorsDefault,
    );
    expect(result.verdict).toBe("cannot_tell");
  });

  it("skips negative tests", () => {
    expect(
      checkStoredCaseCanFail(
        { steps: [prompt()], isNegativeTest: true },
        noToolErrorsDefault,
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
        noToolErrorsDefault,
      ).verdict,
    ).toBe("can_fail");
  });
});

describe("caseAuthoringWarnings", () => {
  it("warns (code + reason) on a case that can never fail", () => {
    const [warning] = caseAuthoringWarnings(
      { steps: [prompt()] },
      { defaultPredicates: noToolErrorsDefault },
    );
    expect(warning.code).toBe(CASE_PASSES_WITH_EMPTY_ANSWER);
    expect(warning.message).toContain("passes when the agent does nothing");
    expect(warning.message).toContain("noToolErrors");
  });

  it("says nothing about a case that can fail, or one it cannot read", () => {
    expect(
      caseAuthoringWarnings(
        { steps: [prompt(), toolCallAssert] },
        { defaultPredicates: noToolErrorsDefault },
      ),
    ).toEqual([]);
    expect(caseAuthoringWarnings(undefined, null)).toEqual([]);
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
      { defaultPredicates: noToolErrorsDefault },
    );
    expect(result.committed[0].warnings?.map((w) => w.code)).toEqual([
      "OTHER",
      CASE_PASSES_WITH_EMPTY_ANSWER,
    ]);
    expect(result.committed[1].warnings).toBeUndefined();
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
    );
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
      ),
    ).resolves.toEqual(["tc"]);
  });
});
