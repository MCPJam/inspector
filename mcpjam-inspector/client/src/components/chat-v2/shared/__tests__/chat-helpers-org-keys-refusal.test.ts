import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "../chat-helpers";

describe("formatErrorMessage — organization AI-key refusals", () => {
  it("carries the /stream 403 body's code, sentence and non-retryable flag", () => {
    const formatted = formatErrorMessage(
      JSON.stringify({
        ok: false,
        code: "org_keys_required",
        error:
          "This organization requires its own provider keys for AI features. Choose a model from an organization provider.",
        isRetryable: false,
        remediation: "choose_org_model",
        organizationId: "org_1",
      }),
    );

    expect(formatted).toMatchObject({
      code: "org_keys_required",
      message:
        "This organization requires its own provider keys for AI features. Choose a model from an organization provider.",
      isRetryable: false,
      isMCPJamPlatformError: false,
    });
    expect(JSON.parse(formatted!.details!)).toEqual({
      code: "org_keys_required",
      remediation: "choose_org_model",
    });
  });

  it("reads a mid-stream chunk, which uses `message` and `statusCode`", () => {
    expect(
      formatErrorMessage(
        JSON.stringify({
          code: "provider_unavailable",
          message: "The organization's provider is temporarily unavailable.",
          statusCode: 503,
          isRetryable: true,
        }),
      ),
    ).toMatchObject({
      code: "provider_unavailable",
      statusCode: 503,
      isRetryable: true,
    });
  });

  it("defaults retryability from the code when the body leaves it out", () => {
    expect(
      formatErrorMessage(
        JSON.stringify({ code: "ai_policy_unavailable", error: "Try again." }),
      )?.isRetryable,
    ).toBe(true);
    expect(
      formatErrorMessage(
        JSON.stringify({ code: "credential_missing", error: "Gone." }),
      )?.isRetryable,
    ).toBe(false);
  });

  it("reads a worker's `<code>: <sentence>` message", () => {
    expect(
      formatErrorMessage(
        new Error("org_model_unconfigured: no default model is configured"),
      ),
    ).toMatchObject({
      code: "org_model_unconfigured",
      message: "no default model is configured",
      isRetryable: false,
    });
  });

  it("leaves other errors alone", () => {
    expect(formatErrorMessage("plain failure")).toEqual({
      message: "plain failure",
    });
  });
});
