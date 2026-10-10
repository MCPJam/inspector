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

describe("describeEvalIterationError — organization AI-key refusals", () => {
  it("tells a setup failure refused by the org's policy apart from a host failure", () => {
    const error = describeEvalIterationError({
      status: "setup_failed",
      result: "failed",
      error:
        "Model selection refused — org_keys_required: this organization requires its own provider keys.",
    })!;
    expect(error).toMatchObject({
      slug: "eval/ai_refused",
      title: "Organization provider required",
      severity: "warning",
      rawCode: "org_keys_required",
      nextSteps: ["Choose a model from an organization provider."],
    });
    expect(error.oneLine).not.toMatch(/host's servers/);
  });

  it("reads the code from the diagnostics when the message has none", () => {
    expect(
      describeEvalIterationError({
        status: "setup_failed",
        result: "failed",
        error: "Setup failed.",
        errorDetails: JSON.stringify({ code: "org_model_unconfigured" }),
      }),
    ).toMatchObject({
      slug: "eval/ai_refused",
      rawCode: "org_model_unconfigured",
      nextSteps: [
        "Ask an organization admin to set the organization's default models.",
      ],
    });
  });

  it("recognizes credential_missing from the org resolver", () => {
    expect(
      describeEvalIterationError({
        status: "setup_failed",
        result: "failed",
        error: "credential_missing: the saved org connection is gone",
      })?.slug,
    ).toBe("eval/ai_refused");
  });

  it("leaves other setup failures as they were", () => {
    expect(
      describeEvalIterationError({
        status: "setup_failed",
        result: "failed",
        error: "Could not connect to server",
      })?.slug,
    ).toBe("eval/setup_failed");
  });
});
