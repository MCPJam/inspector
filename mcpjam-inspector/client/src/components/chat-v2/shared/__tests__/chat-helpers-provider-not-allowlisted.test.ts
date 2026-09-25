import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "../chat-helpers";
import { isProviderNotAllowlistedCode } from "@/lib/provider-not-allowlisted";

describe("formatErrorMessage — provider_not_allowlisted", () => {
  // `/stream`'s non-OK body for a provider MCPJam's hosted gateway has not
  // enabled. The backend already words it; the formatter keeps that wording,
  // the upstream status, and the non-retryable flag.
  const body = {
    ok: false,
    code: "provider_not_allowlisted",
    error:
      'The "openai" provider is not enabled on MCPJam\'s AI Gateway provider allowlist, so MCPJam cannot serve this model right now.',
    statusCode: 403,
    isRetryable: false,
    details:
      "Your team has restricted access to this provider. Update your Provider Allowlist settings to enable it.",
  };

  it("keeps the backend's sentence and marks it as MCPJam's, not retryable", () => {
    const formatted = formatErrorMessage(JSON.stringify(body));

    expect(formatted).toMatchObject({
      code: "provider_not_allowlisted",
      message: body.error,
      statusCode: 403,
      isRetryable: false,
      isMCPJamPlatformError: true,
      details: body.details,
    });
  });

  it("reads the mid-stream shape, which uses `message`", () => {
    const { error, ok: _ok, ...rest } = body;
    const formatted = formatErrorMessage(
      JSON.stringify({ ...rest, message: error }),
    );

    expect(formatted?.message).toBe(error);
    expect(formatted?.isMCPJamPlatformError).toBe(true);
  });

  it("picks the allowlist banner from the chunk the server re-emits mid-stream", () => {
    // Exactly what `mcpjam-stream-handler` writes for a mid-stream
    // `provider_not_allowlisted` chunk (pinned in engine-failure-telemetry).
    const formatted = formatErrorMessage(
      new Error(
        JSON.stringify({
          code: "provider_not_allowlisted",
          message: body.error,
          statusCode: 403,
          isRetryable: false,
          details: body.details,
        }),
      ),
    );

    expect(isProviderNotAllowlistedCode(formatted?.code)).toBe(true);
    expect(formatted).toMatchObject({
      message: body.error,
      statusCode: 403,
      isRetryable: false,
    });
  });
});
