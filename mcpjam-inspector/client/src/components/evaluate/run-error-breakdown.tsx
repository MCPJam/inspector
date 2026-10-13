import { useEffect } from "react";
import { toast } from "@/lib/toast";
import type { RunErrorBreakdown } from "./run-error-breakdown-model";

// Shared across mounts, for the lifetime of this app session.
const toastedRuns = new Set<string>();
const BREAKDOWN_TOAST_DURATION_MS = 20_000;

export function RunErrorBreakdownDescription({
  breakdown,
}: {
  breakdown: RunErrorBreakdown;
}) {
  return (
    <div
      className="mt-1 max-h-[min(16rem,40vh)] overflow-y-auto overscroll-contain"
      tabIndex={0}
      role="region"
      aria-label="Run errors"
      data-testid="run-error-breakdown"
    >
      <ul className="space-y-3">
        {breakdown.groups.map((group) => (
          <li
            key={group.cause}
            data-testid="run-error-group"
            data-cause={group.cause}
          >
            <div className="font-medium text-foreground">
              {group.title} ({group.count}{" "}
              {group.count === 1 ? "result" : "results"})
            </div>
            {group.errors.length > 0 && (
              <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
                {group.errors.map((error) => (
                  <li
                    key={error.message}
                    className="whitespace-pre-wrap break-words"
                  >
                    {error.message}: {error.count}{" "}
                    {error.count === 1 ? "result" : "results"}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function useRunErrorBreakdownToast(
  runId: string,
  breakdown: RunErrorBreakdown | null,
) {
  useEffect(() => {
    if (!breakdown || toastedRuns.has(runId)) return;
    toast.warning(breakdown.headline, {
      id: `run-error-breakdown-${runId}`,
      description: <RunErrorBreakdownDescription breakdown={breakdown} />,
      duration: BREAKDOWN_TOAST_DURATION_MS,
      closeButton: true,
    });
    toastedRuns.add(runId);
  }, [runId, breakdown]);
}
