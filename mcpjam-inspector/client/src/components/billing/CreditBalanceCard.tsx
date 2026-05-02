import { useState } from "react";
import { Card, CardContent } from "@mcpjam/design-system/card";
import { Progress } from "@mcpjam/design-system/progress";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { CreditTopupDialog } from "@/components/billing/CreditTopupDialog";
import { TopupActionButton } from "@/components/billing/TopupActionButton";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useCreditBalance } from "@/hooks/useCreditBalance";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const formatResetText = (resetAt: number): string => {
  if (!resetAt || !Number.isFinite(resetAt)) return "resets daily";
  const diffMs = resetAt - Date.now();
  if (diffMs <= 0) return "resets shortly";
  if (diffMs < MS_PER_HOUR) {
    const minutes = Math.max(1, Math.round(diffMs / 60000));
    return `resets in ${minutes}m`;
  }
  if (diffMs < MS_PER_DAY) {
    const hours = Math.max(1, Math.round(diffMs / MS_PER_HOUR));
    return `resets in ${hours}h`;
  }
  return "resets tomorrow";
};

interface CreditBalanceCardProps {
  /** Optional override for the chat session id used by the top-up flow. */
  chatSessionId?: string;
}

export function CreditBalanceCard({
  chatSessionId,
}: CreditBalanceCardProps = {}) {
  const { balance, isLoading } = useCreditBalance();
  const [isTopupOpen, setIsTopupOpen] = useState(false);

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
            <TopupActionButton onClick={() => setIsTopupOpen(true)} />
          </ErrorBoundary>
        </div>

        <UsageRow
          label="Daily limit"
          rightText={
            isLoading || !balance
              ? null
              : `${Math.round(balance.freeDailyPercentUsed)}% used · ${formatResetText(balance.freeDailyResetAt)}`
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
          source="billing_page"
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
