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

  it("reads a reason nested under details, as the dialog does", () => {
    const { refusalReason: _reason, ...rest } = body;
    expect(
      formatErrorMessage(
        JSON.stringify({
          ...rest,
          details: { refusalReason: "auto_topup_declined" },
        }),
      )?.code,
    ).toBe(AUTO_TOPUP_DECLINED_CODE);
  });

  it.each([
    ["the sentence alone", `${body.error} ${body.details}`],
    [
      "a prefixed envelope",
      `Backend stream error: 429 ${JSON.stringify(body)}`,
    ],
  ])("names the card from %s", (_, raw) => {
    expect(formatErrorMessage(raw)?.code).toBe(AUTO_TOPUP_DECLINED_CODE);
  });
});
