/**
 * A chat credit refusal that carries a structured `recovery` is worded as the
 * one action MCPJam wants for this account — upgrade on Free, buy credits on
 * paid — with its exact link, never "try again" or BYOK. A refusal without one
 * (an older backend) keeps the retry/BYOK fallback.
 */
import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "../chat-helpers";

const BILLING_URL = "https://app.mcpjam.com/billing";

const refusal = (recovery: Record<string, unknown> | undefined, extra = {}) =>
  JSON.stringify({
    ok: false,
    code: "user_rate_limit",
    error: "Out of MCPJam credits.",
    retryAfter: 0,
    ...(recovery ? { recovery } : {}),
    ...extra,
  });

describe("formatErrorMessage — MCPJam credit recovery", () => {
  it("tells a Free account to upgrade, with the link, and nothing else", () => {
    const formatted = formatErrorMessage(
      refusal({
        version: 1,
        reason: "out_of_credits",
        action: "upgrade_plan",
        actor: "caller",
        plan: "pro",
        url: BILLING_URL,
      }),
    );
    expect(formatted?.message).toBe(
      `Upgrade to Pro to keep going: ${BILLING_URL}`,
    );
    expect(formatted?.message).not.toMatch(/try again|tomorrow|BYOK|API key/i);
    expect(formatted?.isMCPJamPlatformError).toBe(true);
    expect(formatted?.isRetryable).toBe(false);
  });

  it("tells a paid account to buy credits, with the link", () => {
    expect(
      formatErrorMessage(
        refusal({
          version: 1,
          reason: "out_of_credits",
          action: "buy_credits",
          actor: "caller",
          url: BILLING_URL,
        }),
      )?.message,
    ).toBe(`Buy credits to keep going: ${BILLING_URL}`);
  });

  it("renders even when retryAfter is 0 (no Retry-After on a non-wait refusal)", () => {
    // The just-merged backend sends `retryAfter: 0` on a non-wait refusal; the
    // sentence must still be the recovery step, not a dropped-to-blank message.
    expect(
      formatErrorMessage(
        refusal({
          version: 1,
          reason: "out_of_credits",
          action: "buy_credits",
          actor: "caller",
          url: BILLING_URL,
        }),
      )?.message,
    ).toContain("Buy credits to keep going");
  });

  it("keeps the retry/BYOK fallback for an older backend with no recovery", () => {
    const formatted = formatErrorMessage(
      JSON.stringify({
        ok: false,
        code: "user_rate_limit",
        error: "Daily MCPJam model limit reached.",
        retryAfter: 61_200_000,
      }),
    );
    expect(formatted?.message).toMatch(/Add your own API key/);
  });

  it("leaves a transient hold on its own concurrency path", () => {
    // A hold is not an empty wallet: its concurrency banner keeps the raw
    // message and retryAfterMs, so the recovery step does not take it over.
    const formatted = formatErrorMessage(
      JSON.stringify({
        ok: false,
        code: "user_rate_limit",
        refusalReason: "holds_committed",
        error: "Another credit-funded chat is finishing.",
        retryAfter: 3000,
        recovery: {
          version: 1,
          reason: "holds_committed",
          action: "wait",
          actor: "caller",
        },
      }),
    );
    expect(formatted?.limitKind).toBe("concurrency");
    expect(formatted?.retryAfterMs).toBe(3000);
    expect(formatted?.message).not.toMatch(/Upgrade|Buy credits/);
  });
});
