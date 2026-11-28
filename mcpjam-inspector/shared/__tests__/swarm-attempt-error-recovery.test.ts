/**
 * A swarm attempt failed on an MCPJam credit refusal: the prose scrubber strips
 * the link out of the stored message, so the structured `recovery` field is
 * where the link survives, and the message shows the one-action step.
 */
import { describe, expect, it } from "vitest";
import { humanizeSwarmAttemptError } from "../swarm-attempt-error";

const BILLING_URL = "https://app.mcpjam.com/billing";

const swarmError = (body: Record<string, unknown>) =>
  `swarm-agent https://x.convex.site/journey-execution/persona-next-turn failed (429): ${JSON.stringify(
    body,
  )}`;

describe("humanizeSwarmAttemptError — credit recovery", () => {
  it("keeps the link in the structured field and the step in the message", () => {
    const info = humanizeSwarmAttemptError(
      swarmError({
        ok: false,
        code: "user_rate_limit",
        error: `Out of MCPJam credits. Upgrade to Pro to keep going: ${BILLING_URL}. BYOK also works.`,
        retryAfter: 0,
        recovery: {
          version: 1,
          reason: "out_of_credits",
          action: "upgrade_plan",
          actor: "caller",
          plan: "pro",
          url: BILLING_URL,
        },
      }),
    );
    // The link survives where a surface can render it...
    expect(info.recovery?.url).toBe(BILLING_URL);
    expect(info.recovery?.action).toBe("upgrade_plan");
    // ...the message shows the step, one action, no link, no BYOK/retry tail.
    expect(info.message).toBe("Upgrade to Pro to keep going");
    expect(info.message).not.toMatch(/https?:\/\//);
    expect(info.message).not.toMatch(/BYOK|try again|tomorrow/i);
  });

  it("words a buy-credits refusal as its one action", () => {
    const info = humanizeSwarmAttemptError(
      swarmError({
        ok: false,
        code: "user_rate_limit",
        error: "Out of MCPJam credits.",
        retryAfter: 0,
        recovery: {
          version: 1,
          reason: "out_of_credits",
          action: "buy_credits",
          actor: "caller",
          url: BILLING_URL,
        },
      }),
    );
    expect(info.message).toBe("Buy credits to keep going");
    expect(info.recovery?.url).toBe(BILLING_URL);
  });

  it("carries no recovery, and keeps today's prose, for an older backend", () => {
    const info = humanizeSwarmAttemptError(
      swarmError({
        ok: false,
        code: "user_rate_limit",
        error: "Daily MCPJam model limit reached.",
        retryAfter: 9_259_503,
        details: "Try again in 155 minutes.",
      }),
    );
    expect(info.recovery).toBeUndefined();
    expect(info.message).toContain("Daily MCPJam model limit reached");
  });
});
