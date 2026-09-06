import { useState } from "react";
import type { BillingInterval } from "@/hooks/useOrganizationBilling";
import {
  PlanLimitDialogView,
  type PlanLimitDialogViewProps,
} from "@/components/billing/PlanLimitDialogView";
import {
  CreditsLimitDialogView,
  type CreditsLimitDialogViewProps,
} from "@/components/billing/CreditsLimitDialogView";

/**
 * Dev-only harness for both free-plan walls (eval iterations and credits),
 * reachable at `/__preview/plan-limit` while the dev server runs.
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

type SharedHandlers =
  | "interval"
  | "onIntervalChange"
  | "onUpgrade"
  | "onDismiss"
  | "modal";

type PreviewVariant = {
  id: string;
  label: string;
  note: string;
  props: Omit<PlanLimitDialogViewProps, SharedHandlers | "onRequestEnterprise">;
};

type CreditsVariant = {
  id: string;
  label: string;
  note: string;
  props: Omit<
    CreditsLimitDialogViewProps,
    SharedHandlers | "onBuyCredits" | "onUseOwnKey"
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
        "Free includes 75 a day, and yours reset at 8:00 PM, about 9 hours from now. The Team plan includes 5,000 per seat each month, so evals can run smoothly on every PR instead of limiting your daily quality checks.",
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
        "Free includes 75 a day, and yours reset at 8:00 PM, about 9 hours from now. The Team plan includes 5,000 per seat each month, so evals can run smoothly on every PR instead of limiting your daily quality checks. Only an owner can upgrade this organization.",
      showUpgrade: false,
      showEnterprise: false,
      requestRecipients: [
        { email: "dana@acmerobotics.com", name: "Dana Ruiz" },
      ],
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

const CREDITS_SHARED = {
  organizationName: "Acme Robotics",
  annualPriceLabel: "$30",
  monthlyPriceLabel: "$38",
  annualDiscountPct: 21,
  annualSupported: true,
  monthlySupported: true,
  teamName: "Team",
  isStarting: false,
};

const CREDITS_VARIANTS: CreditsVariant[] = [
  {
    id: "credits-free-owner",
    label: "Free, can upgrade",
    note: "Upgrade leads. Buying credits stays available one step down, and bring-your-own-key drops to a link, because both of those keep the org on Free.",
    props: {
      ...CREDITS_SHARED,
      description:
        "Free credits reset daily. The Team plan replaces the daily cap with a monthly allowance per seat, so usage isn't rationed day to day.",
      isKnownNonManager: false,
      showUpgrade: true,
      requestRecipients: [],
    },
  },
  {
    id: "credits-paid",
    label: "Paid plan, out of credits",
    note: "Already on Team, so there is no plan to pitch. Credits are the actual answer here.",
    props: {
      ...CREDITS_SHARED,
      description:
        "Buy credits to keep your team going, or use your own API key.",
      isKnownNonManager: false,
      showUpgrade: false,
      requestRecipients: [],
    },
  },
  {
    id: "credits-member",
    label: "Member, cannot buy or upgrade",
    note: "Can do neither, so the only action is asking someone who can.",
    props: {
      ...CREDITS_SHARED,
      description:
        "Ask an organization owner or admin to buy credits or upgrade the plan.",
      isKnownNonManager: true,
      showUpgrade: false,
      requestRecipients: [
        { email: "dana@acmerobotics.com", name: "Dana Ruiz" },
      ],
    },
  },
];

const WALLS = [
  { id: "evals" as const, label: "Eval iterations" },
  { id: "credits" as const, label: "Credits" },
];

export function PlanLimitDialogPreview() {
  const [wall, setWall] = useState<"evals" | "credits">("evals");
  const [variantId, setVariantId] = useState(VARIANTS[0].id);
  const [creditsVariantId, setCreditsVariantId] = useState(
    CREDITS_VARIANTS[0].id
  );
  const [interval, setInterval] = useState<BillingInterval>("annual");
  const [lastAction, setLastAction] = useState<string | null>(null);
  const variant = VARIANTS.find((v) => v.id === variantId) ?? VARIANTS[0];
  const creditsVariant =
    CREDITS_VARIANTS.find((v) => v.id === creditsVariantId) ??
    CREDITS_VARIANTS[0];
  const activeVariants = wall === "evals" ? VARIANTS : CREDITS_VARIANTS;
  const activeVariantId = wall === "evals" ? variantId : creditsVariantId;
  const setActiveVariantId =
    wall === "evals" ? setVariantId : setCreditsVariantId;
  const activeNote = wall === "evals" ? variant.note : creditsVariant.note;

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-2xl space-y-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Limit wall preview
          </h1>
          <p className="text-sm text-muted-foreground">
            Real components, real styles, dummy data. Dev only.
          </p>
        </div>

        <div
          role="group"
          aria-label="Wall"
          className="inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/40 p-0.5 text-xs"
        >
          {WALLS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => {
                setWall(w.id);
                setLastAction(null);
              }}
              className={
                w.id === wall
                  ? "rounded bg-background px-3 py-1 font-medium shadow-sm"
                  : "rounded px-3 py-1 font-medium text-muted-foreground"
              }
            >
              {w.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          {activeVariants.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                setActiveVariantId(v.id);
                setLastAction(null);
              }}
              className={
                v.id === activeVariantId
                  ? "rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-sm font-medium"
                  : "rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-foreground/40"
              }
            >
              {v.label}
            </button>
          ))}
        </div>

        <p className="text-sm text-muted-foreground">{activeNote}</p>

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

      {wall === "evals" ? (
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
      ) : (
        <CreditsLimitDialogView
          key={creditsVariant.id}
          {...creditsVariant.props}
          modal={false}
          interval={interval}
          onIntervalChange={setInterval}
          onUpgrade={() => setLastAction(`checkout would start (${interval})`)}
          onBuyCredits={() =>
            setLastAction("would open the buy-credits dialog")
          }
          onUseOwnKey={() =>
            setLastAction("would open the model picker's providers tab")
          }
          onDismiss={() => setLastAction("dismissed")}
        />
      )}
    </div>
  );
}
