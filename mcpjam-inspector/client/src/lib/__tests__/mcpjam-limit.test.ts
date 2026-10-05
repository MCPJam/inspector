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
    notifiedKeys: new Set<string>(),
    staleWaveKeys: new Set<string>(),
    runKeysSincePurchase: new Set<string>(),
    waveOrganizations: {},
    authStatus: "loading",
    hasPendingLimit: false,
    outOfCreditsHit: false,
    outOfCreditsOrganizationId: null,
    isOpen: false,
    intent: null,
    organizationId: null,
    surface: null,
    period: null,
    shortfall: null,
    pendingInput: null,
  });
});

const HOLDS_COMMITTED_BODY = JSON.stringify({
  code: "user_rate_limit",
  limitKind: "total",
  refusalReason: "holds_committed",
  isRetryable: true,
  retryAfter: 15000,
  outstandingHolds: 2,
  heldCredits: 180,
  error:
    "MCPJam model limit reached for the moment: 2 in-flight requests hold the remaining credits.",
});

const INSUFFICIENT_BODY = JSON.stringify({
  code: "user_rate_limit",
  limitKind: "total",
  refusalReason: "insufficient_for_request",
  creditsRemaining: 23,
  creditsRequired: 30,
  error:
    "This request needs about 30 MCPJam credits; your organization has 23 left today.",
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
        }),
      ).toBe(false);
    },
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

describe("credits held by in-flight requests", () => {
  it("neither opens the dialog nor locks the models", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");

    expect(notifyMCPJamLimitError({ message: HOLDS_COMMITTED_BODY })).toBe(
      false,
    );
    expect(
      notifyMCPJamLimitError({
        code: "user_rate_limit",
        limitKind: "total",
        details: JSON.parse(HOLDS_COMMITTED_BODY),
        message: "MCPJam model limit reached for the moment.",
      }),
    ).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().outOfCreditsHit).toBe(false);
  });

  it("describes the refusal as a retry instead of echoing the body", () => {
    expect(describeMCPJamLimitMessage(HOLDS_COMMITTED_BODY)).toBe(
      "Other requests in flight are holding your remaining MCPJam credits. Try again in a few seconds.",
    );
  });

  // What a swarm attempt row stores: the humanized sentence and the generic
  // code, with the `refusalReason` gone. This opened "Out of MCPJam credits"
  // once per run of a wave that was only waiting on its own in-flight calls.
  it.each([
    "MCPJam model limit reached for the moment: 2 in-flight request(s) hold the remaining credits and release them as they finish. Retry in a few seconds.",
    "MCPJam model limit reached for the moment.",
  ])("does not open the dialog for a stored row: %s", (message) => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");

    expect(
      notifyMCPJamLimitError({
        runId: "run-a",
        code: "user_rate_limit",
        message,
        surface: "swarm",
      }),
    ).toBe(false);
    expect(isMCPJamModelLimitError({ message })).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().outOfCreditsHit).toBe(false);
  });

  it("describes a stored row's hold as a retry too, not as an empty wallet or raw text", () => {
    // The row kept the sentence and lost the reason: the sentence is the only
    // signal, and without it the caller printed the backend's words raw.
    const expected =
      "Other requests in flight are holding your remaining MCPJam credits. Try again in a few seconds.";
    expect(
      describeMCPJamLimitMessage(
        "MCPJam model limit reached for the moment: 2 in-flight request(s) hold the remaining credits and release them as they finish. Retry in a few seconds.",
      ),
    ).toBe(expected);
    // A structured reason that says otherwise wins over the prose.
    const exhausted = describeMCPJamLimitMessage(
      JSON.stringify({
        code: "user_rate_limit",
        refusalReason: "allowance_exhausted",
        error:
          "MCPJam model limit reached for the moment: 2 in-flight request(s) hold the remaining credits.",
      }),
    );
    expect(exhausted).not.toBe(expected);
    expect(exhausted).not.toBeNull();
  });

  it("does not tell a locked wallet to retry in a few seconds", () => {
    // `buildSpendRefusalBody` can emit the structured hold reason beside
    // `wallet_locked`. A disputed payment is not a wait.
    const retry =
      "Other requests in flight are holding your remaining MCPJam credits. Try again in a few seconds.";
    expect(
      describeMCPJamLimitMessage(
        JSON.stringify({
          code: "wallet_locked",
          refusalReason: "holds_committed",
          error: "MCPJam model limit reached for the moment.",
        }),
      ),
    ).not.toBe(retry);
  });

  it("reads a structured hold reason at any depth, the way the dialog does", () => {
    const retry =
      "Other requests in flight are holding your remaining MCPJam credits. Try again in a few seconds.";
    const nested = JSON.stringify({
      code: "user_rate_limit",
      error: "Daily MCPJam model limit reached.",
      details: { refusal: { refusalReason: "holds_committed" } },
    });
    expect(describeMCPJamLimitMessage(nested)).toBe(retry);
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    expect(notifyMCPJamLimitError({ message: nested })).toBe(false);
  });

  it("words a refusal the way the dialog reads it, so the panel never contradicts an open dialog", () => {
    const HELD =
      "MCPJam model limit reached for the moment: 2 in-flight request(s) hold the remaining credits and release them as they finish. Retry in a few seconds.";
    const retry =
      "Other requests in flight are holding your remaining MCPJam credits. Try again in a few seconds.";
    const exhaustions = [
      // A sentence quoted under `details` is someone else's words.
      JSON.stringify({
        code: "user_rate_limit",
        error: "Daily MCPJam model limit reached.",
        details: { previous: HELD },
      }),
      // One text joining a hold with a spent allowance.
      `${HELD} Daily MCPJam model limit reached.`,
      // A code that never rides a hold.
      `${HELD} (billing_limit_reached, HTTP 429)`,
    ];
    for (const message of exhaustions) {
      expect(isMCPJamModelLimitError({ message })).toBe(true);
      const described = describeMCPJamLimitMessage(message);
      expect(described).not.toBeNull();
      expect(described).not.toBe(retry);
    }
    // And a hold that states nothing else is still a retry.
    expect(describeMCPJamLimitMessage(HELD)).toBe(retry);
  });

  it("still opens for a real exhaustion whose details mention in-flight work", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");

    expect(
      notifyMCPJamLimitError({
        code: "user_rate_limit",
        message:
          "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
        details: {
          note: "2 in-flight tool calls were cancelled.",
          // Quoted from an earlier refusal, not this one's own reason.
          previous:
            "MCPJam model limit reached for the moment: 1 in-flight request(s) hold the remaining credits.",
        },
      }),
    ).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
  });
});

describe("one dialog per swarm wave", () => {
  const EXHAUSTED =
    "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.";
  const notify = (keys: {
    runId?: string;
    swarmRunGroupId?: string;
    organizationId?: string;
  }) =>
    notifyMCPJamLimitError({
      ...keys,
      code: "user_rate_limit",
      message: EXHAUSTED,
      surface: "swarm",
    });
  const shortfall = (keys: {
    runId?: string;
    swarmRunGroupId?: string;
    organizationId?: string;
  }) =>
    notifyMCPJamLimitError({
      ...keys,
      message: INSUFFICIENT_BODY,
      surface: "swarm",
    });

  it("opens once for A, then A with its wave, then B in the same wave", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;

    notify({ runId: "run-a" });
    expect(store.getState().isOpen).toBe(true);
    store.getState().close();

    // The run doc arrives with its wave id: suppressed, but the wave is learnt.
    notify({ runId: "run-a", swarmRunGroupId: "wave-1" });
    expect(store.getState().isOpen).toBe(false);

    notify({ runId: "run-b", swarmRunGroupId: "wave-1" });
    expect(store.getState().isOpen).toBe(false);
    // What each run reported is recorded beside its id; see the attempts below.
    expect(
      new Set(
        [...store.getState().notifiedKeys].filter(
          (key) => !key.startsWith("evidence:"),
        ),
      ),
    ).toEqual(new Set(["run:run-a", "wave:wave-1", "run:run-b"]));
  });

  it("opens again for a different wave", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;

    notify({ runId: "run-a", swarmRunGroupId: "wave-1" });
    store.getState().close();
    notify({ swarmRunGroupId: "wave-1" });
    expect(store.getState().isOpen).toBe(false);

    notify({ runId: "run-c", swarmRunGroupId: "wave-2" });
    expect(store.getState().isOpen).toBe(true);
  });

  it("still latches real exhaustion from a suppressed notice in the same wave", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;

    store.getState().notifyLimitHit({
      runId: "run-a",
      swarmRunGroupId: "wave-1",
      surface: "swarm",
      shortfall: { creditsRemaining: 4, creditsRequired: 10 },
    });
    expect(store.getState().outOfCreditsHit).toBe(false);
    store.getState().close();

    notify({ runId: "run-b", swarmRunGroupId: "wave-1" });
    expect(store.getState().isOpen).toBe(false);
    expect(store.getState().outOfCreditsHit).toBe(true);
  });

  // The dialog on screen opened on the first run's evidence. A sibling that
  // reports something else has to be heard, or the modal keeps telling the user
  // that credits remain and a cheaper request would fit after the wallet is
  // empty.
  describe("a dialog that is already open", () => {
    it("follows a sibling's real exhaustion after it opened on a shortfall", () => {
      useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
      const store = useMCPJamLimitDialogStore;

      shortfall({ runId: "run-a", swarmRunGroupId: "wave-1" });
      expect(store.getState()).toMatchObject({
        isOpen: true,
        period: null,
        shortfall: { creditsRemaining: 23, creditsRequired: 30 },
        outOfCreditsHit: false,
      });

      notify({ runId: "run-b", swarmRunGroupId: "wave-1" });
      expect(store.getState()).toMatchObject({
        isOpen: true,
        period: "daily",
        shortfall: null,
        outOfCreditsHit: true,
      });
    });

    it("follows a sibling's shortfall after it opened on exhaustion", () => {
      useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
      const store = useMCPJamLimitDialogStore;

      notify({ runId: "run-a", swarmRunGroupId: "wave-1" });
      expect(store.getState()).toMatchObject({
        isOpen: true,
        period: "daily",
        shortfall: null,
        outOfCreditsHit: true,
      });

      shortfall({ runId: "run-b", swarmRunGroupId: "wave-1" });
      expect(store.getState()).toMatchObject({
        isOpen: true,
        period: null,
        shortfall: { creditsRemaining: 23, creditsRequired: 30 },
        outOfCreditsHit: false,
      });
    });

    it("stays closed when the user closed it before the sibling reported", () => {
      useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
      const store = useMCPJamLimitDialogStore;

      shortfall({ runId: "run-a", swarmRunGroupId: "wave-1" });
      store.getState().close();

      notify({ runId: "run-b", swarmRunGroupId: "wave-1" });
      expect(store.getState()).toMatchObject({
        isOpen: false,
        period: null,
        shortfall: null,
        outOfCreditsHit: true,
      });
    });

    it("keeps what a sibling reported when the first run's notice is replayed", () => {
      useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
      const store = useMCPJamLimitDialogStore;
      const first = { runId: "run-a", swarmRunGroupId: "wave-1" };

      shortfall(first);
      notify({ runId: "run-b", swarmRunGroupId: "wave-1" });
      const before = store.getState();

      shortfall(first);
      expect(store.getState()).toBe(before);
      expect(store.getState().shortfall).toBeNull();
    });

    it("keeps its organization when a sibling names none and learns one it lacked", () => {
      useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
      const store = useMCPJamLimitDialogStore;

      shortfall({ runId: "run-a", swarmRunGroupId: "wave-1" });
      expect(store.getState().organizationId).toBeNull();

      notify({
        runId: "run-b",
        swarmRunGroupId: "wave-1",
        organizationId: "org-a",
      });
      expect(store.getState().organizationId).toBe("org-a");

      notify({ runId: "run-c", swarmRunGroupId: "wave-1" });
      expect(store.getState()).toMatchObject({
        isOpen: true,
        organizationId: "org-a",
        period: "daily",
      });
    });

    it("leaves a dialog for another organization alone", () => {
      useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
      const store = useMCPJamLimitDialogStore;

      // Organization B's wave was announced and closed. Organization A's wave
      // then opens the dialog.
      notify({
        runId: "run-b1",
        swarmRunGroupId: "wave-b",
        organizationId: "org-b",
      });
      store.getState().close();
      notify({
        runId: "run-a1",
        swarmRunGroupId: "wave-a",
        organizationId: "org-a",
      });

      // A later run of B's wave reports a shortfall for B's wallet, which says
      // nothing about the one A's dialog is showing.
      shortfall({
        runId: "run-b2",
        swarmRunGroupId: "wave-b",
        organizationId: "org-b",
      });
      expect(store.getState()).toMatchObject({
        isOpen: true,
        organizationId: "org-a",
        period: "daily",
        shortfall: null,
      });
    });
  });

  // A run's attempts all carry its id, and the run views notify once per attempt
  // on every Convex push. One target can be refused on a shortfall and a later
  // one on an empty wallet: the second is new evidence, not a replay of the
  // first. The same attempt reported again still is one.
  describe("the attempts of one run", () => {
    const run = { runId: "run-a", swarmRunGroupId: "wave-1" };

    it("follows a later attempt's real exhaustion after a shortfall", () => {
      useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
      const store = useMCPJamLimitDialogStore;

      shortfall(run);
      expect(store.getState()).toMatchObject({
        isOpen: true,
        shortfall: { creditsRemaining: 23, creditsRequired: 30 },
        outOfCreditsHit: false,
      });

      notify(run);
      expect(store.getState()).toMatchObject({
        isOpen: true,
        period: "daily",
        shortfall: null,
        outOfCreditsHit: true,
      });
    });

    it("follows a later attempt's shortfall after exhaustion", () => {
      useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
      const store = useMCPJamLimitDialogStore;

      notify(run);
      expect(store.getState().outOfCreditsHit).toBe(true);

      shortfall(run);
      expect(store.getState()).toMatchObject({
        isOpen: true,
        period: null,
        shortfall: { creditsRemaining: 23, creditsRequired: 30 },
        outOfCreditsHit: false,
      });
    });

    it("still locks the models for a later attempt when the user closed the dialog", () => {
      useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
      const store = useMCPJamLimitDialogStore;

      shortfall(run);
      store.getState().close();

      notify(run);
      expect(store.getState()).toMatchObject({
        isOpen: false,
        outOfCreditsHit: true,
      });
    });

    it("tells apart attempts of a run with no wave", () => {
      useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
      const store = useMCPJamLimitDialogStore;

      shortfall({ runId: "run-a" });
      notify({ runId: "run-a" });
      expect(store.getState()).toMatchObject({
        isOpen: true,
        shortfall: null,
        outOfCreditsHit: true,
      });
    });

    it("treats the attempts reported again as replays", () => {
      useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
      const store = useMCPJamLimitDialogStore;

      shortfall(run);
      notify(run);
      // A top-up clears the latch; Convex then replays both attempts.
      store.getState().clearOutOfCreditsHit();
      const before = store.getState();

      shortfall(run);
      notify(run);
      expect(store.getState()).toBe(before);
      expect(store.getState().outOfCreditsHit).toBe(false);
    });
  });

  it("keeps a later exhaustion when auth was still loading", () => {
    const store = useMCPJamLimitDialogStore;

    store.getState().notifyLimitHit({
      runId: "run-a",
      swarmRunGroupId: "wave-1",
      surface: "swarm",
      shortfall: { creditsRemaining: 4, creditsRequired: 10 },
    });
    notify({ runId: "run-b", swarmRunGroupId: "wave-1" });
    expect(store.getState().outOfCreditsHit).toBe(true);

    store.getState().setAuthStatus("signedIn");
    expect(store.getState().outOfCreditsHit).toBe(true);
  });

  it("leaves the latch alone when a known notice is replayed", () => {
    // RunLiveBridge, the sessions provider and the eval queries replay a run's
    // notice on every Convex push. Once a top-up or a daily reset has cleared
    // the latch, a replay must not set it again.
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;
    const keys = { runId: "run-a", swarmRunGroupId: "wave-1" };

    notify(keys);
    expect(store.getState().outOfCreditsHit).toBe(true);
    store.getState().close();
    store.getState().clearOutOfCreditsHit();

    const before = store.getState();
    notify(keys);
    notify({ runId: "run-a" });
    notify({ swarmRunGroupId: "wave-1" });
    expect(store.getState()).toBe(before);
    expect(store.getState().outOfCreditsHit).toBe(false);
  });

  it("keeps the held notice's organization when a later one in the wave has none", () => {
    // Auth is still loading: the first notice is held. A second one from a
    // surface that does not know the organization must not erase it.
    const store = useMCPJamLimitDialogStore;
    store.getState().notifyLimitHit({
      runId: "run-a",
      swarmRunGroupId: "wave-1",
      organizationId: "org-1",
      surface: "swarm",
    });
    store.getState().notifyLimitHit({
      runId: "run-b",
      swarmRunGroupId: "wave-1",
    });

    store.getState().setAuthStatus("signedIn");
    expect(store.getState()).toMatchObject({
      isOpen: true,
      organizationId: "org-1",
      surface: "swarm",
      outOfCreditsOrganizationId: "org-1",
    });
  });

  it("does not widen one organization's latch to every organization", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;
    store.getState().notifyLimitHit({
      runId: "run-a",
      swarmRunGroupId: "wave-1",
      organizationId: "org-1",
      surface: "swarm",
    });
    expect(store.getState().outOfCreditsOrganizationId).toBe("org-1");

    // A sibling run, suppressed, from a surface with no organization.
    store.getState().notifyLimitHit({
      runId: "run-b",
      swarmRunGroupId: "wave-1",
    });
    expect(store.getState().outOfCreditsHit).toBe(true);
    expect(store.getState().outOfCreditsOrganizationId).toBe("org-1");
  });

  it("does not attribute a fresh notice with no organization to the previous latch's", () => {
    // Only a notice that continues a known wave is the same event as the latch.
    // A new run in another wave, from a surface that does not know which
    // organization it belongs to, is an event of unknown origin: it locks every
    // organization, as it did before waves, instead of pinning the last one.
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;
    store.getState().notifyLimitHit({
      runId: "run-a",
      swarmRunGroupId: "wave-1",
      organizationId: "org-1",
      surface: "swarm",
    });
    expect(store.getState().outOfCreditsOrganizationId).toBe("org-1");

    store.getState().notifyLimitHit({
      runId: "run-z",
      swarmRunGroupId: "wave-9",
      surface: "swarm",
    });
    expect(store.getState().outOfCreditsHit).toBe(true);
    expect(store.getState().outOfCreditsOrganizationId).toBeNull();
  });

  it("opens again for a run that hits the wall after a purchase, while replays of the old runs stay quiet", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;

    notify({ runId: "run-a", swarmRunGroupId: "wave-1" });
    expect(store.getState().isOpen).toBe(true);
    store.getState().close();

    // The user starts buying credits and relaunches under the same wave (a
    // retry reuses it). The wave was announced before the purchase.
    store.getState().clearOutOfCreditsHit();
    store.getState().forgetNotifiedWaves();

    // Convex keeps replaying the old run's notice: still a no-op, and it must
    // not teach the wave back, or the next run would be silenced again.
    const before = store.getState();
    notify({ runId: "run-a", swarmRunGroupId: "wave-1" });
    notify({ runId: "run-a" });
    expect(store.getState()).toBe(before);
    expect(store.getState().outOfCreditsHit).toBe(false);

    // A new run in that wave running out again after the purchase is news.
    notify({ runId: "run-c", swarmRunGroupId: "wave-1" });
    expect(store.getState().isOpen).toBe(true);
    store.getState().close();

    // The wave is announced again: its next run is quiet, as before.
    notify({ runId: "run-d", swarmRunGroupId: "wave-1" });
    expect(store.getState().isOpen).toBe(false);
  });

  // A retried run's notice can reach the store before its run document supplies
  // the wave (A), and again with it (A with W). W was stale from the purchase;
  // A is news, so A's notice already announced the wave, and its next run
  // stays quiet.
  it("makes a stale wave current when a run announced since the purchase arrives with it", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;

    notify({ runId: "run-a", swarmRunGroupId: "wave-1" });
    store.getState().close();
    store.getState().forgetNotifiedWaves();

    notify({ runId: "run-b" });
    expect(store.getState().isOpen).toBe(true);
    store.getState().close();

    notify({ runId: "run-b", swarmRunGroupId: "wave-1" });
    expect(store.getState().isOpen).toBe(false);
    expect(store.getState().staleWaveKeys).toEqual(new Set());

    notify({ runId: "run-c", swarmRunGroupId: "wave-1" });
    expect(store.getState().isOpen).toBe(false);
  });

  it("leaves a stale wave stale when a run announced before the purchase arrives with it", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;

    notify({ runId: "run-a" });
    store.getState().close();
    notify({ runId: "run-b", swarmRunGroupId: "wave-1" });
    store.getState().close();
    store.getState().forgetNotifiedWaves();

    // Run A is old news that only now meets its wave: still a replay.
    notify({ runId: "run-a", swarmRunGroupId: "wave-1" });
    expect(store.getState().isOpen).toBe(false);
    expect(store.getState().staleWaveKeys).toEqual(new Set(["wave:wave-1"]));

    notify({ runId: "run-c", swarmRunGroupId: "wave-1" });
    expect(store.getState().isOpen).toBe(true);
  });

  it("starts over at the next purchase: a run announced between two purchases is old news at the second", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;

    notify({ runId: "run-a", swarmRunGroupId: "wave-1" });
    store.getState().close();
    store.getState().forgetNotifiedWaves();
    notify({ runId: "run-b" });
    store.getState().close();
    store.getState().forgetNotifiedWaves();

    notify({ runId: "run-b", swarmRunGroupId: "wave-1" });
    expect(store.getState().isOpen).toBe(false);
    expect(store.getState().staleWaveKeys).toEqual(new Set(["wave:wave-1"]));
  });

  // A purchase is for ONE organization. Another organization's wave was
  // announced and nothing about its balance changed, so its next run stays quiet
  // instead of reopening the dialog the user already closed.
  it("makes only the purchasing organization's waves news again", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;

    notify({
      runId: "run-a",
      swarmRunGroupId: "wave-a",
      organizationId: "org-a",
    });
    store.getState().close();
    notify({
      runId: "run-b",
      swarmRunGroupId: "wave-b",
      organizationId: "org-b",
    });
    store.getState().close();

    store.getState().forgetNotifiedWaves("org-a");

    notify({
      runId: "run-b2",
      swarmRunGroupId: "wave-b",
      organizationId: "org-b",
    });
    expect(store.getState().isOpen).toBe(false);

    notify({
      runId: "run-a2",
      swarmRunGroupId: "wave-a",
      organizationId: "org-a",
    });
    expect(store.getState().isOpen).toBe(true);
  });

  it("treats a wave that named no organization as news for any purchase", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;

    notify({ runId: "run-x", swarmRunGroupId: "wave-x" });
    store.getState().close();

    store.getState().forgetNotifiedWaves("org-a");

    notify({ runId: "run-x2", swarmRunGroupId: "wave-x" });
    expect(store.getState().isOpen).toBe(true);
  });

  it("learns a wave's organization from a later run and scopes a purchase by it", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;

    // The wave is announced from a surface that does not know its organization,
    // and its next run does.
    notify({ runId: "run-1", swarmRunGroupId: "wave-1" });
    store.getState().close();
    notify({
      runId: "run-2",
      swarmRunGroupId: "wave-1",
      organizationId: "org-a",
    });
    expect(store.getState().isOpen).toBe(false);

    store.getState().forgetNotifiedWaves("org-b");

    notify({
      runId: "run-3",
      swarmRunGroupId: "wave-1",
      organizationId: "org-a",
    });
    expect(store.getState().isOpen).toBe(false);
  });

  it("keeps a wave that an earlier purchase made news when another organization buys", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    const store = useMCPJamLimitDialogStore;

    notify({
      runId: "run-b",
      swarmRunGroupId: "wave-b",
      organizationId: "org-b",
    });
    store.getState().close();

    store.getState().forgetNotifiedWaves("org-b");
    store.getState().forgetNotifiedWaves("org-a");

    // Still news: organization A's purchase does not put B's wave back to sleep.
    notify({
      runId: "run-b2",
      swarmRunGroupId: "wave-b",
      organizationId: "org-b",
    });
    expect(store.getState().isOpen).toBe(true);
  });

  it("keeps the newest evidence for a notice held for auth: a later shortfall is not undone at sign-in", () => {
    const store = useMCPJamLimitDialogStore;

    // Auth is still loading, so the exhaustion is held for sign-in.
    notify({
      runId: "run-a",
      swarmRunGroupId: "wave-1",
      organizationId: "org-a",
    });
    expect(store.getState().hasPendingLimit).toBe(true);
    expect(store.getState().outOfCreditsHit).toBe(true);

    // A later run of the wave reports only a shortfall: credits remain, so the
    // latch clears. The held notice must not bring it back.
    notifyMCPJamLimitError({
      runId: "run-b",
      swarmRunGroupId: "wave-1",
      message: INSUFFICIENT_BODY,
      surface: "swarm",
    });
    expect(store.getState().outOfCreditsHit).toBe(false);

    store.getState().setAuthStatus("signedIn");
    expect(store.getState().isOpen).toBe(true);
    expect(store.getState().outOfCreditsHit).toBe(false);
    expect(store.getState().shortfall).toEqual({
      creditsRemaining: 23,
      creditsRequired: 30,
    });
    // The shortfall's notice named no organization; the held one's still does.
    expect(store.getState().organizationId).toBe("org-a");
  });

  it("keeps the wave suppressed across the loading-to-signed-in handoff", () => {
    const store = useMCPJamLimitDialogStore;
    notify({ runId: "run-a", swarmRunGroupId: "wave-1" });
    notify({ runId: "run-b", swarmRunGroupId: "wave-1" });
    store.getState().setAuthStatus("signedIn");
    expect(store.getState().isOpen).toBe(true);
    store.getState().close();

    notify({ runId: "run-c", swarmRunGroupId: "wave-1" });
    expect(store.getState().isOpen).toBe(false);
  });
});

describe("a balance below the request estimate", () => {
  it("opens the dialog with the numbers but does not lock the models", async () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");

    expect(
      await notifyMCPJamLimitErrorFromResponse(
        new Response(INSUFFICIENT_BODY, { status: 429 }),
      ),
    ).toBe(true);
    const state = useMCPJamLimitDialogStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.intent).toBe("topup");
    expect(state.shortfall).toEqual({
      creditsRemaining: 23,
      creditsRequired: 30,
    });
    expect(state.outOfCreditsHit).toBe(false);
  });

  it("keeps the numbers through the loading-to-signed-in handoff", () => {
    expect(notifyMCPJamLimitError({ message: INSUFFICIENT_BODY })).toBe(true);
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    expect(useMCPJamLimitDialogStore.getState().shortfall).toEqual({
      creditsRemaining: 23,
      creditsRequired: 30,
    });
  });

  it("treats a refusal without the numbers as exhaustion, as before", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");

    expect(
      notifyMCPJamLimitError({
        code: "user_rate_limit",
        details: { refusalReason: "insufficient_for_request" },
      }),
    ).toBe(true);
    const state = useMCPJamLimitDialogStore.getState();
    expect(state.shortfall).toBeNull();
    expect(state.outOfCreditsHit).toBe(true);
  });

  it.each([
    ["an empty balance", 0, 30],
    ["a requirement the balance covers", 23, 23],
    ["a fractional count", 23.5, 30],
  ])(
    "treats %s as exhaustion, not a shortfall",
    (_label, creditsRemaining, creditsRequired) => {
      useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");

      notifyMCPJamLimitError({
        code: "user_rate_limit",
        details: {
          refusalReason: "insufficient_for_request",
          creditsRemaining,
          creditsRequired,
        },
      });
      const state = useMCPJamLimitDialogStore.getState();
      expect(state.shortfall).toBeNull();
      expect(state.outOfCreditsHit).toBe(true);
    },
  );

  it("unlocks the models an earlier exhaustion locked for the same org", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    notifyMCPJamLimitError({
      code: "user_rate_limit",
      organizationId: "org_a",
    });
    expect(useMCPJamLimitDialogStore.getState().outOfCreditsHit).toBe(true);

    notifyMCPJamLimitError({
      message: INSUFFICIENT_BODY,
      organizationId: "org_a",
    });
    const state = useMCPJamLimitDialogStore.getState();
    expect(state.outOfCreditsHit).toBe(false);
    expect(state.outOfCreditsOrganizationId).toBeNull();
  });

  it("leaves another org's exhaustion latch in place", () => {
    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    notifyMCPJamLimitError({
      code: "user_rate_limit",
      organizationId: "org_a",
    });

    notifyMCPJamLimitError({
      message: INSUFFICIENT_BODY,
      organizationId: "org_b",
    });
    const state = useMCPJamLimitDialogStore.getState();
    expect(state.outOfCreditsHit).toBe(true);
    expect(state.outOfCreditsOrganizationId).toBe("org_a");
  });

  it("does not call the balance used up in the inline line", () => {
    const described = describeMCPJamLimitMessage(INSUFFICIENT_BODY);
    expect(described).toBe(
      "Not enough MCPJam credits. This request needs about 30 MCPJam credits; your organization has 23 left today.",
    );
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
      describeAgentRefusalMessage(
        'HTTP 429: ... "code":"agent_turn_limit" ...',
      ),
    ).toBe("Ask MCPJam has reached today's limit. It resets at 00:00 UTC.");
  });

  it("keeps the burst throttle's own timing instead of sending it to midnight", () => {
    // The reported case. `agent_turn_limit` covers BOTH the 150/day and the
    // 6/minute cap; only `gatedBy` says which. Ten seconds of waiting was
    // being reported as "come back tomorrow".
    expect(
      describeAgentRefusalMessage(
        JSON.stringify({
          code: "agent_turn_limit",
          gatedBy: "burst",
          retryAfterMs: 10000,
          error: "Too many Ask MCPJam turns in a row. Retry in a moment.",
        }),
      ),
    ).toBe("Too many Ask MCPJam turns in a row. Try again in 10s.");
  });

  it("reads a burst throttle out of a nested envelope", () => {
    expect(
      describeAgentRefusalMessage(
        JSON.stringify({
          code: "UPSTREAM",
          details: {
            body: {
              code: "agent_turn_limit",
              gatedBy: "burst",
              retryAfterMs: 4200,
            },
          },
        }),
      ),
    ).toBe("Too many Ask MCPJam turns in a row. Try again in 5s.");
  });

  it("reads a burst throttle out of a body that is not JSON at all", () => {
    expect(
      describeAgentRefusalMessage(
        'HTTP 429: {"code":"agent_turn_limit","gatedBy":"burst"',
      ),
    ).toBe("Too many Ask MCPJam turns in a row. Try again in a moment.");
  });

  it("still sends the DAILY cap to midnight", () => {
    // The distinction has to cut both ways, or the fix just moves the bug.
    expect(
      describeAgentRefusalMessage(
        JSON.stringify({
          code: "agent_turn_limit",
          gatedBy: "user",
          retryAfterMs: 3600000,
        }),
      ),
    ).toBe("Ask MCPJam has reached today's limit. It resets at 00:00 UTC.");
    // And a body that names no `gatedBy` keeps the daily wording it had.
    expect(
      describeAgentRefusalMessage(JSON.stringify({ code: "agent_turn_limit" })),
    ).toBe("Ask MCPJam has reached today's limit. It resets at 00:00 UTC.");
  });

  it("rounds a sub-second wait up rather than saying 0s", () => {
    expect(
      describeAgentRefusalMessage(
        JSON.stringify({
          code: "agent_turn_limit",
          gatedBy: "burst",
          retryAfterMs: 120,
        }),
      ),
    ).toBe("Too many Ask MCPJam turns in a row. Try again in 1s.");
  });

  it("does not read the word burst out of ordinary prose", () => {
    // The substring fallback matches a quoted key/value pair, not the word, so
    // a daily refusal that happens to mention it keeps the midnight copy.
    expect(
      describeAgentRefusalMessage(
        JSON.stringify({
          code: "agent_turn_limit",
          gatedBy: "user",
          error: "daily limit reached after a burst of requests",
        }),
      ),
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
  expect(describeMCPJamLimitMessage("Out of MCPJam credits.")).toContain(
    "Out of MCPJam credits.",
  );
});
