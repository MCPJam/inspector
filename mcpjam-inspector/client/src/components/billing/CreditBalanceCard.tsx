import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { CoinStackIcon } from "@/components/ui/coin-stack-icon";
import { Card, CardContent } from "@mcpjam/design-system/card";
import { Progress } from "@mcpjam/design-system/progress";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { CreditTopupDialog } from "@/components/billing/CreditTopupDialog";
import { PendingCreditTopupsBanner } from "@/components/billing/PendingCreditTopupsBanner";
import { TopupActionButton } from "@/components/billing/TopupActionButton";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import {
  formatCreditResetText,
  formatMonthlyResetText,
} from "@/lib/credit-usage";
import { useTeamCreditsUiEnabled } from "@/lib/team-credits-flag";
import type { CreditTopupSource } from "@/hooks/useCreditTopup";

/** Pulls the limit-modal redirect flag out of the current URL and clears it
 * so the topup dialog opens exactly once on landing. */
function consumeTopupFlag(): boolean {
  if (typeof window === "undefined") return false;

  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.get("topup") === "open") {
    searchParams.delete("topup");
    const remaining = searchParams.toString();
    const nextSearch = remaining ? `?${remaining}` : "";
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch}`
    );
    return true;
  }

  return false;
}

interface CreditBalanceCardProps {
  organizationId?: string | null;
  canManageCredits?: boolean;
  /** Optional override for the chat session id used by the top-up flow. */
  chatSessionId?: string;
}

export function CreditBalanceCard({
  organizationId,
  canManageCredits = false,
  chatSessionId,
}: CreditBalanceCardProps = {}) {
  const creditsUiEnabled = useTeamCreditsUiEnabled();
  const { balance, isLoading } = useCreditBalance({
    organizationId,
    enabled: creditsUiEnabled,
  });
  const [isTopupOpen, setIsTopupOpen] = useState(false);
  const [topupSource, setTopupSource] =
    useState<CreditTopupSource>("billing_page");
  // Whether the user landed here from the global limit modal (`?topup=open`).
  // Captured once on mount, then acted on once we know whether they can
  // manage credits — `canManageCredits` can arrive a render late while the
  // org role resolves.
  const [arrivedFromLimitModal, setArrivedFromLimitModal] = useState(false);

  // One-shot: consume the redirect flag from the URL so a reload doesn't
  // reopen the dialog. Source is recorded as `limit_modal` so the funnel can
  // attribute the top-up back to the limit-hit that triggered the redirect.
  useEffect(() => {
    if (!creditsUiEnabled) return;
    if (consumeTopupFlag()) {
      setArrivedFromLimitModal(true);
    }
  }, [creditsUiEnabled]);

  // Open the dialog only once we know the user can manage credits. A member
  // who can't top up keeps `arrivedFromLimitModal` true and instead sees the
  // "ask an admin" hint below — not a silent dead-end where the flag was
  // consumed but nothing happened.
  useEffect(() => {
    if (!creditsUiEnabled) return;
    if (arrivedFromLimitModal && canManageCredits) {
      setTopupSource("limit_modal");
      setIsTopupOpen(true);
      setArrivedFromLimitModal(false);
    }
  }, [arrivedFromLimitModal, canManageCredits, creditsUiEnabled]);

  const handleManualTopup = () => {
    setTopupSource("billing_page");
    setIsTopupOpen(true);
  };

  const hasPaidHistory = balance?.hasPurchaseHistory === true;

  // Team-plan orgs bill against a monthly per-seat allowance instead of the
  // daily free bucket. Paid top-ups are shown separately and spent only after
  // the allowance runs out.
  const isMonthly = balance?.billingModel === "monthly_per_seat";
  const monthlyTotal = balance?.monthlyAllowanceTotal ?? 0;
  const monthlyRemaining = balance?.monthlyAllowanceRemaining ?? 0;
  const monthlySpent = Math.max(0, monthlyTotal - monthlyRemaining);
  const paidRemaining = isMonthly
    ? (balance?.paidCreditsRemaining ?? 0)
    : (balance?.availableCredits ?? 0);
  const monthlyExhausted =
    isMonthly && monthlyRemaining <= 0 && paidRemaining <= 0;

  if (!creditsUiEnabled) return null;

  return (
    <Card className="border-border/60 py-6 shadow-sm">
      <CardContent className="flex flex-col gap-5 px-4 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              Credit usage
            </p>
            <p className="mt-1 text-sm font-semibold leading-snug">
              Organization model credits
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Shared credits are available to everyone in this organization.
            </p>
          </div>
          {canManageCredits ? (
            <ErrorBoundary fallback={null}>
              <TopupActionButton onClick={handleManualTopup} />
            </ErrorBoundary>
          ) : (
            <span
              className="self-center text-xs text-muted-foreground"
              data-testid="usage-ask-admin"
            >
              Ask org admin to top up credits
            </span>
          )}
        </div>

        {canManageCredits ? (
          <ErrorBoundary fallback={null}>
            <PendingCreditTopupsBanner organizationId={organizationId} />
          </ErrorBoundary>
        ) : null}

        {isMonthly ? (
          <UsageRow
            label="Monthly team credits"
            tooltip="Refreshes each billing cycle. Unused credits don't roll over."
            rightText={
              isLoading || !balance
                ? null
                : `${monthlySpent.toLocaleString()} / ${monthlyTotal.toLocaleString()} · ${formatMonthlyResetText(
                    balance.monthlyResetAt
                  )}`
            }
            fillPercent={
              isLoading || monthlyTotal <= 0
                ? 0
                : (monthlySpent / monthlyTotal) * 100
            }
            ariaValueText={`${monthlySpent.toLocaleString()} of ${monthlyTotal.toLocaleString()} monthly credits used`}
            isLoading={isLoading}
            showCoin
            testId="usage-monthly"
          />
        ) : (
          <UsageRow
            label="Free daily credits"
            rightText={
              isLoading || !balance
                ? null
                : `${(
                    balance.freeDailyCreditsTotal -
                    balance.freeDailyCreditsRemaining
                  ).toLocaleString()} / ${balance.freeDailyCreditsTotal.toLocaleString()} · ${formatCreditResetText(
                    balance.freeDailyResetAt
                  )}`
            }
            // "spent / total": count and bar both grow as credits are used —
            // 0/300 empty when fresh, 300/300 full when drained. Matches the
            // sidebar usage strip.
            fillPercent={
              isLoading || !balance || balance.freeDailyCreditsTotal <= 0
                ? 0
                : ((balance.freeDailyCreditsTotal -
                    balance.freeDailyCreditsRemaining) /
                    balance.freeDailyCreditsTotal) *
                  100
            }
            isLoading={isLoading}
            showCoin
            testId="usage-daily"
          />
        )}

        {monthlyExhausted ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="usage-monthly-exhausted"
          >
            Monthly credits used.{" "}
            {formatMonthlyResetText(balance?.monthlyResetAt)}
            {canManageCredits ? " — or top up to keep going." : "."}
          </p>
        ) : null}

        {!isLoading && hasPaidHistory && balance && (
          <div
            className="flex items-center justify-between gap-2"
            data-testid="usage-paid"
          >
            <span className="text-xs font-medium">Shared paid credits</span>
            <span className="flex items-center gap-1 text-xs font-medium">
              <CoinStackIcon aria-hidden="true" className="size-3" />
              {paidRemaining.toLocaleString()} credits
            </span>
          </div>
        )}

        {/* Wallet-lock notice is independent of purchase history: a wallet can
            be locked (chargeback/dispute) with no completed purchase on
            record, and that's exactly when the user needs to know spending is
            paused. Gating it on hasPaidHistory would hide it in that case. */}
        {!isLoading && balance?.walletLocked ? (
          <p
            className="text-xs text-destructive"
            data-testid="usage-wallet-locked"
          >
            Credit spending is paused pending review.
          </p>
        ) : null}

      </CardContent>
      {isTopupOpen && canManageCredits && (
        <CreditTopupDialog
          open
          onOpenChange={setIsTopupOpen}
          chatSessionId={chatSessionId ?? ""}
          lastUserMessage=""
          organizationId={organizationId}
          source={topupSource}
        />
      )}
    </Card>
  );
}

interface UsageRowProps {
  label: string;
  rightText: string | null;
  fillPercent: number;
  isLoading: boolean;
  testId?: string;
  /** Prefix the value with a coin icon — matches the credit-amount rows. */
  showCoin?: boolean;
  /** Optional explainer surfaced via an info icon next to the label. */
  tooltip?: string;
  /** Human-readable progress value for screen readers (e.g. "X of Y used"). */
  ariaValueText?: string;
}

function UsageRow({
  label,
  rightText,
  fillPercent,
  isLoading,
  testId,
  showCoin = false,
  tooltip,
  ariaValueText,
}: UsageRowProps) {
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 font-medium">
          {label}
          {tooltip ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`About ${label}`}
                  // Defensive: stop bubbling so a future clickable parent
                  // wrapper doesn't fire when the user clicks the info icon.
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  className="inline-flex items-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
                >
                  <Info aria-hidden="true" className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>{tooltip}</TooltipContent>
            </Tooltip>
          ) : null}
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          {isLoading || rightText == null ? (
            <Skeleton className="h-3 w-24" />
          ) : (
            <>
              {showCoin ? (
                <CoinStackIcon aria-hidden="true" className="size-3" />
              ) : null}
              {rightText}
            </>
          )}
        </span>
      </div>
      {isLoading ? (
        <Skeleton className="h-2 w-full rounded-full" />
      ) : (
        <Progress
          value={fillPercent}
          aria-label={`${label} used`}
          aria-valuetext={ariaValueText}
        />
      )}
    </div>
  );
}
