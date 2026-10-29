import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "../chat-helpers";
import {
  AUTO_TOPUP_DECLINED_CODE,
  AUTO_TOPUP_DECLINED_MESSAGE,
} from "@/lib/mcpjam-limit";

describe("formatErrorMessage — declined card", () => {
  // `/stream`'s refusal after a declined card paused auto-reload.
  const body = {
    ok: false,
    code: "user_rate_limit",
    refusalReason: "auto_topup_declined",
    limitKind: "total",
    error:
      "Your card was declined, so auto-reload is paused and this organization is out of MCPJam credits.",
    details:
      "Update your payment method in billing and turn auto-reload back on, or top up to keep going.",
    isRetryable: false,
    canTopUp: true,
  };

  it("names the card rather than routing to the out-of-credits dialog", () => {
    expect(formatErrorMessage(JSON.stringify(body))).toEqual({
      code: AUTO_TOPUP_DECLINED_CODE,
      message: AUTO_TOPUP_DECLINED_MESSAGE,
      isRetryable: false,
      isMCPJamPlatformError: true,
    });
  });

  it("leaves other limit refusals on the out-of-credits path", () => {
    const formatted = formatErrorMessage(
      JSON.stringify({
        ...body,
        refusalReason: "allowance_exhausted",
        error: "Monthly MCPJam model limit reached.",
      }),
    );
    expect(formatted?.code).toBe("user_rate_limit");
  });
});
