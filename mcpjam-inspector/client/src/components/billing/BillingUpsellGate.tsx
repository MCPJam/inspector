import { useEffect, useRef } from "react";
import { Button } from "@mcpjam/design-system/button";
import type {
  BillingFeatureName,
  OrganizationPlan,
} from "@/hooks/useOrganizationBilling";
import {
  formatBillingFeatureName,
  formatPlanName,
} from "@/lib/billing-entitlements";
import { track } from "@/lib/analytics";

const FEATURE_DESCRIPTIONS: Partial<Record<BillingFeatureName, string>> = {
  evals:
    "Create test suites, run them in the playground, and inspect traces to validate your MCP servers.",
  cicd: "Wire eval runs into your CI/CD pipeline so regressions are caught before they ship.",
  scenarios:
    "Share a hosted chat link for each client, manage access, and review sessions and feedback.",
};

export interface BillingUpsellGateProps {
  feature: BillingFeatureName;
  /** Plan the org is effectively on (for context copy). */
  currentPlan: OrganizationPlan;
  /** Minimum plan that unlocks this feature, when known. */
  upgradePlan: OrganizationPlan | null;
  canManageBilling: boolean;
  onNavigateToBilling: () => void;
  /**
   * `page` (default) owns the whole tab body: full height, centered, in its
   * own bordered card, headed by the feature name.
   *
   * `inline` is the REEV-6 gated screen. It is not just the page variant with
   * the chrome removed: it leads with the plan the reader is on, then says in
   * ONE sentence what to do about it, and the sentence changes on whether they
   * can pay. Sophie's note in review was that the three-sentence page copy
   * buries both facts, and that offering an Upgrade button to someone who
   * cannot manage billing is a dead end.
   *
   * Same entitlement inputs and the same `billing_upsell_gate_viewed` event,
   * so the funnel does not split across the two shapes.
   */
  variant?: "page" | "inline";
  /**
   * What this plan cannot run, phrased as an activity: "user testing swarms",
   * not "Swarms". Only read by `inline`; the page variant keeps naming the
   * feature, which is what its heading is for.
   */
  inlineNoun?: string;
}

export function BillingUpsellGate({
  feature,
  currentPlan,
  upgradePlan,
  canManageBilling,
  onNavigateToBilling,
  variant = "page",
  inlineNoun,
}: BillingUpsellGateProps) {
  const viewedRef = useRef(false);
  const featureName = formatBillingFeatureName(feature);
  const description =
    FEATURE_DESCRIPTIONS[feature] ??
    "This capability is not included on your current plan.";
  const currentLabel = formatPlanName(currentPlan);
  const includedLine = upgradePlan
    ? `Included in ${formatPlanName(upgradePlan)} and above.`
    : `Not included on ${currentLabel}.`;

  useEffect(() => {
    if (viewedRef.current) return;
    viewedRef.current = true;
    track("billing_upsell_gate_viewed", {
      location: "billing_upsell_gate",
      feature,
      current_plan: currentPlan,
      upgrade_plan: upgradePlan,
      can_manage_billing: canManageBilling,
      surface: window.location.pathname,
    });
  }, [canManageBilling, currentPlan, feature, upgradePlan]);

  const body = (
    <>
      {variant === "page" ? (
        <h2 className="text-lg font-semibold">{featureName}</h2>
      ) : null}
      <p className="text-sm text-muted-foreground">{description}</p>
      <p className="text-sm text-muted-foreground">{includedLine}</p>
      {canManageBilling ? (
        <div className="flex justify-center pt-1">
          <Button
            type="button"
            className="mt-3 w-full sm:w-auto"
            onClick={onNavigateToBilling}
          >
            Upgrade
          </Button>
        </div>
      ) : (
        <p className="pt-2 text-sm font-medium text-foreground">
          Ask your admin to upgrade
        </p>
      )}
    </>
  );

  if (variant === "inline") {
    const noun = inlineNoun ?? featureName.toLowerCase();
    // Sophie's two sentences, verbatim in shape. The second is not a softer
    // version of the first: a reader who cannot manage billing has a different
    // next step, and giving them a button that goes nowhere is worse than
    // telling them who to ask.
    const line = canManageBilling
      ? `${featureName} isn't in your plan. Upgrade to ${formatPlanName(upgradePlan ?? "team")} to run ${noun}.`
      : `${featureName} isn't in your plan. Ask your admin to upgrade to ${formatPlanName(upgradePlan ?? "team")} to run ${noun}.`;

    return (
      <div
        className="flex max-w-md flex-col items-center text-center"
        data-testid="billing-upsell-gate"
      >
        {/* The plan first. "Which plan am I on" is the question a reader asks
            before "what does it cost to fix that", and the page variant leaves
            it to a clause halfway down a paragraph. */}
        <span
          className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground"
          data-testid="billing-upsell-plan"
        >
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-muted-foreground"
          />
          Your plan: <b className="font-semibold text-foreground">{currentLabel}</b>
        </span>
        <h2 className="text-balance text-base font-semibold text-foreground">
          {line}
        </h2>
        {canManageBilling ? (
          <Button type="button" className="mt-4" onClick={onNavigateToBilling}>
            See plans
          </Button>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            Your workspace admin can upgrade for everyone.
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-[240px] flex-col items-center justify-center gap-4 p-8 text-center"
      data-testid="billing-upsell-gate"
    >
      <div className="max-w-md space-y-2 rounded-md border border-border/70 p-6 text-center shadow-sm">
        {body}
      </div>
    </div>
  );
}
