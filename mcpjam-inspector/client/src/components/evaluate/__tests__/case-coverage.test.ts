import { describe, expect, it } from "vitest";
import type { TestStep } from "@/shared/steps";
import { buildCaseScorecard } from "../case-scorecard/case-scorecard-model";
import {
  coverageDetail,
  coverageDetailByStage,
  coverageForCase,
} from "../case-scorecard/case-coverage";
import type { Suggestion } from "../case-scorecard/suggest-from-run";

const prompt: TestStep = { id: "s1", kind: "prompt", prompt: "ask" };

const card = (over: Parameters<typeof buildCaseScorecard>[0] | object = {}) =>
  buildCaseScorecard({
    steps: [prompt],
    toolsChoice: "unset",
    ...(over as object),
  } as Parameters<typeof buildCaseScorecard>[0]);

const suggestionAt = (stage: Suggestion["stage"]): Suggestion =>
  ({ stage }) as Suggestion;

describe("coverageForCase", () => {
  it("counts authored checks by role, at their own stage", () => {
    // "Its own stage" is the analyzer's answer, not the page's: `noToolErrors`
    // files at RESPONSE under analyzer 11 and only the advisory
    // `responseContains` lands on user value. Counting the tool error at user
    // value as well is the double-count that bump removed.
    const c = coverageForCase(
      card({
        steps: [
          prompt,
          { id: "a1", kind: "assert", assertion: { type: "noToolErrors" } },
          {
            id: "a2",
            kind: "assert",
            assertion: {
              type: "responseContains",
              needle: "x",
              role: "advisory",
              severity: "warn",
            },
          },
        ],
      }),
    );
    expect(c.userValue).toMatchObject({ gates: 0, warn: 1 });
    expect(c.response).toMatchObject({ gates: 1, warn: 0 });
  });

  it("counts a real route as one Selection gate", () => {
    const c = coverageForCase(
      card({
        steps: [
          prompt,
          {
            id: "t1",
            kind: "assert",
            assertion: {
              type: "toolCalledWith",
              toolName: "get_me",
              args: { args: {} },
            },
          },
        ],
        toolsChoice: "tools",
      }),
    );
    expect(c.selection.gates).toBe(1);
  });

  it("does NOT count a route that asserts nothing", () => {
    // "Any route — graded by the checks below" is not a gate.
    const c = coverageForCase(
      card({
        steps: [
          prompt,
          { id: "a1", kind: "assert", assertion: { type: "noToolErrors" } },
        ],
      }),
    );
    expect(c.selection.gates).toBe(0);
  });

  it("marks the links only the runner observes", () => {
    const c = coverageForCase(card());
    expect(c.connection.runner).toBe(true);
    expect(c.discovery.runner).toBe(true);
    expect(c.call.runner).toBe(true);
    // These three can be authored, so an empty one is a gap, not runner-observed.
    expect(c.selection.runner).toBe(false);
    expect(c.response.runner).toBe(false);
    expect(c.userValue.runner).toBe(false);
  });

  it("records the judge at user value when it runs for the case", () => {
    const c = coverageForCase(
      card({
        expectedOutput: "states the email",
        suiteJudgeConfig: { goalCompletion: { enabled: true } },
      }),
    );
    expect(c.userValue.judge).toBe(true);
  });
});

describe("coverageDetail", () => {
  const empty = { gates: 0, warn: 0, report: 0, judge: false, runner: false };

  it("says what the runner observes", () => {
    expect(coverageDetail({ ...empty, runner: true }, 0).label).toBe(
      "Observed by the runner",
    );
  });

  it("prints the configuration line the suite table prints", () => {
    expect(coverageDetail({ ...empty, gates: 2, warn: 1 }, 0).label).toBe(
      "2 gates · 1 warn",
    );
  });

  it("names the judge alongside the checks", () => {
    expect(coverageDetail({ ...empty, gates: 1, judge: true }, 0).label).toBe(
      "1 gate · judge",
    );
  });

  it("goes amber ONLY when a gap has something that would fill it", () => {
    const withSuggestion = coverageDetail(empty, 2);
    const without = coverageDetail(empty, 0);
    expect(withSuggestion.label).toBe("No assertion here · 2 suggested");
    expect(without.label).toBe("No evaluator");
    expect(withSuggestion.toneClass).not.toBe(without.toneClass);
  });

  it("keeps a configured stage neutral — the chip above carries the tone", () => {
    const configured = coverageDetail({ ...empty, gates: 1 }, 0);
    const gap = coverageDetail(empty, 0);
    expect(configured.toneClass).toBe(gap.toneClass);
  });
});

describe("coverageDetailByStage", () => {
  it("leaves Response neutral on a case with nothing to suggest there", () => {
    // Nothing routes to Response under PREDICATE_STAGE in this release, so
    // every case would be permanently amber there if a bare gap were amber.
    const detail = coverageDetailByStage(card(), []);
    expect(detail.response?.label).toBe("No evaluator");
  });

  it("counts suggestions against the stage they would land on", () => {
    const detail = coverageDetailByStage(card(), [
      suggestionAt("selection"),
      suggestionAt("selection"),
    ]);
    expect(detail.selection?.label).toBe("No assertion here · 2 suggested");
  });

  it("covers every stage of the chain", () => {
    const detail = coverageDetailByStage(card(), []);
    expect(Object.keys(detail)).toHaveLength(6);
  });
});
