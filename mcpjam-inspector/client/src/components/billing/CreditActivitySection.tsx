import { Card, CardContent } from "@mcpjam/design-system/card";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { useCreditActivity } from "@/hooks/useCreditActivity";

const formatDate = (epochMs: number): string => {
  try {
    return new Date(epochMs).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
};

const formatCredits = (n: number): string => {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toLocaleString()} credits`;
};

/**
 * Credit-count activity (allowance grants incl. prorated seat-adds, and
 * seat-drop claw-backs). Separate from the dollar Payment history — credits and
 * money are different units, so they live in their own section.
 */
export function CreditActivitySection({
  organizationId,
  canView = false,
}: {
  organizationId?: string | null;
  canView?: boolean;
}) {
  const { entries, isLoading } = useCreditActivity(
    canView ? organizationId : null
  );
  const safe = entries ?? [];

  if (!canView) return null;

  return (
    <Card className="border-border/60 py-6 shadow-sm">
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Credit activity</h2>
        </div>
        {isLoading ? (
          <LoadingRows />
        ) : safe.length === 0 ? (
          <EmptyState />
        ) : (
          <div
            className="flex max-h-[320px] flex-col gap-2 overflow-y-auto"
            data-testid="credit-activity-list"
          >
            {safe.map((e) => (
              <div
                key={e.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-3"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{e.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(e.createdAt)}
                  </span>
                </div>
                <span
                  className={`text-sm font-medium tabular-nums ${
                    e.kind === "granted"
                      ? "text-emerald-600"
                      : "text-muted-foreground"
                  }`}
                >
                  {formatCredits(e.amountCredits)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <div
      className="flex flex-col items-center rounded-md border border-dashed border-border/60 py-8 text-center"
      data-testid="credit-activity-empty"
    >
      <p className="text-sm text-muted-foreground">No credit activity yet.</p>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-2" data-testid="credit-activity-loading">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}
