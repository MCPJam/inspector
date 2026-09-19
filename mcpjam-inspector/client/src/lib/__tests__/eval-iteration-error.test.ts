import { describe, expect, it } from "vitest";
import { describeEvalIterationError } from "../eval-iteration-error";

describe("describeEvalIterationError", () => {
  it("turns heartbeat loss into a timeout while retaining pretty-printed diagnostics", () => {
    const error = describeEvalIterationError({
      status: "failed",
      result: "failed",
      error: "Worker heartbeat lost.",
      errorDetails: '{"worker":"stopped"}',
    })!;
    expect(error).toMatchObject({
      slug: "eval/timed_out",
      title: "Run timed out",
      severity: "warning",
    });
    expect(error.oneLine).not.toContain("heartbeat");
    expect(error.rawMessage).toBe(
      'Worker heartbeat lost.\n\n{\n  "worker": "stopped"\n}',
    );
  });
  it.each([
    ["timed_out", "warning"],
    ["setup_failed", "error"],
    ["cancelled", "info"],
  ] as const)(
    "presents %s even without an error string",
    (status, severity) => {
      expect(
        describeEvalIterationError({ status, result: "failed" }),
      ).toMatchObject({ slug: `eval/${status}`, severity });
    },
  );
  it("preserves unknown failures and non-JSON diagnostic text", () => {
    expect(
      describeEvalIterationError({
        status: "failed",
        result: "failed",
        error: "Unexpected failure",
        errorDetails: "detail text",
      })?.rawMessage,
    ).toBe("Unexpected failure\n\ndetail text");
  });
  it("does not confuse a failed grade with an execution error", () => {
    expect(
      describeEvalIterationError({ status: "completed", result: "failed" }),
    ).toBeNull();
  });
});
