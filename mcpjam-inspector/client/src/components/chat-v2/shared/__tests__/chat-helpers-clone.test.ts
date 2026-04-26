import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { cloneUiMessages, formatErrorMessage } from "../chat-helpers";

describe("cloneUiMessages", () => {
  it("deep-clones so mutations do not affect the source", () => {
    const original: UIMessage[] = [
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: "a" }],
      },
    ];
    const copy = cloneUiMessages(original);
    expect(copy).not.toBe(original);
    expect(copy[0]).not.toBe(original[0]);
    expect(copy[0]?.parts).not.toBe(original[0]?.parts);
    (copy[0]?.parts[0] as { text?: string }).text = "b";
    expect((original[0]?.parts[0] as { text?: string }).text).toBe("a");
  });
});

describe("formatErrorMessage", () => {
  it("turns MCPJam model-limit JSON into actionable quota copy", () => {
    const result = formatErrorMessage(
      JSON.stringify({
        code: "user_rate_limit",
        error:
          "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
        retryAfter: 4500000,
        details: "Try again in 75 minutes.",
      }),
    );

    expect(result).toEqual({
      code: "mcpjam_rate_limit",
      message:
        "Add your own API key under LLM Providers in Settings to continue now, or try again in 75 minutes.",
      isRetryable: false,
      isMCPJamPlatformError: true,
    });
  });

  it("does not leak JSON delimiters from structured retry details", () => {
    const result = formatErrorMessage(
      JSON.stringify({
        error: "Daily MCPJam model limit reached.",
        details: { hint: "Try again in 75 minutes" },
      }),
    );

    expect(result).toEqual({
      code: "mcpjam_rate_limit",
      message:
        "Add your own API key under LLM Providers in Settings to continue now, or try again in 75 minutes.",
      isRetryable: false,
      isMCPJamPlatformError: true,
    });
  });

  it("recognizes plain MCPJam model-limit messages", () => {
    const result = formatErrorMessage(
      "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
    );

    expect(result).toEqual({
      code: "mcpjam_rate_limit",
      message:
        "Add your own API key under LLM Providers in Settings to continue now, or try again tomorrow.",
      isRetryable: false,
      isMCPJamPlatformError: true,
    });
  });
});
