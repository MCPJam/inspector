import { beforeEach, describe, expect, it } from "vitest";
import {
  isMCPJamModelLimitError,
  isSpendBudgetReachedCode,
  notifyMCPJamLimitError,
  notifyMCPJamLimitErrorFromResponse,
  SPEND_BUDGET_REACHED_CODE,
} from "../mcpjam-limit";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

beforeEach(() => {
  useMCPJamLimitDialogStore.setState({
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

  it("does not match the org spend-budget refusal", () => {
    // Buying credits does not raise an admin-set cap, so this code must
    // never reach the top-up modal that this predicate gates.
    expect(isMCPJamModelLimitError({ code: SPEND_BUDGET_REACHED_CODE })).toBe(
      false
    );
  });

  it("keeps the budget carve-out when the payload also embeds a limit string", () => {
    // The deep scans below would otherwise classify this as a model limit
    // because the nested details mention a rate-limit code.
    expect(
      isMCPJamModelLimitError({
        code: SPEND_BUDGET_REACHED_CODE,
        details: { nested: { code: "user_rate_limit" } },
      })
    ).toBe(false);
  });

  it("does not match concurrency-throttled user_rate_limit", () => {
    expect(
      isMCPJamModelLimitError({
        code: "user_rate_limit",
        limitKind: "concurrency",
      })
    ).toBe(false);
  });

  it("matches user_rate_limit when limitKind is total", () => {
    expect(
      isMCPJamModelLimitError({
        code: "user_rate_limit",
        limitKind: "total",
      })
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
      })
    ).toBe(true);
  });

  it("detects rate-limit codes inside prefixed backend strings", () => {
    expect(
      isMCPJamModelLimitError({
        message:
          'Backend stream error: 429 {"code":"mcpjam_rate_limit","error":"Daily usage limit reached."}',
      })
    ).toBe(true);
  });

  it("detects signed-in usage limits inside prefixed backend strings", () => {
    expect(
      isMCPJamModelLimitError({
        message:
          'Backend stream error: 429 {"code":"user_rate_limit","error":"Daily credit limit reached.","limitKind":"total"}',
      })
    ).toBe(true);
  });

  it("does not match streamed concurrency throttles inside prefixed backend strings", () => {
    expect(
      isMCPJamModelLimitError({
        message:
          'Backend stream error: 429 {"code":"user_rate_limit","error":"Another credit-funded chat is finishing.","limitKind":"concurrency"}',
      })
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
      })
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(
      isMCPJamModelLimitError({
        message: "Provider unavailable",
        details: JSON.stringify({ code: "provider_error" }),
      })
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
      })
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
      })
    ).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().organizationId).toBe("org-a");
    expect(
      useMCPJamLimitDialogStore.getState().outOfCreditsOrganizationId
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
      })
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
      { status: 429 }
    );

    await expect(notifyMCPJamLimitErrorFromResponse(response)).resolves.toBe(
      true
    );
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().organizationId).toBe(
      "org-from-response"
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
      { status: 429 }
    );

    await expect(notifyMCPJamLimitErrorFromResponse(response)).resolves.toBe(
      false
    );
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
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
    expect(
      notifyMCPJamLimitError({ code: SPEND_BUDGET_REACHED_CODE })
    ).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });
});

describe("spend budget never reaches the top-up dialog", () => {
  // The whole point of the carve-out: an organization that set its own
  // ceiling cannot buy its way past it, so offering to sell it credits
  // answers the wrong question. The code arrives at any nesting level.
  it("refuses at the top level", () => {
    expect(
      isMCPJamModelLimitError({ code: SPEND_BUDGET_REACHED_CODE }),
    ).toBe(false);
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
