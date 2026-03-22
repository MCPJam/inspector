import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { getBillingErrorMessage } from "../billing-entitlements";

describe("getBillingErrorMessage", () => {
  it("formats backend limit payloads for monthly eval runs", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxEvalRunsPerMonth",
          allowedValue: 500,
        }),
      ),
      "fallback",
    );

    expect(message).toBe(
      "This organization has reached its monthly eval run limit (500). Upgrade to continue.",
    );
  });

  it("formats backend limit payloads for non-billing-admin users", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxEvalRunsPerMonth",
          allowedValue: 500,
        }),
      ),
      "fallback",
      false,
    );

    expect(message).toBe(
      "This organization has reached its monthly eval run limit (500). Ask an organization owner to upgrade.",
    );
  });

  it("formats backend limit payloads for workspace sandboxes", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxSandboxesPerWorkspace",
          allowedValue: 5,
        }),
      ),
      "fallback",
    );

    expect(message).toBe(
      "This workspace has reached its sandbox limit (5). Upgrade to continue.",
    );
  });

  it("preserves non-billing ConvexError messages", () => {
    const error = new ConvexError({
      code: "rate_limited",
      retryAfter: 5,
    });
    error.message =
      'ConvexError: {"code":"rate_limited","retryAfter":5}';

    const message = getBillingErrorMessage(error, "fallback");

    expect(message).toBe(
      'ConvexError: {"code":"rate_limited","retryAfter":5}',
    );
  });
});
