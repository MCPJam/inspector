import { useEffect, useState } from "react";
import { Info } from "lucide-react";
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
import { formatCreditResetText } from "@/lib/credit-usage";
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
      `${window.location.pathname}${nextSearch}`,
    );
    return true;
  }

  return false;
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
  // global limit modal (`/organizations/{id}/billing?topup=open`). One-shot:
  // the flag is consumed from the URL so a subsequent reload doesn't reopen.
  // Source is recorded as `limit_modal` so the funnel can attribute the
  // top-up back to the limit-hit that triggered the redirect.
  useEffect(() => {
    if (consumeTopupFlag()) {
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

        <ErrorBoundary fallback={null}>
          <PendingCreditTopupsBanner />
        </ErrorBoundary>

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
            tooltip="Paid credits are used only after your daily free quota runs out each day. Your free quota resets every 24 hours."
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
  /** Optional explainer surfaced via an info icon next to the label. */
  tooltip?: string;
}

function UsageRow({
  label,
  rightText,
  fillPercent,
  isLoading,
  testId,
  tooltip,
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
              <TooltipContent className="max-w-xs text-xs">
                {tooltip}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </span>
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
