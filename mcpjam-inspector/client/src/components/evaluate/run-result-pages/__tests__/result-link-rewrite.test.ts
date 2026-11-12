import { describe, expect, it } from "vitest";
import type { EvalIteration } from "../../../evals/types";
import { modeForTab, tabForMode } from "../iteration-tab";
import { resultLinkRewrite } from "../result-link-rewrite";

const run = { suiteId: "s1", runId: "r1" };
const iterations = [
  { _id: "i1", suiteRunId: "r2", testCaseId: "refund" },
] as EvalIteration[];
const rewrite = (overrides: Partial<Parameters<typeof resultLinkRewrite>[0]>) =>
  resultLinkRewrite({
    enabled: true,
    run,
    resultPage: { caseKey: "refund" },
    fromOldLink: false,
    loading: false,
    iterations,
    ...overrides,
  });

describe("resultLinkRewrite", () => {
  it("leaves a page link alone while the pages are on or loading", () => {
    expect(rewrite({})).toBeNull();
    expect(rewrite({ enabled: undefined })).toBeNull();
  });

  it("falls back to the legacy link with the pages off", () => {
    expect(
      rewrite({
        enabled: false,
        resultPage: { caseKey: "refund", iterationId: "i1", tab: "trace" },
      }),
    ).toBe("/evaluate/suite/s1/runs/r1?iteration=i1&case=refund");
    expect(
      rewrite({ enabled: false, resultPage: { caseKey: "title:Ship it" } }),
    ).toBe("/evaluate/suite/s1/runs/r1");
  });

  it("moves an old link to its page", () => {
    expect(
      rewrite({
        fromOldLink: true,
        resultPage: { caseKey: "refund", iterationId: "i1" },
      }),
    ).toBe("/evaluate/suite/s1/runs/r1/cases/refund/iterations/i1");
    expect(rewrite({ fromOldLink: true })).toBe(
      "/evaluate/suite/s1/runs/r1/cases/refund",
    );
  });

  it("names the case of an `?iteration=` link once iterations load", () => {
    const oldLink = {
      fromOldLink: true,
      resultPage: { caseKey: "", iterationId: "i1" },
    };
    expect(rewrite({ ...oldLink, loading: true })).toBeNull();
    expect(rewrite(oldLink)).toBe(
      "/evaluate/suite/s1/runs/r1/cases/refund/iterations/i1",
    );
    // An iteration nobody recorded stays put and shows not found.
    expect(
      rewrite({ ...oldLink, resultPage: { caseKey: "", iterationId: "gone" } }),
    ).toBeNull();
  });
});

describe("iteration tabs", () => {
  it("maps link tabs to the report's views and back", () => {
    expect(modeForTab("trace")).toBe("timeline");
    expect(modeForTab("replay")).toBe("browser");
    expect(modeForTab(undefined)).toBeUndefined();
    expect(tabForMode("timeline")).toBe("trace");
    expect(tabForMode("browser")).toBe("replay");
    expect(tabForMode("scorecard")).toBe("scorecard");
  });
});
