import { describe, expect, it } from "vitest";
import { hostedOnlyMessage, isHostedOnlyErrorBody } from "../hosted-only";

describe("isHostedOnlyErrorBody", () => {
  it("recognizes the shared hosted-only answer", () => {
    expect(
      isHostedOnlyErrorBody({
        code: "FEATURE_NOT_SUPPORTED",
        details: { reason: "FEATURE_REQUIRES_HOSTED", feature: "Bench" },
      }),
    ).toBe(true);
  });

  it("rejects other FEATURE_NOT_SUPPORTED reasons and junk", () => {
    expect(
      isHostedOnlyErrorBody({
        code: "FEATURE_NOT_SUPPORTED",
        details: { reason: "contract_unavailable" },
      }),
    ).toBe(false);
    expect(isHostedOnlyErrorBody({ code: "FEATURE_NOT_SUPPORTED" })).toBe(
      false,
    );
    expect(isHostedOnlyErrorBody(null)).toBe(false);
    expect(isHostedOnlyErrorBody("FEATURE_REQUIRES_HOSTED")).toBe(false);
  });
});

describe("hostedOnlyMessage", () => {
  it("names the feature and the hosted app", () => {
    expect(
      hostedOnlyMessage({
        feature: "Saving browser profiles",
        hostedUrl: "https://app.mcpjam.com",
      }),
    ).toBe(
      "Saving browser profiles is available in the hosted MCPJam app (https://app.mcpjam.com).",
    );
  });

  it("falls back to generic copy", () => {
    expect(hostedOnlyMessage()).toBe(
      "This feature is available in the hosted MCPJam app (https://app.mcpjam.com).",
    );
  });
});
