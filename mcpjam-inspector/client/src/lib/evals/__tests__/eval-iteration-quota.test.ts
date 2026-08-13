import { describe, expect, it } from "vitest";
import {
  calculateEvalIterationRequest,
  getEvalIterationQuotaDisabledReason,
} from "@/lib/eval-iteration-quota";

const quota = {
  used: 73,
  allowed: 75,
  resetsAt: Date.UTC(2026, 7, 14),
  windowKind: "day" as const,
};

describe("getEvalIterationQuotaDisabledReason", () => {
  it("charges models multiplied by iterations", () => {
    expect(calculateEvalIterationRequest(3, 4)).toBe(12);
  });

  it("allows a run that fits the remaining quota", () => {
    expect(getEvalIterationQuotaDisabledReason(quota, 2)).toBeNull();
  });

  it("blocks a multi-model run that exceeds the remaining quota", () => {
    expect(getEvalIterationQuotaDisabledReason(quota, 3)).toContain(
      "needs 3 eval iterations, but only 2 remain"
    );
  });

  it("blocks every run after the limit is reached", () => {
    expect(
      getEvalIterationQuotaDisabledReason({ ...quota, used: 75 }, 1)
    ).toContain("Eval iteration limit reached");
  });
});
