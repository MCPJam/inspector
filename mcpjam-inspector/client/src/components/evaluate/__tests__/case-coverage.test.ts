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
    expect(c.userValue).toMatchObject({ required: 0, advisory: 1 });
    expect(c.response).toMatchObject({ required: 1, advisory: 0 });
  });

  it("counts a real route as one required Selection rule", () => {
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
    expect(c.selection.required).toBe(1);
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
    expect(c.selection.required).toBe(0);
  });

  it("marks the links only a built-in runner check covers", () => {
    // Read off the rows the scorecard renders: connection and discovery carry
    // a runner check on every case, call and response only when the case gives
    // the runner a call to measure.
    const bare = coverageForCase(card());
    expect(bare.connection.runner).toBe(true);
    expect(bare.discovery.runner).toBe(true);
    expect(bare.call.runner).toBe(false);
    expect(bare.response.runner).toBe(false);
    // No runner check at all here, so an empty one is a gap.
    expect(bare.selection.runner).toBe(false);
    expect(bare.userValue.runner).toBe(false);

    const routed = coverageForCase(
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
    // A route also grades its arguments, at Tool call, so that link has a
    // rule of its own; Response is left to its runner check.
    expect(routed.call).toMatchObject({ required: 1, runner: false });
    expect(routed.response.runner).toBe(true);
  });

  it("never counts a runner check as a rule", () => {
    // It decides nothing, so "1 advisory" on Connection would be invented.
    const c = coverageForCase(card());
    for (const stage of ["connection", "discovery"] as const) {
      expect(c[stage]).toMatchObject({ required: 0, advisory: 0 });
    }
  });

  it("lets an authored check, not the runner check, describe a stage", () => {
    const c = coverageForCase(
      card({
        steps: [
          prompt,
          { id: "a1", kind: "assert", assertion: { type: "noToolErrors" } },
        ],
      }),
    );
    expect(c.response).toMatchObject({ required: 1, runner: false });
  });

  it("records configured judge coverage while scheduling policy is unknown", () => {
    const c = coverageForCase(
      card({
        expectedOutput: "states the email",
        suiteJudgeConfig: { goalCompletion: { enabled: true } },
      }),
    );
    expect(c.userValue.judge).toBe(true);
  });

  it("does not count an explicitly disabled or skipped judge", () => {
    for (const config of [
      { suiteJudgeConfig: { goalCompletion: { enabled: false } } },
      {
        suiteJudgeConfig: { goalCompletion: { enabled: true } },
        judgeConfigOverride: { goalCompletion: { enabled: false } },
      },
    ]) {
      expect(coverageForCase(card(config)).userValue.judge).toBe(false);
    }
  });

});

describe("coverageDetail", () => {
  const empty = { required: 0, advisory: 0, judge: false, runner: false };

  it("says a built-in runner check covers the link", () => {
    expect(coverageDetail({ ...empty, runner: true }, 0).label).toBe(
      "Built-in runner check",
    );
  });

  it("still points at a suggestion where only the runner check looks", () => {
    // The runner check is not an assertion, so it does not close the gap a
    // suggestion would fill.
    const detail = coverageDetail({ ...empty, runner: true }, 2);
    expect(detail.label).toBe("Built-in runner check · 2 suggested");
    expect(detail.toneClass).toBe(coverageDetail({ ...empty }, 2).toneClass);
  });

  it("prints the configuration line the suite table prints", () => {
    expect(coverageDetail({ ...empty, required: 2, advisory: 1 }, 0).label).toBe(
      "2 required · 1 advisory",
    );
  });

  it("names the judge alongside the checks", () => {
    expect(coverageDetail({ ...empty, required: 1, judge: true }, 0).label).toBe(
      "1 required · judge",
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
    const configured = coverageDetail({ ...empty, required: 1 }, 0);
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
