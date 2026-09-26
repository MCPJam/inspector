import { describe, expect, it } from "vitest";
import { journeyRunDisplayStatus } from "../journey-run-format";

describe("journeyRunDisplayStatus", () => {
  it("reads the two deliberate endings off the error marker", () => {
    expect(
      journeyRunDisplayStatus({ status: "failed", error: "canceled" }),
    ).toBe("canceled");
    expect(
      journeyRunDisplayStatus({ status: "failed", error: "stale_runner" }),
    ).toBe("stale");
  });

  it("calls a run that finished executing and is waiting on grades 'grading'", () => {
    expect(
      journeyRunDisplayStatus({
        status: "running",
        report: { undecidedReason: "gradingPending" },
      }),
    ).toBe("grading");
  });

  it("keeps 'running' while the sessions themselves are still going", () => {
    expect(
      journeyRunDisplayStatus({
        status: "running",
        report: { undecidedReason: "executionPending" },
      }),
    ).toBe("running");
    expect(journeyRunDisplayStatus({ status: "running" })).toBe("running");
  });

  it("never relabels a run the backend already settled", () => {
    expect(
      journeyRunDisplayStatus({
        status: "completed",
        report: { undecidedReason: "gradingPending" },
      }),
    ).toBe("completed");
  });
});
