import { describe, expect, it } from "vitest";
import { ErrorCode, WebRouteError } from "../../../routes/web/errors";
import {
  isPlatformFeeRefusal,
  platformFeeRefusalError,
} from "../platform-fee-refusal";

describe("isPlatformFeeRefusal", () => {
  it.each(["PLATFORM_FEE_REQUIRED", "ORGANIZATION_SPEND_BUDGET_REACHED"])(
    "recognizes the translated %s refusal",
    (code) => {
      expect(
        isPlatformFeeRefusal(platformFeeRefusalError({ data: { code } })),
      ).toBe(true);
    },
  );

  it("does not claim other refusals that name a reason", () => {
    // A rerun refusal also carries `details.reason`.
    expect(
      isPlatformFeeRefusal(
        new WebRouteError(409, ErrorCode.CONFLICT, "Nothing to rerun.", {
          reason: "RERUN_NOTHING_TO_RERUN",
        }),
      ),
    ).toBe(false);
    expect(
      isPlatformFeeRefusal(new Error('{"code":"PLATFORM_FEE_REQUIRED"}')),
    ).toBe(false);
  });
});
