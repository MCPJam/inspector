import { useState } from "react";
import type { BillingInterval } from "@/hooks/useOrganizationBilling";
import {
  PlanLimitDialogView,
  type PlanLimitDialogViewProps,
} from "@/components/billing/PlanLimitDialogView";

/**
 * Dev-only harness for the eval-iteration wall, reachable at
 * `/__preview/plan-limit` while the dev server runs.
 *
 * Mounted from `main.tsx` BEFORE the auth and Convex providers, so it needs no
 * sign-in, no hosted org, and no organization sitting at its cap — states that
 * are otherwise impossible to reach on demand. It renders the real
 * `PlanLimitDialogView` with the real stylesheet, so what you see is what
 * production renders; only the data is fake.
 *
 * Excluded from production bundles by the `import.meta.env.DEV` guard at the
 * call site in `main.tsx`.
 */

type PreviewVariant = {
  id: string;
  label: string;
  note: string;
  props: Omit<
    PlanLimitDialogViewProps,
    | "interval"
    | "onIntervalChange"
    | "onUpgrade"
    | "onRequestEnterprise"
    | "onDismiss"
    | "modal"
  >;
};

const SHARED = {
  organizationName: "Acme Robotics",
  origin: "evals" as const,
  limitKind: "evalIterations",
  annualPriceLabel: "$30",
  monthlyPriceLabel: "$38",
  annualDiscountPct: 21,
  annualSupported: true,
  monthlySupported: true,
  teamName: "Team",
  isStarting: false,
};

const VARIANTS: PreviewVariant[] = [
  {
    id: "free-owner",
    label: "Free, can upgrade",
    note: "The main case: an owner or admin on Free who just got blocked mid-suite.",
    props: {
      ...SHARED,
      title: "You're out of eval iterations today",
      description:
        "Free includes 75 a day, and yours reset at 8:00 PM, about 9 hours from now. Our Team plan includes 5,000 a month, so evals can run smoothly on every PR instead of limiting your daily quality checks.",
      showUpgrade: true,
      showEnterprise: false,
      requestRecipients: [],
    },
  },
  {
    id: "free-member",
    label: "Free, cannot upgrade",
    note: "A member. Cannot check out, so the action is an email to the owner with the steps.",
    props: {
      ...SHARED,
      title: "You're out of eval iterations today",
      description:
        "Free includes 75 a day, and yours reset at 8:00 PM, about 9 hours from now. Our Team plan includes 5,000 a month, so evals can run smoothly on every PR instead of limiting your daily quality checks. Only an owner can upgrade this organization.",
      showUpgrade: false,
      showEnterprise: false,
      requestRecipients: [{ email: "dana@acmerobotics.com", name: "Dana Ruiz" }],
    },
  },
  {
    id: "team-ceiling",
    label: "Team, at its ceiling",
    note: "Already paying. No self-serve step left, so the path is sales.",
    props: {
      ...SHARED,
      title: "You're out of eval iterations this month",
      description:
        "Your plan includes 5,000 a month, and yours reset at 12:00 AM, about 9 days from now. Enterprise adds negotiated usage and a custom LLM budget.",
      showUpgrade: false,
      showEnterprise: true,
      requestRecipients: [],
    },
  },
  {
    id: "no-owner",
    label: "Cannot upgrade, no owner found",
    note: "No reachable owner, or the lookup hasn't returned yet. Either way there's no address to write to, so the button hides rather than opening an empty draft.",
    props: {
      ...SHARED,
      title: "You're out of eval iterations today",
      description:
        "Free includes 75 a day, and yours reset at 8:00 PM, about 9 hours from now. Only an owner can upgrade this organization.",
      showUpgrade: false,
      showEnterprise: false,
      requestRecipients: [],
    },
  },
];

export function PlanLimitDialogPreview() {
  const [variantId, setVariantId] = useState(VARIANTS[0].id);
  const [interval, setInterval] = useState<BillingInterval>("annual");
  const [lastAction, setLastAction] = useState<string | null>(null);
  const variant = VARIANTS.find((v) => v.id === variantId) ?? VARIANTS[0];

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-2xl space-y-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Eval limit wall preview
          </h1>
          <p className="text-sm text-muted-foreground">
            Real component, real styles, dummy data. Dev only.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {VARIANTS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                setVariantId(v.id);
                setLastAction(null);
              }}
              className={
                v.id === variantId
                  ? "rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-sm font-medium"
                  : "rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-foreground/40"
              }
            >
              {v.label}
            </button>
          ))}
        </div>

        <p className="text-sm text-muted-foreground">{variant.note}</p>

        <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
          <span className="text-muted-foreground">Selected interval: </span>
          <span className="font-medium">{interval}</span>
          {lastAction ? (
            <>
              <span className="text-muted-foreground"> · last action: </span>
              <span className="font-medium">{lastAction}</span>
            </>
          ) : null}
        </div>
      </div>

      <PlanLimitDialogView
        key={variant.id}
        {...variant.props}
        modal={false}
        interval={interval}
        onIntervalChange={setInterval}
        onUpgrade={() => setLastAction(`checkout would start (${interval})`)}
        onRequestEnterprise={() =>
          setLastAction("would open mcpjam.com/contact in a new tab")
        }
        onDismiss={() => setLastAction("dismissed")}
      />
    </div>
  );
}
