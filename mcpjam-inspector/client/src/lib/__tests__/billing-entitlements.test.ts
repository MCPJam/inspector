import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import {
  BILLING_FEATURE_BY_TAB,
  formatBillingLimitReachedMessage,
  formatPremiumnessGateKey,
  getBillingErrorMessage,
  getDisplayPriceCentsForPlan,
  getEvalIterationLimitFromError,
  getPremiumnessGateForTab,
  getRequiredBillingFeatureForTab,
  isGateAccessDenied,
  isPremiumnessGateDeniedForShell,
} from "../billing-entitlements";
import type {
  PlanCatalogEntry,
  PremiumnessGateKey,
  PremiumnessState,
} from "@/hooks/useOrganizationBilling";

const minimalCatalogEntry = (
  prices: PlanCatalogEntry["prices"]
): PlanCatalogEntry =>
  ({
    plan: "team",
    displayName: "Team",
    isSelfServe: true,
    prices,
    features: {} as PlanCatalogEntry["features"],
    limits: {} as PlanCatalogEntry["limits"],
  } as PlanCatalogEntry);

function premiumness(
  overrides: Partial<PremiumnessState> & {
    gates?: PremiumnessState["gates"];
  } = {}
): PremiumnessState {
  return {
    plan: "free",
    enforcementState: "active",
    effectivePlan: "free",
    billingInterval: null,
    source: "free",
    decisionRequired: false,
    gates: [],
    ...overrides,
  };
}

describe("BILLING_FEATURE_BY_TAB", () => {
  it("maps the scenarios tab to the scenarios premiumness feature", () => {
    expect(BILLING_FEATURE_BY_TAB.scenarios).toBe("scenarios");
    expect(getRequiredBillingFeatureForTab("scenarios")).toBe("scenarios");
    expect(getPremiumnessGateForTab("scenarios")).toBe("scenarios");
  });
});

describe("getBillingErrorMessage", () => {
  it("formats backend limit payloads for monthly eval runs", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxEvalRunsPerMonth",
          allowedValue: 500,
        })
      ),
      "fallback"
    );

    expect(message).toBe(
      "This organization has reached its monthly eval run limit (500). Upgrade to continue."
    );
  });

  // Anything that is not a billing rejection goes through `convexErrMessage`,
  // so a write-boundary validator's own message reaches the toast instead of
  // the redacted "[Request ID: …] Server Error" string.
  it("surfaces a non-billing ConvexError payload", () => {
    expect(
      getBillingErrorMessage(
        new ConvexError(
          "Invalid steps: interact step requires a non-empty toolName" as never,
        ),
        "fallback",
      ),
    ).toBe("Invalid steps: interact step requires a non-empty toolName");
  });

  it("surfaces the message of a non-billing object payload", () => {
    expect(
      getBillingErrorMessage(
        new ConvexError({ message: "Pick an element target." } as never),
        "fallback",
      ),
    ).toBe("Pick an element target.");
  });

  // A non-billing payload can arrive JSON-encoded inside `Error.message`
  // (thrown, then stringified). The toast must show the sentence, not the blob.
  it("surfaces the message of a JSON-encoded Error payload", () => {
    expect(
      getBillingErrorMessage(
        new Error(JSON.stringify({ message: "Pick an element target." })),
        "fallback",
      ),
    ).toBe("Pick an element target.");
  });

  it("surfaces the message of a raw string error", () => {
    expect(getBillingErrorMessage("Pick an element target.", "fallback")).toBe(
      "Pick an element target.",
    );
  });

  it("strips the request-id prefix off a plain Error", () => {
    expect(
      getBillingErrorMessage(new Error("[Request ID: abc] boom"), "fallback"),
    ).toBe("boom");
  });

  it("falls back when the error carries nothing readable", () => {
    expect(getBillingErrorMessage(null, "fallback")).toBe("fallback");
    expect(getBillingErrorMessage(new Error(""), "fallback")).toBe("fallback");
  });

  it("formats backend limit payloads for non-billing-admin users", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxEvalRunsPerMonth",
          allowedValue: 500,
        })
      ),
      "fallback",
      false
    );

    expect(message).toBe(
      "This organization has reached its monthly eval run limit (500). Ask an organization owner to upgrade."
    );
  });

  it("formats eval iteration limit payloads with the reset time", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxEvalIterationsPerMonth",
          allowedValue: 25,
          resetsAt: Date.UTC(2026, 5, 2),
          windowKind: "day",
        })
      ),
      "fallback"
    );

    expect(message).toMatch(
      /^This organization has reached its eval iteration limit \(25\)\. Resets /
    );
    // The 402 payload doesn't say who is reading, and this toast reaches
    // members too. No next step beats naming one they can't take.
    expect(message).not.toMatch(/Upgrade to continue now/);
    expect(message).not.toMatch(/Ask an organization owner/);
  });

  it("keeps the eval reset message role-neutral for either reader", () => {
    // A capped-until-reset message names no next step for anyone: the owner
    // doesn't need one, and the member can't act on the one we'd give them.
    for (const canManageBilling of [true, false]) {
      const message = formatBillingLimitReachedMessage(
        "maxEvalIterationsPerMonth",
        25,
        canManageBilling,
        { resetsAt: Date.UTC(2026, 5, 2), windowKind: "day" }
      );

      expect(message).toMatch(/Resets /);
      expect(message).not.toMatch(/Upgrade to continue now/);
      expect(message).not.toMatch(/Ask an organization owner/);
    }
  });

  it("ignores invalid eval reset timestamps", () => {
    const message = formatBillingLimitReachedMessage(
      "maxEvalIterationsPerMonth",
      25,
      true,
      { resetsAt: Number.POSITIVE_INFINITY }
    );

    expect(message).toBe(
      "This organization has reached its eval iteration limit (25). Upgrade to continue."
    );
  });

  it("names the daily journey launch cap instead of failing generically", () => {
    // This file HAND-MIRRORS the backend's `LIMIT_NAMES`, which
    // `buildBillingCatalog` serializes wholesale onto the unauthenticated
    // billing catalog. A backend limit this file does not know about does not
    // crash — the chain below falls through to `null` — it just produces the
    // caller's generic fallback for a refusal we could have explained. That is
    // also why the cross-repo deploy order is free either way.
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "journeyRunsPerDay",
          allowedValue: 100,
        })
      ),
      "fallback"
    );

    expect(message).toBe(
      "This organization has reached its daily journey launch limit (100). Upgrade to launch more."
    );
  });

  it("leads a DAILY cap with its reset, not with an upgrade", () => {
    // The limit lifts by itself at the UTC roll. Sending someone to a pricing
    // page for a wait is the same mistake as reporting a 429 as a 402.
    const message = formatBillingLimitReachedMessage(
      "journeyRunsPerDay",
      100,
      true,
      { resetsAt: Date.UTC(2026, 7, 16) }
    );

    expect(message).toMatch(
      /^This organization has reached its daily journey launch limit \(100\)\. Resets /
    );
    expect(message).not.toContain("Upgrade");
  });

  it("does the same for the daily insights cap", () => {
    const message = formatBillingLimitReachedMessage(
      "insightsPerDay",
      25,
      true,
      { resetsAt: Date.UTC(2026, 7, 16) }
    );

    expect(message).toMatch(
      /^This organization has reached its daily insights limit \(25\)\. Resets /
    );
  });

  it("survives a finite timestamp no calendar can render", () => {
    // `Number.isFinite` is NOT the whole guard. `Number.MAX_VALUE` passes it
    // and then `new Date(...)` is Invalid Date, which makes
    // `Intl.DateTimeFormat.format` THROW — turning a limit message into an
    // exception on the render path that was supposed to explain the limit.
    // Every daily cap goes through the same helper, so check them together.
    for (const limit of [
      "insightsPerDay",
      "journeyRunsPerDay",
      "computerStartsPerDay",
      "maxEvalIterationsPerMonth",
    ] as const) {
      for (const resetsAt of [
        Number.MAX_VALUE,
        -Number.MAX_VALUE,
        8.64e15 + 1,
      ]) {
        const message = formatBillingLimitReachedMessage(limit, 25, true, {
          resetsAt,
        });

        expect(message).toContain("(25)");
        expect(message).not.toContain("Resets");
      }
    }
  });

  it("falls back to the upgrade line when no reset was sent", () => {
    // A mixed-version backend that has the cap but not the field. Three ways to
    // say "no reset" — omitted, explicitly null, and not a number — and all
    // three have to land on the same sentence rather than a half-written one.
    expect(formatBillingLimitReachedMessage("insightsPerDay", 25, true)).toBe(
      "This organization has reached its daily insights limit (25). Upgrade to continue."
    );
    for (const resetsAt of [null, undefined, Number.NaN]) {
      expect(
        formatBillingLimitReachedMessage("insightsPerDay", 25, true, {
          resetsAt: resetsAt as number | undefined,
        })
      ).toBe(
        "This organization has reached its daily insights limit (25). Upgrade to continue."
      );
    }
  });

  it("formats backend limit payloads for project scenarios", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxScenariosPerProject",
          allowedValue: 5,
        })
      ),
      "fallback"
    );

    expect(message).toBe(
      "This project has reached its swarm limit (5). Upgrade to continue."
    );
  });

  it("formats backend limit payloads for organization members", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxMembers",
          allowedValue: 3,
        })
      ),
      "fallback"
    );

    expect(message).toBe(
      "This organization has reached its member limit (3). Upgrade to add more members."
    );
  });

  it("formats member-limit payloads for non-billing-admin users", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxMembers",
          allowedValue: 3,
        })
      ),
      "fallback",
      false
    );

    expect(message).toBe(
      "This organization has reached its member limit (3). Ask an organization owner to upgrade."
    );
  });

  it("formats backend limit payloads for projects", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxProjects",
          allowedValue: 1,
        })
      ),
      "fallback"
    );

    expect(message).toBe(
      "This organization has reached its project limit (1). Upgrade to create more projects."
    );
  });

  it("formats project-limit payloads for non-billing-admin users", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxProjects",
          allowedValue: 1,
        })
      ),
      "fallback",
      false
    );

    expect(message).toBe(
      "This organization has reached its project limit (1). Ask an organization owner to upgrade."
    );
  });

  it("formats billing_feature_not_included using the current plan name", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_feature_not_included",
          feature: "scenarios",
          plan: "free",
          upgradePlan: "team",
        })
      ),
      "fallback"
    );

    expect(message).toBe(
      "Swarms is not included in the Free plan. Upgrade to Team to continue."
    );
  });

  it("formats billing_feature_not_included for non-billing admins with explicit upgrade guidance", () => {
    const message = getBillingErrorMessage(
      new Error(
        JSON.stringify({
          code: "billing_feature_not_included",
          feature: "scenarios",
          plan: "free",
          upgradePlan: "team",
        })
      ),
      "fallback",
      false
    );

    expect(message).toBe(
      "Swarms is not included in the Free plan. Ask an organization owner to upgrade to Team."
    );
  });

  it("preserves non-billing ConvexError messages", () => {
    const error = new ConvexError({
      code: "rate_limited",
      retryAfter: 5,
    });
    error.message = 'ConvexError: {"code":"rate_limited","retryAfter":5}';

    const message = getBillingErrorMessage(error, "fallback");

    expect(message).toBe('ConvexError: {"code":"rate_limited","retryAfter":5}');
  });
});

describe("isGateAccessDenied", () => {
  it("treats enforcement disabled as never locked (soft mode)", () => {
    expect(
      isGateAccessDenied(
        premiumness({
          enforcementState: "disabled",
          gates: [
            {
              gateKey: "evals",
              kind: "feature",
              scope: "project",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "team",
              reason: "feature_not_included",
            },
          ],
        }),
        "evals"
      )
    ).toBe(false);
  });

  it("denies when enforcement is enabled and the gate decision disallows", () => {
    expect(
      isGateAccessDenied(
        premiumness({
          gates: [
            {
              gateKey: "evals",
              kind: "feature",
              scope: "project",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "team",
              reason: "feature_not_included",
            },
          ],
        }),
        "evals"
      )
    ).toBe(true);
  });

  it("respects explicit denied maxProjects gate decisions", () => {
    expect(
      isGateAccessDenied(
        premiumness({
          gates: [
            {
              gateKey: "maxProjects",
              kind: "limit",
              scope: "organization",
              canAccess: false,
              shouldShowUpsell: true,
              upgradePlan: "team",
              reason: "limit_reached",
              currentValue: 1,
              allowedValue: 1,
            },
          ],
        }),
        "maxProjects"
      )
    ).toBe(true);
  });

  it("allows scenarios for enterprise when the gate decision grants access", () => {
    expect(
      isGateAccessDenied(
        premiumness({
          plan: "enterprise",
          effectivePlan: "enterprise",
          gates: [
            {
              gateKey: "scenarios",
              kind: "feature",
              scope: "organization",
              canAccess: true,
              shouldShowUpsell: false,
              upgradePlan: null,
              reason: "feature_included",
            },
          ],
        }),
        "scenarios"
      )
    ).toBe(false);
  });
});

describe("getDisplayPriceCentsForPlan", () => {
  it("returns catalog cents for Team and Team", () => {
    const drifted = minimalCatalogEntry({
      monthly: 6100,
      annual: 29000,
    });
    expect(getDisplayPriceCentsForPlan("team", "annual", drifted)).toBe(29000);
    expect(getDisplayPriceCentsForPlan("team", "monthly", drifted)).toBe(6100);
  });

  it("falls back to catalog for other plans", () => {
    const entry = minimalCatalogEntry({ monthly: null, annual: null });
    expect(getDisplayPriceCentsForPlan("free", "monthly", entry)).toBeNull();
  });
});

describe("isPremiumnessGateDeniedForShell", () => {
  it("prefers project premiumness when a project exists", () => {
    const denied = isPremiumnessGateDeniedForShell({
      billingUiEnabled: true,
      hasProject: true,
      gateKey: "evals",
      projectPremiumness: premiumness({
        gates: [
          {
            gateKey: "evals",
            kind: "feature",
            scope: "project",
            canAccess: false,
            shouldShowUpsell: true,
            upgradePlan: "team",
            reason: "feature_not_included",
          },
        ],
      }),
      organizationPremiumness: premiumness({
        gates: [
          {
            gateKey: "evals",
            kind: "feature",
            scope: "project",
            canAccess: true,
            shouldShowUpsell: false,
            upgradePlan: null,
            reason: "feature_included",
          },
        ],
      }),
    });
    expect(denied).toBe(true);
  });
});

describe("formatPremiumnessGateKey", () => {
  it("names the daily journey launch gate", () => {
    // The gate key ARRIVES whether or not this file knows it — the backend
    // sends `GateDecision.gateKey` verbatim — so a missing case is not a crash,
    // it is the raw key rendered at a user: "journeyRunsPerDay is not included
    // in the Free plan". This pairs with the backend gate of the same name.
    expect(formatPremiumnessGateKey("journeyRunsPerDay")).toBe(
      "Journey launches per day"
    );
  });

  it("names every gate key it declares", () => {
    // The union is a hand-mirror of the backend's gate list. A key added there
    // and mirrored here but never given a label falls through to the default
    // and reads as an identifier — which is the whole failure this map exists
    // to prevent, so catch it as a set rather than one case at a time.
    const gateKeys: PremiumnessGateKey[] = [
      "scenarios",
      "evals",
      "cicd",
      "auditLog",
      "maxMembers",
      "maxProjects",
      "maxServersPerProject",
      "maxScenariosPerProject",
      "maxEvalRunsPerMonth",
      "maxEvalIterationsPerMonth",
      "insightsPerDay",
      "journeyRunsPerDay",
    ];

    for (const key of gateKeys) {
      expect(formatPremiumnessGateKey(key), key).not.toBe(key);
    }
  });
});

describe("getEvalIterationLimitFromError", () => {
  const evalLimitError = (extra: Record<string, unknown>) =>
    new ConvexError({
      code: "billing_limit_reached",
      limit: "maxEvalIterationsPerMonth",
      allowedValue: 25,
      currentValue: 25,
      ...extra,
    } as never);

  it("takes the window the backend sent, on either plan", () => {
    expect(
      getEvalIterationLimitFromError(
        evalLimitError({ plan: "free", windowKind: "day" })
      )?.windowKind
    ).toBe("day");
    expect(
      getEvalIterationLimitFromError(
        evalLimitError({ plan: "team", windowKind: "month" })
      )?.windowKind
    ).toBe("month");
  });

  it("falls back to the plan when the payload omits the window", () => {
    // One limit NAME, two windows — daily on Free, monthly per seat on Team —
    // and the wall prints the word ("out of eval iterations today" vs "this
    // month"). A constant would be wrong for one of the two plans every time,
    // and wrong toward "month" is the costlier direction: it sells a wait that
    // ends at the next UTC roll as a month-long block.
    expect(
      getEvalIterationLimitFromError(evalLimitError({ plan: "free" }))
        ?.windowKind
    ).toBe("day");
    expect(
      getEvalIterationLimitFromError(evalLimitError({ plan: "team" }))
        ?.windowKind
    ).toBe("month");
  });

  it("keeps the narrower claim when neither window nor plan is known", () => {
    expect(getEvalIterationLimitFromError(evalLimitError({}))?.windowKind).toBe(
      "day"
    );
    expect(
      getEvalIterationLimitFromError(evalLimitError({ windowKind: "week" }))
        ?.windowKind
    ).toBe("day");
  });

  it("ignores errors that are not this cap", () => {
    expect(
      getEvalIterationLimitFromError(
        new ConvexError({
          code: "billing_limit_reached",
          limit: "insightsPerDay",
          allowedValue: 25,
        } as never)
      )
    ).toBeNull();
    expect(getEvalIterationLimitFromError(new Error("boom"))).toBeNull();
  });
});
