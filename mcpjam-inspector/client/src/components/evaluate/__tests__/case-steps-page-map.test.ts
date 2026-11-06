import { describe, expect, it } from "vitest";
import { CaseEvaluatorsNavPage } from "../case-steps/case-evaluators-nav-page";
import { CaseStepsNavPage } from "../case-steps/case-steps-page";
import { EVAL_NAV_PAGES, resolveEvalNavPage } from "../nav/eval-nav-pages";

describe("2E page map entries", () => {
  it("registers the four case pages", () => {
    expect(EVAL_NAV_PAGES["case-new"].Page).toBe(CaseStepsNavPage);
    expect(EVAL_NAV_PAGES["case-settings"].Page).toBe(CaseStepsNavPage);
    expect(EVAL_NAV_PAGES["test-run-edit"].Page).toBe(CaseStepsNavPage);
    expect(EVAL_NAV_PAGES["case-evaluators"].Page).toBe(CaseEvaluatorsNavPage);
  });

  it.each([
    { type: "case-new", suiteId: "s" },
    { type: "case-settings", suiteId: "s", testCaseId: "c" },
    { type: "case-evaluators", suiteId: "s", testCaseId: "c" },
    { type: "test-run-edit", suiteId: "s", runId: "r", testCaseId: "c" },
  ] as const)(
    "$type is a page with the flag on and today's route with it off",
    (route) => {
      expect(resolveEvalNavPage(route, true).kind).toBe("page");
      expect(resolveEvalNavPage(route, undefined).kind).toBe("pending");
      expect(resolveEvalNavPage(route, false).kind).toBe("legacy");
    },
  );
});
