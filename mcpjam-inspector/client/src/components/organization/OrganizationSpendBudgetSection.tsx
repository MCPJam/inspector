import { useEffect, useMemo, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@mcpjam/design-system/card";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Loader2, Wallet } from "lucide-react";
import { useOrgModelUsageSummary } from "@/hooks/use-org-model-config";
import {
  creditsToUsdString,
  usdStringToCredits,
  useOrgSpendBudget,
} from "@/hooks/useOrgSpendBudget";
import { UsageSummaryCard } from "./OrganizationModelsSection";

/**
 * The organization's spend budget: a ceiling on MCPJam-billed spend per
 * billing window, with alert thresholds.
 *
 * SELF-ENFORCES AVAILABILITY, like the Slack, Discord and Observability
 * sections do: the nav strip hides the entry for a personal org, but someone
 * who types `/organizations/:id/budget` bypasses the strip entirely. The
 * check is the SERVER's answer (`supported`), not a client flag.
 *
 * MUST BE RENDERED INSIDE AN `ErrorBoundary`. `useOrgSpendBudget` re-throws
 * query errors during render — see its docblock.
 */

interface OrganizationSpendBudgetSectionProps {
  organizationId: string;
  /** Org admin or owner. Members get a read-only view. */
  isAdmin: boolean;
}

/** The window's end, as a date a person reads rather than a timestamp. */
function formatResetDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function OrganizationSpendBudgetSection({
  organizationId,
  isAdmin,
}: OrganizationSpendBudgetSectionProps) {
  const {
    budget,
    isLoading,
    querySkipped,
    error,
    isSaving,
    setBudget,
    clearBudget,
  } = useOrgSpendBudget(organizationId);
  const { summary: usageSummary, isLoading: isUsageLoading } =
    useOrgModelUsageSummary(organizationId);

  const [capInput, setCapInput] = useState("");
  const [alertInput, setAlertInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Seed the form from the server's answer once it arrives, and re-seed
  // whenever it changes underneath (another admin saving, or a clear).
  useEffect(() => {
    if (!budget) return;
    setCapInput(
      budget.capCredits === null ? "" : creditsToUsdString(budget.capCredits),
    );
    setAlertInput(budget.alertPercents.join(", "));
  }, [budget?.capCredits, budget?.alertPercents.join(",")]);

  const meter = useMemo(() => {
    if (!budget || budget.capCredits === null) return null;
    const cap = budget.capCredits;
    const spent = budget.consumedCredits;
    return {
      cap,
      spent,
      // Clamped for the BAR only: a debit can overshoot the cap, because the
      // pre-check admits before the provider's real cost is known. The
      // numbers beside it stay truthful.
      percent: Math.min(100, cap > 0 ? (spent / cap) * 100 : 0),
      atCap: spent >= cap,
    };
  }, [budget]);

  // NOBODY ASKED, so nothing is coming. The query is skipped for a guest and
  // stays skipped, so treating `budget === undefined` as pending spun forever
  // on the one audience that has a real answer waiting: a personal org cannot
  // carry a budget, and saying so is the answer.
  if (querySkipped) {
    return (
      <Card className="space-y-2 p-6">
        <h2 className="text-base font-semibold">Spend budget</h2>
        <p className="text-sm text-muted-foreground">
          Personal organizations cannot set a spend budget.
        </p>
      </Card>
    );
  }

  // `undefined` is "not asked yet", never "no". Rendering nothing while the
  // answer is in flight is right; treating it as unsupported would blank the
  // page for an admin who cold-loads this URL.
  if (isLoading || budget === undefined) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading budget...
        </div>
      </Card>
    );
  }

  // A RESOLVED "no" gets a sentence, not a blank page.
  if (!budget.supported) {
    return (
      <Card className="space-y-2 p-6">
        <h2 className="text-base font-semibold">Spend budget</h2>
        <p className="text-sm text-muted-foreground">
          Personal organizations cannot set a spend budget.
        </p>
      </Card>
    );
  }

  const handleSave = async () => {
    setFormError(null);
    const capCredits = usdStringToCredits(capInput);
    if (capCredits === null) {
      setFormError("Enter a budget amount in dollars, for example 50.");
      return;
    }
    if (
      capCredits < budget.minCapCredits ||
      capCredits > budget.maxCapCredits
    ) {
      setFormError(
        `The budget must be between $${creditsToUsdString(budget.minCapCredits)} and $${creditsToUsdString(budget.maxCapCredits)}.`,
      );
      return;
    }

    const alertPercents = alertInput
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => Number(part));
    if (alertPercents.some((p) => !Number.isInteger(p) || p < 1 || p > 99)) {
      setFormError(
        "Alert thresholds must be whole percents between 1 and 99, separated by commas.",
      );
      return;
    }
    if (alertPercents.length > budget.maxAlertCount) {
      setFormError(`At most ${budget.maxAlertCount} alert thresholds.`);
      return;
    }

    try {
      await setBudget({ capCredits, alertPercents });
    } catch {
      // Surfaced by `error` from the hook.
    }
  };

  return (
    <div className="space-y-4">
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xl">
            <Wallet className="size-4 text-muted-foreground" />
            Spend budget
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            A ceiling on what this organization can spend on MCPJam-billed work
            — chat, evals, judges and computer time — each billing period. Runs
            using your own API keys are never counted or blocked.
          </p>
        </CardHeader>

        <CardContent className="space-y-5 pt-0">
          {meter ? (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-4">
                <div className="text-2xl font-semibold tabular-nums">
                  ${creditsToUsdString(meter.spent)}
                  <span className="text-base font-normal text-muted-foreground">
                    {" "}
                    of ${creditsToUsdString(meter.cap)}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">
                  Resets {formatResetDate(budget.windowEndsAt)}
                </div>
              </div>
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={
                    meter.atCap
                      ? "h-full rounded-full bg-destructive"
                      : "h-full rounded-full bg-primary"
                  }
                  style={{ width: `${meter.percent}%` }}
                />
                {/* Where the FIRST alert fires, so the meter shows the mark
                    rather than only the total. The backend stores these
                    deduped and ascending, so `[0]` is already the lowest —
                    taking the minimum outright says so without the reader
                    having to go confirm it. */}
                {budget.alertPercents.length > 0 ? (
                  <div
                    className="absolute top-0 h-full w-px bg-foreground/40"
                    style={{
                      left: `${Math.min(100, ...budget.alertPercents)}%`,
                    }}
                  />
                ) : null}
              </div>
              {meter.atCap ? (
                <p className="text-sm text-destructive">
                  Budget reached. New MCPJam-billed work is being refused until
                  the period resets or an owner or admin raises the cap.
                </p>
              ) : null}
              {budget.alertedPercents.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Alerted this period at{" "}
                  {budget.alertedPercents.map((p) => `${p}%`).join(", ")}.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border/60 px-3 py-4 text-sm text-muted-foreground">
              No budget is set — this organization is uncapped.
            </div>
          )}

          <div className="rounded-md border border-border/40 px-3 py-2 text-xs text-muted-foreground">
            When the budget is reached, new chat turns, eval runs and computer
            starts are refused. Work already in flight finishes, and running
            computers keep going until they hibernate. The free daily allowance
            is unaffected.
          </div>

          {isAdmin ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="spend-budget-cap">Budget (USD)</Label>
                  <Input
                    id="spend-budget-cap"
                    inputMode="decimal"
                    placeholder="50.00"
                    value={capInput}
                    onChange={(e) => setCapInput(e.target.value)}
                    disabled={isSaving}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="spend-budget-alerts">
                    Alert at (% of budget)
                  </Label>
                  <Input
                    id="spend-budget-alerts"
                    placeholder="80"
                    value={alertInput}
                    onChange={(e) => setAlertInput(e.target.value)}
                    disabled={isSaving}
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma-separated. Reaching the budget always alerts.
                  </p>
                </div>
              </div>

              {(formError ?? error) ? (
                <p className="text-sm text-destructive">{formError ?? error}</p>
              ) : null}

              <div className="flex items-center gap-2">
                <Button type="button" onClick={handleSave} disabled={isSaving}>
                  {isSaving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  Save budget
                </Button>
                {budget.capCredits !== null ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      // `clearBudget` records the failure and re-throws, so a
                      // bare `void` would leave an unhandled rejection behind
                      // an error the admin can already see. The inline message
                      // IS the handling.
                      void clearBudget().catch(() => undefined);
                    }}
                    disabled={isSaving}
                  >
                    Remove budget
                  </Button>
                ) : null}
              </div>

              {budget.updatedAt ? (
                <p className="text-xs text-muted-foreground">
                  Last changed {formatResetDate(budget.updatedAt)}.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Only owners and admins can change the budget.
            </p>
          )}
        </CardContent>
      </Card>

      {/* "What did we spend it on" is the next question after "how much have
          we spent", so the existing 30-day breakdown sits directly beneath the
          meter rather than being rebuilt here. */}
      <UsageSummaryCard summary={usageSummary} isLoading={isUsageLoading} />
    </div>
  );
}
