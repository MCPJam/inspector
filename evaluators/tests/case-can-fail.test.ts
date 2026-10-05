import { checkCaseCanFail, evaluatePredicates } from "../src/index";
import {
  buildEmptyAnswerTranscript,
  REQUIRED_GOAL_COMPLETION_JUDGE_LABEL,
} from "../src/predicates/case-can-fail";
import type { Predicate } from "../src/predicates/types";

describe("checkCaseCanFail", () => {
  it("flags a case whose only check is noToolErrors as vacuous", () => {
    const result = checkCaseCanFail([{ type: "noToolErrors" }], [], false);
    expect(result).toMatchObject({ verdict: "vacuous", vacuous: true });
    expect(result.reason).toContain("noToolErrors");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ passed: true });
  });

  it("flags a positive case with no gating check and no expectation", () => {
    expect(checkCaseCanFail(undefined, undefined, false)).toMatchObject({
      verdict: "vacuous",
      vacuous: true,
    });
  });

  it("treats ceilings an empty answer satisfies as passes", () => {
    const result = checkCaseCanFail(
      [
        { type: "noToolErrors" },
        { type: "tokenBudgetUnder", tokens: 5000 },
        { type: "toolCallCountUnder", count: 3 },
        { type: "toolNeverCalled", toolName: "delete_everything" },
      ],
      [],
      false,
    );
    expect(result.verdict).toBe("vacuous");
  });

  it("is not vacuous when an expected tool call is missing", () => {
    const result = checkCaseCanFail(
      [{ type: "noToolErrors" }],
      [{ toolName: "search", arguments: {} }],
      false,
    );
    expect(result).toMatchObject({ verdict: "can_fail", vacuous: false });
    expect(result.reason).toContain("1 expected tool call");
  });

  it("is not vacuous when a gating check fails on an empty answer", () => {
    const result = checkCaseCanFail(
      [{ type: "noToolErrors" }, { type: "finalAssistantMessageNonEmpty" }],
      [],
      false,
    );
    expect(result).toMatchObject({ verdict: "can_fail", vacuous: false });
    expect(result.reason).toContain("finalAssistantMessageNonEmpty");
  });

  it("reads per-turn checks through evaluateTurnChecks", () => {
    const result = checkCaseCanFail([{ type: "noToolErrors" }], [], false, {
      turnChecks: [
        {
          promptIndex: 1,
          checks: [{ type: "responseContains", needle: "done" }],
        },
      ],
      userTurns: 2,
    });
    expect(result.verdict).toBe("can_fail");
    expect(result.reason).toContain("responseContains (turn 2)");
  });

  it("ignores advisory checks: they cannot make a case fail", () => {
    const result = checkCaseCanFail(
      [
        { type: "noToolErrors" },
        { type: "finalAssistantMessageNonEmpty", role: "advisory" },
      ],
      [],
      false,
    );
    expect(result.verdict).toBe("vacuous");
    expect(result.results.map((row) => row.predicate.type)).toEqual([
      "noToolErrors",
    ]);
  });

  it("counts an evidence-error kind as can't tell, never as a pass", () => {
    // `widgetRendered` fails closed on an empty transcript, but nothing about
    // that failure is evidence the agent could not get away with nothing:
    // render observations never reach this transcript at all.
    const widget = checkCaseCanFail(
      [{ type: "noToolErrors" }, { type: "widgetRendered" }],
      [],
      false,
    );
    expect(widget).toMatchObject({ verdict: "cannot_tell", vacuous: false });
    expect(widget.unmeasured).toEqual(["widgetRendered"]);

    // Latency passes vacuously on no calls; still not a pass we may count.
    const latency = checkCaseCanFail(
      [{ type: "noToolErrors" }, { type: "toolLatencyUnder", ms: 500 }],
      [],
      false,
    );
    expect(latency.verdict).toBe("cannot_tell");

    // Discovery reads the catalog, not the agent.
    const discovery = checkCaseCanFail(
      [{ type: "toolNamesUnique" }],
      [],
      false,
    );
    expect(discovery.verdict).toBe("cannot_tell");
  });

  it("reads status, not the boolean: an error row settles nothing", () => {
    // An `error` row carries `passed: false` but is not a failure.
    const rows = evaluatePredicates(
      { toolCalls: [], finalAssistantMessage: "" },
      [{ type: "toolResultSizeUnder", maxBytes: 10 }],
    );
    expect(rows[0]).toMatchObject({ passed: false, status: "error" });
    // On the empty-answer transcript the same kind is fed (results captured,
    // none returned), so it scores a pass and the case is vacuous.
    expect(
      checkCaseCanFail(
        [{ type: "toolResultSizeUnder", maxBytes: 10 }],
        [],
        false,
      ).verdict,
    ).toBe("vacuous");
  });

  it("counts external checks (widget DOM asserts) as can't tell", () => {
    const result = checkCaseCanFail([{ type: "noToolErrors" }], [], false, {
      externalChecks: ["widget assertion textVisible"],
    });
    expect(result).toMatchObject({
      verdict: "cannot_tell",
      unmeasured: ["widget assertion textVisible"],
    });
  });

  it("can't tell when a required goal-completion judge grades the case", () => {
    // A gating judge fails an empty answer, but only a model can say so.
    for (const role of ["required", "gating"]) {
      const result = checkCaseCanFail([{ type: "noToolErrors" }], [], false, {
        goalCompletionJudgeRole: role,
      });
      expect(result).toMatchObject({
        verdict: "cannot_tell",
        vacuous: false,
        unmeasured: [REQUIRED_GOAL_COMPLETION_JUDGE_LABEL],
      });
    }
    // An advisory (or absent) judge decides nothing, so the case stays vacuous.
    for (const role of ["advisory", undefined]) {
      expect(
        checkCaseCanFail([{ type: "noToolErrors" }], [], false, {
          goalCompletionJudgeRole: role,
        }).verdict,
      ).toBe("vacuous");
    }
    // A check that fails an empty answer still settles it, judge or not.
    expect(
      checkCaseCanFail([{ type: "finalAssistantMessageNonEmpty" }], [], false, {
        goalCompletionJudgeRole: "required",
      }).verdict,
    ).toBe("can_fail");
  });

  it("skips negative tests: passing with no calls is their design", () => {
    const result = checkCaseCanFail([{ type: "noToolErrors" }], [], true);
    expect(result).toMatchObject({
      verdict: "not_applicable",
      vacuous: false,
      results: [],
    });
  });

  it("builds an empty transcript with every channel captured", () => {
    const transcript = buildEmptyAnswerTranscript();
    expect(transcript).toMatchObject({
      toolCalls: [],
      finalAssistantMessage: "",
      usage: { totalTokens: 0 },
      turnCount: 1,
      capture: {
        toolResults: "complete",
        toolCallTimings: "complete",
        toolInventory: "complete",
        toolDeclarations: "complete",
      },
    });
  });

  it("is deterministic over suite defaults merged with case checks", () => {
    const suiteDefaults: Predicate[] = [{ type: "noToolErrors" }];
    const caseChecks: Predicate[] = [
      { type: "responseMatches", pattern: "^$" },
    ];
    expect(
      checkCaseCanFail([...suiteDefaults, ...caseChecks], [], false).verdict,
    ).toBe("vacuous");
    expect(
      checkCaseCanFail(
        [...suiteDefaults, { type: "responseMatches", pattern: "\\d" }],
        [],
        false,
      ).verdict,
    ).toBe("can_fail");
  });
});
