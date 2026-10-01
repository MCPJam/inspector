/**
 * The "most of this run errored" toast. Every string comes from
 * {@link buildRunErrorBreakdown}; this file only lays it out and decides when
 * it fires.
 */
import { useEffect, useRef } from "react";

import { toast } from "@/lib/toast";
import type {
  RunErrorBreakdown as RunErrorBreakdownView,
  RunErrorOwner,
} from "./run-error-breakdown-model";

const OWNER_LABEL: Record<RunErrorOwner, string> = {
  yourServer: "Your server",
  yourTest: "Your test",
  mcpjam: "MCPJam",
  unclear: "Unclear",
};

/** Long enough to read a few groups; the toaster's close button ends it early. */
const BREAKDOWN_TOAST_DURATION_MS = 20_000;

export function RunErrorBreakdownDescription({
  breakdown,
}: {
  breakdown: RunErrorBreakdownView;
}) {
  return (
    <ul className="mt-1 space-y-2" data-testid="run-error-breakdown">
      {breakdown.groups.map((group) => (
        <li
          key={group.cause}
          data-testid="run-error-group"
          data-cause={group.cause}
        >
          <div className="font-medium text-foreground">
            {OWNER_LABEL[group.owner]}: {group.title} ({group.count} of{" "}
            {breakdown.finished})
          </div>
          <div className="text-muted-foreground">{group.nextStep}</div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Toast the breakdown once per run, when it first becomes available.
 *
 * Keyed on the run, not the render: the page re-renders on every poll and on
 * every decision read, and the same run must not toast again each time. The
 * toast id is the run's too, so a remount updates the open toast instead of
 * stacking a second one.
 */
export function useRunErrorBreakdownToast(
  runId: string,
  breakdown: RunErrorBreakdownView | null,
) {
  const toastedRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!breakdown || toastedRunIdRef.current === runId) return;
    toastedRunIdRef.current = runId;
    toast.warning(breakdown.headline, {
      id: `run-error-breakdown-${runId}`,
      description: <RunErrorBreakdownDescription breakdown={breakdown} />,
      duration: BREAKDOWN_TOAST_DURATION_MS,
    });
  }, [runId, breakdown]);
}
