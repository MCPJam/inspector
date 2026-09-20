import { useFrontierSignInDialogStore } from "@/stores/frontier-sign-in-dialog-store";
import { beforeEach, describe, expect, it } from "vitest";
import {
  describeAgentRefusalMessage,
  describeMCPJamLimitMessage,
  isMCPJamModelLimitError,
  isSpendBudgetReachedCode,
  notifyMCPJamLimitError,
  notifyMCPJamLimitErrorFromResponse,
  SPEND_BUDGET_REACHED_CODE,
} from "../mcpjam-limit";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

beforeEach(() => {
  useFrontierSignInDialogStore.getState().close();
  useMCPJamLimitDialogStore.setState({
    notifiedRunIds: new Set<string>(),
    authStatus: "loading",
    hasPendingLimit: false,
    outOfCreditsHit: false,
    outOfCreditsOrganizationId: null,
    isOpen: false,
    intent: null,
    organizationId: null,
    pendingInput: null,
  });
});

describe("isMCPJamModelLimitError", () => {
  it("detects the canonical rate-limit code", () => {
    expect(isMCPJamModelLimitError({ code: "mcpjam_rate_limit" })).toBe(true);
  });

  it("detects the signed-in user_rate_limit code", () => {
    expect(isMCPJamModelLimitError({ code: "user_rate_limit" })).toBe(true);
  });

  /**
   * The refusals the generation routes now forward verbatim instead of
   * flattening into a 500. Neither is the customer's wallet: `platform_capacity`
   * is MCPJam's own daily budget for the feature and `generation_rate_limited`
   * is a request-COUNT cap, so both lift on their own and neither has anything
   * to buy. Opening the top-up dialog for them would sell credits that cannot
   * clear the refusal.
   */
  it.each(["platform_capacity", "generation_rate_limited"])(
    "does not open the top-up dialog for the platform refusal %s",
    (code) => {
      expect(isMCPJamModelLimitError({ code })).toBe(false);
      // …nor when the same code arrives nested in the route envelope's
      // `details`, which is where the deep scan looks.
      expect(
        isMCPJamModelLimitError({
          code: "RATE_LIMITED",
          message: "MCPJam's daily generation budget is used up.",
          details: { code, canTopUp: false, isRetryable: true },
        })
      ).toBe(false);
    }
  );

  it("does not match the org spend-budget refusal", () => {
    // Buying credits does not raise an admin-set cap, so this code must
    // never reach the top-up modal that this predicate gates.
    expect(isMCPJamModelLimitError({ code: SPEND_BUDGET_REACHED_CODE })).toBe(
      false,
    );
  });

  it("keeps the budget carve-out when the payload also embeds a limit string", () => {
    // The deep scans below would otherwise classify this as a model limit
    // because the nested details mention a rate-limit code.
    expect(
      isMCPJamModelLimitError({
        code: SPEND_BUDGET_REACHED_CODE,
        details: { nested: { code: "user_rate_limit" } },
      }),
    ).toBe(false);
  });

  it("does not match concurrency-throttled user_rate_limit", () => {
    expect(
      isMCPJamModelLimitError({
        code: "user_rate_limit",
        limitKind: "concurrency",
      }),
    ).toBe(false);
  });

  it("matches user_rate_limit when limitKind is total", () => {
    expect(
      isMCPJamModelLimitError({
        code: "user_rate_limit",
        limitKind: "total",
      }),
    ).toBe(true);
  });

  it("detects rate-limit codes inside structured details", () => {
    expect(
      isMCPJamModelLimitError({
        message: "Backend stream error: 429",
        details: JSON.stringify({
          code: "mcpjam_rate_limit",
          error: "Daily usage limit reached.",
        }),
      }),
    ).toBe(true);
  });

  it("detects rate-limit codes inside prefixed backend strings", () => {
    expect(
      isMCPJamModelLimitError({
        message:
          'Backend stream error: 429 {"code":"mcpjam_rate_limit","error":"Daily usage limit reached."}',
      }),
    ).toBe(true);
  });

  it("detects signed-in usage limits inside prefixed backend strings", () => {
    expect(
      isMCPJamModelLimitError({
        message:
          'Backend stream error: 429 {"code":"user_rate_limit","error":"Daily credit limit reached.","limitKind":"total"}',
      }),
    ).toBe(true);
  });

  it("does not match streamed concurrency throttles inside prefixed backend strings", () => {
    expect(
      isMCPJamModelLimitError({
        message:
          'Backend stream error: 429 {"code":"user_rate_limit","error":"Another credit-funded chat is finishing.","limitKind":"concurrency"}',
      }),
    ).toBe(false);
  });

  it("detects model-limit text inside structured details", () => {
    expect(
      isMCPJamModelLimitError({
        message: "Backend stream error: 429",
        details: {
          error:
            "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
        },
      }),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(
      isMCPJamModelLimitError({
        message: "Provider unavailable",
        details: JSON.stringify({ code: "provider_error" }),
      }),
    ).toBe(false);
  });

  it("opens immediately when a guest gets a fresh limit error", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "guest",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    expect(notifyMCPJamLimitError({ code: "mcpjam_rate_limit" })).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().intent).toBe("guest");
  });

  it("opens with topup intent for signed-in user_rate_limit hits", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    expect(notifyMCPJamLimitError({ code: "user_rate_limit" })).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().intent).toBe("topup");
    expect(useMCPJamLimitDialogStore.getState().outOfCreditsHit).toBe(true);
  });

  it("opens with topup intent for wrapped signed-in usage limit hits", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    expect(
      notifyMCPJamLimitError({
        message:
          'Backend stream error: 429 {"code":"user_rate_limit","error":"Daily credit limit reached.","limitKind":"total"}',
      }),
    ).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().intent).toBe("topup");
  });

  it("captures the org id from wrapped signed-in usage limit hits", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      organizationId: null,
      pendingInput: null,
    });

    expect(
      notifyMCPJamLimitError({
        message:
          'Backend stream error: 429 {"code":"user_rate_limit","error":"Daily credit limit reached.","limitKind":"total","organizationId":"org-a"}',
      }),
    ).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().organizationId).toBe("org-a");
    expect(
      useMCPJamLimitDialogStore.getState().outOfCreditsOrganizationId,
    ).toBe("org-a");
  });

  it("does not open the modal for concurrency-throttle errors", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    expect(
      notifyMCPJamLimitError({
        code: "user_rate_limit",
        limitKind: "concurrency",
      }),
    ).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().outOfCreditsHit).toBe(false);
  });

  it("defers opening while auth state is still loading", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "loading",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    expect(notifyMCPJamLimitError({ code: "mcpjam_rate_limit" })).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().hasPendingLimit).toBe(true);

    useMCPJamLimitDialogStore.getState().setAuthStatus("guest");
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().intent).toBe("guest");
    expect(useMCPJamLimitDialogStore.getState().hasPendingLimit).toBe(false);
  });

  it("resolves a deferred limit to topup when the user is signed in", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "loading",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    expect(notifyMCPJamLimitError({ code: "user_rate_limit" })).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().hasPendingLimit).toBe(true);

    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().intent).toBe("topup");
  });

  it("detects limits from response clones without consuming the original body", async () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "guest",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    const response = new Response(
      JSON.stringify({
        code: "mcpjam_rate_limit",
        error: "Daily usage limit reached.",
        organizationId: "org-from-response",
      }),
      { status: 429 },
    );

    await expect(notifyMCPJamLimitErrorFromResponse(response)).resolves.toBe(
      true,
    );
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().organizationId).toBe(
      "org-from-response",
    );
    await expect(response.text()).resolves.toContain("mcpjam_rate_limit");
  });

  it("forwards limitKind from response payload so concurrency is suppressed", async () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    const response = new Response(
      JSON.stringify({
        code: "user_rate_limit",
        error: "Another credit-funded chat is finishing.",
        limitKind: "concurrency",
      }),
      { status: 429 },
    );

    await expect(notifyMCPJamLimitErrorFromResponse(response)).resolves.toBe(
      false,
    );
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });

  it("tags the wall with the surface the caller passes", async () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      surface: null,
      pendingInput: null,
    });

    const response = new Response(
      JSON.stringify({
        code: "user_rate_limit",
        error:
          "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
        limitKind: "total",
      }),
      { status: 429 },
    );

    await expect(
      notifyMCPJamLimitErrorFromResponse(response, "scenario"),
    ).resolves.toBe(true);
    expect(useMCPJamLimitDialogStore.getState().surface).toBe("scenario");
  });
});

describe("isSpendBudgetReachedCode", () => {
  it("recognizes only the canonical budget code", () => {
    expect(isSpendBudgetReachedCode(SPEND_BUDGET_REACHED_CODE)).toBe(true);
    expect(isSpendBudgetReachedCode("user_rate_limit")).toBe(false);
    expect(isSpendBudgetReachedCode(undefined)).toBe(false);
  });
});

describe("notifyMCPJamLimitError", () => {
  it("never opens the top-up dialog for a spend-budget refusal", () => {
    expect(notifyMCPJamLimitError({ code: SPEND_BUDGET_REACHED_CODE })).toBe(
      false,
    );
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });
});

describe("spend budget never reaches the top-up dialog", () => {
  // The whole point of the carve-out: an organization that set its own
  // ceiling cannot buy its way past it, so offering to sell it credits
  // answers the wrong question. The code arrives at any nesting level.
  it("refuses at the top level", () => {
    expect(isMCPJamModelLimitError({ code: SPEND_BUDGET_REACHED_CODE })).toBe(
      false,
    );
  });

  it("refuses when the code is nested in details", () => {
    expect(
      isMCPJamModelLimitError({
        message: "Request failed",
        details: { error: { code: SPEND_BUDGET_REACHED_CODE } },
      }),
    ).toBe(false);
  });

  it("refuses when the code arrives inside a JSON-encoded message", () => {
    expect(
      isMCPJamModelLimitError({
        message: JSON.stringify({ code: SPEND_BUDGET_REACHED_CODE }),
      }),
    ).toBe(false);
  });

  it("refuses even when the payload also carries a rate-limit string", () => {
    // Without the budget check running FIRST at every level, the deep scan
    // below it classifies this as a wallet limit and opens the dialog.
    expect(
      isMCPJamModelLimitError({
        message: JSON.stringify({
          code: SPEND_BUDGET_REACHED_CODE,
          detail: "mcpjam_rate_limit_exceeded",
        }),
      }),
    ).toBe(false);
  });
});

describe("describeMCPJamLimitMessage", () => {
  it("returns null for errors that are not a limit", () => {
    expect(describeMCPJamLimitMessage("Server exploded")).toBeNull();
    expect(describeMCPJamLimitMessage(null)).toBeNull();
  });

  it("replaces the raw refusal body with the catalog sentence", () => {
    const described = describeMCPJamLimitMessage(
      'Failed to generate test cases: {"ok":false,"code":"user_rate_limit","limitKind":"total","error":"Daily MCPJam model limit reached. Use BYOK or try again tomorrow.","isRetryable":true}',
    );
    expect(described).toMatch(/Out of MCPJam credits\./);
    expect(described).not.toContain("user_rate_limit");
  });

  it("leaves the concurrency throttle to its inline banner", () => {
    expect(
      describeMCPJamLimitMessage(
        '{"code":"user_rate_limit","limitKind":"concurrency","error":"Daily MCPJam model limit reached."}',
      ),
    ).toBeNull();
  });
});

describe("frontier sign-in wall", () => {
  it.each([
    { details: { error: { code: "guest_model_not_allowed" } } },
    {
      message: '{"code":"guest_model_not_allowed","message":"Login required"}',
    },
    { message: 'Agent failed: {"error":{"code":"guest_model_not_allowed"}}' },
    {
      details: {
        errors: ['Request failed: {"code":"guest_model_not_allowed"}'],
      },
    },
  ])("recognizes wrapped frontier codes: %j", (args) => {
    expect(notifyMCPJamLimitError(args)).toBe(true);
    expect(useFrontierSignInDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().outOfCreditsHit).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });

  it("ignores unrelated codes and cyclic details", () => {
    const details: Record<string, unknown> = {
      code: "guest_model_not_allowed_other",
      message: "Sign in to continue.",
    };
    details.cause = details;
    expect(notifyMCPJamLimitError({ details })).toBe(false);
    expect(useFrontierSignInDialogStore.getState().isOpen).toBe(false);
  });

  it("recognizes the backend code even if the copy changes", () => {
    expect(notifyMCPJamLimitError({ code: "guest_model_not_allowed" })).toBe(
      true,
    );
    expect(useFrontierSignInDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().outOfCreditsHit).toBe(false);
  });
  it("handles the frontier error without marking credits exhausted", () => {
    expect(
      notifyMCPJamLimitError({
        message:
          "An error occurred: Sign in to use frontier models, or choose a standard model.",
      }),
    ).toBe(true);
    expect(useFrontierSignInDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().outOfCreditsHit).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });
  it("handles the HTTP error envelope", async () => {
    await notifyMCPJamLimitErrorFromResponse(
      new Response(
        JSON.stringify({
          error: "Sign in to use frontier models, or choose a standard model.",
        }),
        { status: 403 },
      ),
    );
    expect(useFrontierSignInDialogStore.getState().isOpen).toBe(true);
  });
  it("does not replace unrelated authentication failures", () => {
    expect(notifyMCPJamLimitError({ message: "Sign in to continue." })).toBe(
      false,
    );
    expect(useFrontierSignInDialogStore.getState().isOpen).toBe(false);
  });
});

it.each(["platform_free_budget_exhausted", "account_suspended"])(
  "keeps %s out of the daily-credit modal",
  (code) => {
    expect(isMCPJamModelLimitError({ code, message: "user_rate_limit" })).toBe(
      false,
    );
    expect(
      isMCPJamModelLimitError({
        details: JSON.stringify({ code, message: "user_rate_limit" }),
      }),
    ).toBe(false);
  },
);

/**
 * Ask MCPJam is paid by MCPJam, so none of its refusals is a wallet anyone can
 * top up. Selling credits against one would be wrong twice over: the credits
 * would not lift the refusal, and the surface was advertised as free.
 */
describe("Ask MCPJam refusals", () => {
  const CODES = [
    "platform_capacity",
    "agent_turn_limit",
    "agent_billing_rejected",
  ];

  it.each(CODES)("keeps %s out of the credits dialog", (code) => {
    expect(isMCPJamModelLimitError({ code })).toBe(false);
    // …and when the same code arrives nested, which is how a refused stream
    // step reaches the client: the body as a JSON-encoded `message`.
    expect(
      isMCPJamModelLimitError({
        message: JSON.stringify({ code, error: "user_rate_limit" }),
      }),
    ).toBe(false);
    expect(notifyMCPJamLimitError({ code })).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });

  it.each(["platform_capacity", "agent_turn_limit"])(
    "describes %s as today's limit, with the reset a reader can act on",
    (code) => {
      expect(describeAgentRefusalMessage(JSON.stringify({ code }))).toBe(
        "Ask MCPJam has reached today's limit. It resets at 00:00 UTC.",
      );
    },
  );

  it.each(["platform_generation_unavailable", "agent_billing_rejected"])(
    "describes %s as temporary, because no reset time lifts it",
    (code) => {
      expect(describeAgentRefusalMessage(JSON.stringify({ code }))).toBe(
        "Ask MCPJam is temporarily unavailable.",
      );
    },
  );

  it("finds a refusal nested as plain text under another code", () => {
    // `collectCodes` only records a `code` PROPERTY, so this payload yields
    // {RATE_LIMITED} — non-empty, but without the code that decides the copy.
    // Gating the substring scan on an empty set would skip it here and print
    // the raw body at the user.
    expect(
      describeAgentRefusalMessage(
        JSON.stringify({ code: "RATE_LIMITED", details: "agent_turn_limit" }),
      ),
    ).toBe("Ask MCPJam has reached today's limit. It resets at 00:00 UTC.");
    expect(
      describeAgentRefusalMessage(
        JSON.stringify({
          code: "UPSTREAM",
          details: { note: "agent_billing_rejected" },
        }),
      ),
    ).toBe("Ask MCPJam is temporarily unavailable.");
  });

  it("reads the code out of a body that is not JSON at all", () => {
    // The AI SDK folds a pre-stream refusal into `new Error(await res.text())`,
    // and a proxy can mangle that text on the way. A distinctive code in a
    // string is still the truth about what happened.
    expect(
      describeAgentRefusalMessage('HTTP 429: ... "code":"agent_turn_limit" ...'),
    ).toBe("Ask MCPJam has reached today's limit. It resets at 00:00 UTC.");
  });

  it("leaves anything else to the caller's own message", () => {
    expect(describeAgentRefusalMessage(null)).toBeNull();
    expect(
      describeAgentRefusalMessage("MCP server closed the connection"),
    ).toBeNull();
    expect(
      describeAgentRefusalMessage(JSON.stringify({ code: "user_rate_limit" })),
    ).toBeNull();
  });
});

describe("credit exhaustion during a run", () => {
  it.each([
    { code: "org_rate_limit" },
    { code: "billing_limit_reached" },
    { message: "Daily credit limit reached." },
    { message: "Monthly MCPJam credit limit reached." },
    { message: "Credits exhausted" },
    { message: "Your organization's credit limit was reached." },
    { details: { failure: JSON.stringify({ code: "billing_limit_reached" }) } },
  ])("recognizes credit exhaustion: %j", (input) => {
    expect(notifyMCPJamLimitError(input)).toBe(true);
  });

  it.each([
    { message: "Provider rate limit exceeded (429)" },
    { code: "user_rate_limit", details: { limitKind: "concurrency" } },
    {
      code: "billing_limit_reached",
      details: { code: "spend_budget_reached" },
    },
    {
      message:
        'Credits exhausted: {"code":"ORGANIZATION_SPEND_BUDGET_REACHED"}',
    },
    { code: "wallet_locked", message: "Credits exhausted" },
    {
      code: "billing_limit_reached",
      details: { gateKey: "maxEvalIterationsPerMonth" },
    },
  ])(
    "does not turn a throttle or spend cap into a credit wall: %j",
    (input) => {
      expect(notifyMCPJamLimitError(input)).toBe(false);
      expect(useMCPJamLimitDialogStore.getState().hasPendingLimit).toBe(false);
    },
  );

  it("opens once per run even after dismissal, and opens for a new run", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const input = { runId: "credit-run-1", code: "billing_limit_reached" };
    expect(notifyMCPJamLimitError(input)).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    useMCPJamLimitDialogStore.getState().close();
    expect(notifyMCPJamLimitError(input)).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    notifyMCPJamLimitError({ ...input, runId: "credit-run-2" });
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
  });
});

it("recognizes the new credit-exhaustion wording without losing recovery actions", () => {
  expect(describeMCPJamLimitMessage("Out of MCPJam credits.")).toContain("Out of MCPJam credits.");
});
