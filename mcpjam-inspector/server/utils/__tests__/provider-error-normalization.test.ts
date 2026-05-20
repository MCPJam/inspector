import { describe, expect, it } from "vitest";
import {
  formatProviderOverloadError,
  isProviderOverloadError,
} from "../provider-error-normalization";

describe("provider error normalization", () => {
  it("detects retry-exhausted overload errors", () => {
    expect(
      isProviderOverloadError({
        message: "Failed after 3 attempts. Last error: Overloaded",
      }),
    ).toBe(true);
  });

  it("detects Anthropic overload status and body", () => {
    expect(
      isProviderOverloadError({
        message: "Error",
        statusCode: 529,
        responseBody:
          '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      }),
    ).toBe(true);
  });

  it("formats overloads as retryable user-facing errors", () => {
    expect(JSON.parse(formatProviderOverloadError({ statusCode: 529 }))).toEqual({
      code: "provider_overloaded",
      message:
        "That model is temporarily overloaded. Try again in a moment or switch models.",
      statusCode: 529,
      isRetryable: true,
    });
  });
});
