import { describe, expect, it } from "vitest";
import { parseIterationPredicates } from "@/components/evals/predicates-list";
import { resultFromPredicate } from "../case-scorecard/trial-results";

describe("stored predicate status on the scorecard", () => {
  it("keeps error and not-applicable when parsing stored rows", () => {
    const parsed = parseIterationPredicates({
      predicates: [
        {
          predicate: { type: "toolResultMatchesSchema", schema: "declared" },
          passed: true,
          status: "not_applicable",
          reason: "no tool declares an output schema",
        },
        {
          predicate: { type: "toolResultSizeUnder", maxBytes: 10 },
          passed: false,
          status: "error",
          reason: "the capture is incomplete",
        },
        {
          predicate: { type: "noToolErrors" },
          passed: true,
          status: "invented",
          reason: "ok",
        },
      ],
    });
    expect(parsed?.map((row) => row.status)).toEqual([
      "not_applicable",
      "error",
      undefined,
    ]);
  });

  it("maps error and not-applicable to their own trial states", () => {
    expect(
      resultFromPredicate({
        passed: true,
        status: "not_applicable",
        reason: "no tool declares an output schema",
      }),
    ).toMatchObject({ state: "notApplicable" });
    expect(
      resultFromPredicate({
        passed: false,
        status: "error",
        reason: "the capture is incomplete",
      }),
    ).toMatchObject({ state: "error", reason: "the capture is incomplete" });
    expect(resultFromPredicate({ passed: false, reason: "2 errors" })).toMatchObject(
      { state: "failed" },
    );
  });
});
