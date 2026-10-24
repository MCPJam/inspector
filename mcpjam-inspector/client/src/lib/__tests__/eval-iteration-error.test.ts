import { describe, expect, it } from "vitest";
import { describeError } from "@mcpjam/sdk/browser";
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
  it("reads a refusal recorded only in the diagnostics", () => {
    expect(
      describeEvalIterationError({
        status: "failed",
        result: "failed",
        errorDetails: '{"code":"org_keys_required"}',
      }),
    ).toMatchObject({ slug: "eval/ai_refused", rawCode: "org_keys_required" });
    // Diagnostics with no refusal in them still describe nothing.
    expect(
      describeEvalIterationError({
        status: "failed",
        result: "failed",
        errorDetails: "detail text",
      }),
    ).toBeNull();
  });
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
        "Ask an organization admin to set the organization's default AI model.",
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

  it("explains a completed iteration whose model's provider isn't on for the org", () => {
    // A refused BYOK model turn: the iteration completes with a failed
    // result, and only the diagnostics carry the code.
    const sentence =
      'The "anthropic" provider isn\'t turned on for your organization. An organization admin can add it under AI providers in organization settings, or you can pick a model from another provider.';
    expect(
      describeEvalIterationError({
        status: "completed",
        result: "failed",
        error: sentence,
        errorDetails: JSON.stringify({
          ok: false,
          code: "provider_not_configured",
          error: sentence,
        }),
      }),
    ).toMatchObject({
      slug: "eval/ai_refused",
      title: "Unavailable: add an organization provider",
      rawCode: "credential_missing",
      nextSteps: ["Ask an organization admin to add or reconnect a provider."],
    });
  });

  it("reads the typed code on a refused turn recorded as a configuration error", () => {
    // What the server writes now: a failed iteration whose infra error carries
    // the code. The envelope here has no code, so the typed field alone counts.
    expect(
      describeEvalIterationError({
        status: "failed",
        result: "failed",
        error: "The provider isn't turned on for your organization.",
        errorDetails: JSON.stringify({ ok: false, error: "Not turned on." }),
        infraError: {
          class: "configuration",
          layer: "model",
          retryable: false,
          code: "provider_not_configured",
        },
      }),
    ).toMatchObject({ slug: "eval/ai_refused", rawCode: "credential_missing" });
  });

  it("describes an ordinary failed result as it did before", () => {
    const error = "Expected the search_notes tool to be called.";
    expect(
      describeEvalIterationError({
        status: "completed",
        result: "failed",
        error,
      })?.slug,
    ).toBe(describeError(error).slug);
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
