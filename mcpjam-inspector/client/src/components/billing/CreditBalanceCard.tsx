import { type ReactNode, useEffect, useState } from "react";
import { Info, Settings } from "lucide-react";
import { CoinStackIcon } from "@/components/ui/coin-stack-icon";
import { Card, CardContent } from "@mcpjam/design-system/card";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@mcpjam/design-system/dialog";
import { Progress } from "@mcpjam/design-system/progress";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  AutoTopupSettings,
  type AutoTopupSettingsProps,
} from "./AutoTopupSettings";
import { CreditTopupDialog } from "@/components/billing/CreditTopupDialog";
import { PendingCreditTopupsBanner } from "@/components/billing/PendingCreditTopupsBanner";
import { TopupActionButton } from "@/components/billing/TopupActionButton";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import { useEvalIterationQuota } from "@/hooks/use-eval-iteration-quota";
import {
  formatEvalIterationResetTime,
  getEvalIterationQuotaLabel,
} from "@/lib/eval-iteration-quota";
import {
  formatCreditResetText,
  formatMonthlyResetText,
} from "@/lib/credit-usage";
import type { CreditTopupSource } from "@/hooks/useCreditTopup";
import { useAppNavigate, buildOrganizationPath } from "@/lib/app-navigation";
import { consumeUrlFlag } from "@/lib/url-flag";

interface CreditBalanceCardProps {
  organizationId?: string | null;
  canManageCredits?: boolean;
  /** Optional override for the chat session id used by the top-up flow. */
  chatSessionId?: string;
  autoManagePanel?: ReactNode;
  autoTopup?: Omit<AutoTopupSettingsProps, "canManage">;
}

export function CreditBalanceCard({
  organizationId,
  canManageCredits = false,
  chatSessionId,
  autoManagePanel,
  autoTopup,
}: CreditBalanceCardProps = {}) {
  const navigate = useAppNavigate();
  const { balance, isLoading } = useCreditBalance({
    organizationId,
  });
  const { quota: evalIterationQuota, isLoading: isEvalIterationQuotaLoading } =
    useEvalIterationQuota({
      organizationId,
    });
  const [isTopupOpen, setIsTopupOpen] = useState(false);
  const [isAutoManageOpen, setIsAutoManageOpen] = useState(false);
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
    if (consumeUrlFlag("topup", "open")) {
      setArrivedFromLimitModal(true);
    }
  }, []);

  // Open the dialog only once we know the user can manage credits. A member
  // who can't top up keeps `arrivedFromLimitModal` true and instead sees the
  // "ask an admin" hint below — not a silent dead-end where the flag was
  // consumed but nothing happened.
  useEffect(() => {
    if (arrivedFromLimitModal && canManageCredits) {
      setTopupSource("limit_modal");
      setIsTopupOpen(true);
      setArrivedFromLimitModal(false);
    }
  }, [arrivedFromLimitModal, canManageCredits]);

  const handleManualTopup = () => {
    setTopupSource("billing_page");
    setIsTopupOpen(true);
  };

  const hasPaidHistory = balance?.hasPurchaseHistory === true;

  // Team-plan orgs bill against a monthly per-seat allowance instead of the
  // daily free bucket. Paid top-ups are shown separately and spent only after
  // the allowance runs out.
  const showMonthly = balance?.billingModel === "monthly_per_seat";
  const monthlyTotal = balance?.monthlyAllowanceTotal ?? 0;
  const monthlyRemaining = balance?.monthlyAllowanceRemaining ?? 0;
  const paidRemaining = balance?.paidCreditsRemaining ?? 0;
  const monthlyExhausted =
    showMonthly && monthlyRemaining <= 0 && paidRemaining <= 0;
  const showEvalIterationUsage =
    isEvalIterationQuotaLoading ||
    (evalIterationQuota !== undefined && evalIterationQuota.allowed !== null);
  const evalIterationLabel = getEvalIterationQuotaLabel(
    evalIterationQuota?.windowKind,
  );

  return (
    <Card className="border-0 bg-transparent py-0 shadow-none">
      <CardContent className="flex flex-col gap-5 p-0">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              Usage
            </p>
            <p className="mt-1 text-sm font-semibold leading-snug">
              Organization usage
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Model credits and eval iterations are shared across this
              organization.
            </p>
          </div>
          {organizationId && canManageCredits ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 self-start"
              onClick={() =>
                navigate(
                  `${buildOrganizationPath(organizationId, "billing")}/usage`,
                )
              }
            >
              See more
            </Button>
          ) : null}
        </div>

        {canManageCredits ? (
          <ErrorBoundary
            name="credit_balance_pending_topups"
            fallback={
              <p className="text-xs text-muted-foreground">
                Pending top-ups unavailable
              </p>
            }
          >
            <PendingCreditTopupsBanner organizationId={organizationId} />
          </ErrorBoundary>
        ) : null}

        {showMonthly ? (
          <UsageRow
            label="Monthly team credits"
            tooltip={
              monthlyTotal > 0
                ? `Up to ${monthlyTotal.toLocaleString()} unused credits roll over each month, in addition to your next ${monthlyTotal.toLocaleString()} credits.`
                : "Unused credits roll over each month, up to your plan’s monthly credit allowance."
            }
            rightText={
              isLoading || !balance
                ? null
                : `${monthlyRemaining.toLocaleString()} / ${monthlyTotal.toLocaleString()} · ${formatMonthlyResetText(
                    balance.monthlyResetAt,
                  )}`
            }
            fillPercent={
              isLoading || monthlyTotal <= 0
                ? 0
                : (monthlyRemaining / monthlyTotal) * 100
            }
            ariaLabel="Monthly team credits remaining"
            ariaValueText={`${monthlyRemaining.toLocaleString()} of ${monthlyTotal.toLocaleString()} monthly credits remaining`}
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
                    balance.freeDailyResetAt,
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

        {showEvalIterationUsage ? (
          <UsageRow
            label={evalIterationLabel}
            tooltip={
              evalIterationQuota
                ? `Resets ${formatEvalIterationResetTime(
                    evalIterationQuota.resetsAt,
                  )}`
                : undefined
            }
            // "remaining / allowed": bar drains as iterations are used —
            // matches the monthly team credits row.
            rightText={
              isEvalIterationQuotaLoading ||
              !evalIterationQuota ||
              evalIterationQuota.allowed === null
                ? null
                : `${Math.max(
                    0,
                    evalIterationQuota.allowed - evalIterationQuota.used,
                  ).toLocaleString()} / ${evalIterationQuota.allowed.toLocaleString()}`
            }
            fillPercent={
              isEvalIterationQuotaLoading ||
              !evalIterationQuota ||
              !evalIterationQuota.allowed
                ? 0
                : Math.max(
                    0,
                    ((evalIterationQuota.allowed - evalIterationQuota.used) /
                      evalIterationQuota.allowed) *
                      100,
                  )
            }
            ariaLabel={`${evalIterationLabel} remaining`}
            ariaValueText={
              evalIterationQuota && evalIterationQuota.allowed !== null
                ? `${Math.max(
                    0,
                    evalIterationQuota.allowed - evalIterationQuota.used,
                  ).toLocaleString()} of ${evalIterationQuota.allowed.toLocaleString()} eval iterations remaining`
                : undefined
            }
            isLoading={isEvalIterationQuotaLoading}
            testId="usage-eval-iterations"
          />
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
        <div
          className={`grid gap-4 border-t border-border/60 pt-5 ${
            autoManagePanel ? "sm:grid-cols-2" : ""
          }`}
        >
          <section
            className="flex flex-col gap-4 rounded-lg border border-border/60 p-4"
            aria-label="Buy Credits"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Buy Credits</h3>
              {canManageCredits ? (
                <ErrorBoundary
                  name="credit_balance_topup_button"
                  fallback={
                    <span className="self-center text-xs text-muted-foreground">
                      Top up unavailable
                    </span>
                  }
                >
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
            <p className="text-xs leading-relaxed text-muted-foreground">
              Add credits when you need them. Purchased credits are shared
              across your organization.
            </p>
          </section>
          {autoManagePanel ? (
            <section
              className="flex flex-col gap-4 rounded-lg border border-border/60 p-4"
              aria-label="Auto-reload"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">Auto-reload</h3>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setIsAutoManageOpen(true)}
                >
                  <Settings className="size-4" aria-hidden="true" />
                  Manage
                </Button>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Automatically add credits when your balance runs low.
              </p>
            </section>
          ) : null}
        </div>
      </CardContent>
      {autoManagePanel ? (
        <Dialog open={isAutoManageOpen} onOpenChange={setIsAutoManageOpen}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Auto-reload</DialogTitle>
              <DialogDescription>
                Automatically purchase credits when you’re running low.
              </DialogDescription>
            </DialogHeader>
            <AutoTopupSettings
              {...autoTopup}
              canManage={canManageCredits}
              onClose={() => setIsAutoManageOpen(false)}
            />
          </DialogContent>
        </Dialog>
      ) : null}
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
  /** Accessible label for the progress bar. Defaults to the daily usage label. */
  ariaLabel?: string;
  /** Human-readable progress value for screen readers (e.g. "X of Y remaining"). */
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
  ariaLabel,
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
          aria-label={ariaLabel ?? `${label} used`}
          aria-valuetext={ariaValueText}
        />
      )}
    </div>
  );
}
