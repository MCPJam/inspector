import { describe, expect, it } from "vitest";
import { PlatformApiError } from "@mcpjam/sdk/platform";
import { toToolError } from "../mcpjam.js";

describe("toToolError", () => {
  it("tells the model when an included operation's limit lifts", () => {
    const result = toToolError(
      new PlatformApiError("MCPJam's daily budget is used up.", "RATE_LIMITED", {
        status: 429,
        retryAfter: 600,
        details: { code: "platform_capacity", canTopUp: false },
      }),
      "Generate failed.",
    );
    expect(result.error).toBe(
      "MCPJam's daily budget is used up. Retry after 600s, not sooner. This is a usage limit: topping up credits does not lift it.",
    );
    expect(result.refusal).toMatchObject({
      reason: "platform_capacity",
      canTopUp: false,
      retryAfterSeconds: 600,
    });
  });

  it("leaves every other error as its message", () => {
    expect(toToolError(new Error("boom"), "Failed.")).toEqual({
      error: "boom",
    });
    expect(toToolError("nope", "Failed.")).toEqual({ error: "Failed." });
  });
});
