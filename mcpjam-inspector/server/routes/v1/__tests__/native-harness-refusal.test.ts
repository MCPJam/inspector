import { describe, expect, it } from "vitest";
import { MCPJAM_HOSTED_ORIGIN } from "../../../config.js";
import {
  translateConvexWriteError,
  translateStructuredConvexRefusal,
} from "../convex-errors.js";
import { nativeHarnessRefusalDetails } from "../native-harness-refusal.js";

const SENTENCE =
  "This organization has used its 20 free native harness turns. Upgrade your plan to keep using them, or switch to MCPJam Harness.";

/** A `ConvexError` as the production error mask delivers it. */
function convexError(data: Record<string, unknown>) {
  return Object.assign(new Error("[Request ID: 9f2] Server Error"), { data });
}

describe("nativeHarnessRefusalDetails", () => {
  it("names the reason and the organization's billing page", () => {
    expect(
      nativeHarnessRefusalDetails("native_harness_trial_exhausted", "org_1"),
    ).toEqual({
      reason: "native_harness_trial_exhausted",
      upgradeUrl: `${MCPJAM_HOSTED_ORIGIN}/organizations/org_1/billing`,
    });
  });

  it("keeps the reason when the caller has no organization", () => {
    expect(
      nativeHarnessRefusalDetails("native_harness_trial_exhausted", undefined),
    ).toEqual({ reason: "native_harness_trial_exhausted" });
  });

  it("is undefined for every other code", () => {
    expect(nativeHarnessRefusalDetails("at_capacity", "org_1")).toBeUndefined();
    expect(nativeHarnessRefusalDetails(undefined, "org_1")).toBeUndefined();
  });
});

describe("a harness switch refused for the used-up trial", () => {
  const refusal = convexError({
    code: "native_harness_trial_exhausted",
    message: SENTENCE,
    organizationId: "org_1",
    granted: 20,
    used: 20,
    upgradeUrl: "https://app.mcpjam.com/organizations/org_1/billing",
  });

  it("answers FORBIDDEN with the backend's sentence, reason and page", () => {
    const result = translateConvexWriteError(refusal, { resource: "Client" });

    expect(result.status).toBe(403);
    expect(result.code).toBe("FORBIDDEN");
    expect(result.message).toBe(SENTENCE);
    expect(result.details).toEqual({
      reason: "native_harness_trial_exhausted",
      upgradeUrl: "https://app.mcpjam.com/organizations/org_1/billing",
    });
  });

  it("answers the same at the v1 error boundary", () => {
    expect(translateStructuredConvexRefusal(refusal)?.status).toBe(403);
  });

  it("forwards no page the backend did not name", () => {
    const result = translateConvexWriteError(
      convexError({ code: "native_harness_trial_exhausted", message: SENTENCE }),
      { resource: "Client" },
    );

    expect(result.details).toEqual({
      reason: "native_harness_trial_exhausted",
    });
  });
});
