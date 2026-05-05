import { useEffect, useState } from "react";
import { Card, CardContent } from "@mcpjam/design-system/card";
import { Progress } from "@mcpjam/design-system/progress";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { CreditTopupDialog } from "@/components/billing/CreditTopupDialog";
import { TopupActionButton } from "@/components/billing/TopupActionButton";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import { formatCreditResetText } from "@/lib/credit-usage";
import type { CreditTopupSource } from "@/hooks/useCreditTopup";

/** Pulls the limit-modal redirect flag out of the current hash and clears it
 * from the URL so the topup dialog opens exactly once on landing. The flag
 * lives after a `?` in the hash; the hosted hash router already strips
 * everything after `?` before route resolution, so removing it here doesn't
 * affect navigation. */
function consumeTopupFlagFromHash(): boolean {
  if (typeof window === "undefined") return false;
  const hash = window.location.hash;
  const queryStart = hash.indexOf("?");
  if (queryStart < 0) return false;
  const params = new URLSearchParams(hash.slice(queryStart + 1));
  if (params.get("topup") !== "open") return false;
  params.delete("topup");
  const remaining = params.toString();
  const nextHash = hash.slice(0, queryStart) + (remaining ? `?${remaining}` : "");
  // Use replaceState so we don't push an extra history entry the user has
  // to back-button through.
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${nextHash}`,
  );
  return true;
}

interface CreditBalanceCardProps {
  /** Optional override for the chat session id used by the top-up flow. */
  chatSessionId?: string;
}

export function CreditBalanceCard({
  chatSessionId,
}: CreditBalanceCardProps = {}) {
  const { balance, isLoading } = useCreditBalance();
  const [isTopupOpen, setIsTopupOpen] = useState(false);
  const [topupSource, setTopupSource] =
    useState<CreditTopupSource>("billing_page");

  // Auto-open the topup dialog when the user is redirected here from the
  // global limit modal (`#organizations/{id}/billing?topup=open`). One-shot:
  // the flag is consumed from the URL so a subsequent reload doesn't reopen.
  // Source is recorded as `limit_modal` so the funnel can attribute the
  // top-up back to the limit-hit that triggered the redirect.
  useEffect(() => {
    if (consumeTopupFlagFromHash()) {
      setTopupSource("limit_modal");
      setIsTopupOpen(true);
    }
  }, []);

  const handleManualTopup = () => {
    setTopupSource("billing_page");
    setIsTopupOpen(true);
  };

  const hasPaidHistory = balance?.hasPurchaseHistory === true;
  const paidPercentUsed =
    balance?.paidPercentRemaining != null
      ? 100 - balance.paidPercentRemaining
      : 0;

  return (
    <Card className="border-border/60 py-6 shadow-sm">
      <CardContent className="flex flex-col gap-5 px-4 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              Credit usage
            </p>
            <p className="mt-1 text-sm font-semibold leading-snug">
              Your model credits
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Credits are linked to your user, not the organization.
            </p>
          </div>
          <ErrorBoundary fallback={null}>
            <TopupActionButton onClick={handleManualTopup} />
          </ErrorBoundary>
        </div>

        <UsageRow
          label="Daily limit"
          rightText={
            isLoading || !balance
              ? null
              : `${Math.round(balance.freeDailyPercentUsed)}% used · ${formatCreditResetText(balance.freeDailyResetAt)}`
          }
          fillPercent={
            isLoading || !balance ? 0 : balance.freeDailyPercentUsed
          }
          isLoading={isLoading}
          testId="usage-daily"
        />

        {!isLoading && hasPaidHistory && balance && (
          <UsageRow
            label="Paid credits"
            rightText={
              balance.paidPercentRemaining != null
                ? `${Math.round(100 - balance.paidPercentRemaining)}% used`
                : null
            }
            fillPercent={paidPercentUsed}
            isLoading={false}
            testId="usage-paid"
          />
        )}
      </CardContent>
      {isTopupOpen && (
        <CreditTopupDialog
          open
          onOpenChange={setIsTopupOpen}
          chatSessionId={chatSessionId ?? ""}
          lastUserMessage=""
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
}

function UsageRow({
  label,
  rightText,
  fillPercent,
  isLoading,
  testId,
}: UsageRowProps) {
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {isLoading || rightText == null ? (
            <Skeleton className="h-3 w-24" />
          ) : (
            rightText
          )}
        </span>
      </div>
      {isLoading ? (
        <Skeleton className="h-2 w-full rounded-full" />
      ) : (
        <Progress value={fillPercent} />
      )}
    </div>
  );
}
