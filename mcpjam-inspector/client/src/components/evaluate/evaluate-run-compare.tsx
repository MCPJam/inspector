/**
 * Evaluate (New) compare picker. This run is fixed; the reader picks the
 * other side. Confirming calls `onSelect` so the parent can set
 * `compareToRunId` and mount the existing RunDiffView.
 */
import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { evalSurfaceRowHoverClass } from "../evals/eval-surface-chrome";
import { formatRelativeTime, formatRunId } from "../evals/helpers";
import { RunContextChip } from "../evals/run-context-chip";
import { toPercent } from "../evals/suite-overview-presentation";
import type { EvalSuiteRun } from "../evals/types";

export function EvaluateRunCompare({
  thisRun,
  otherRuns,
  defaultOtherRunId,
  hostNamesById,
  onSelect,
  onCancel,
}: {
  thisRun: EvalSuiteRun;
  otherRuns: readonly EvalSuiteRun[];
  defaultOtherRunId: string | null;
  hostNamesById: Map<string, string | null>;
  onSelect: (baseRunId: string) => void;
  onCancel: () => void;
}) {
  const initialId =
    (defaultOtherRunId &&
      otherRuns.some((run) => run._id === defaultOtherRunId) &&
      defaultOtherRunId) ||
    otherRuns[0]?._id ||
    null;
  const [selectedId, setSelectedId] = useState<string | null>(initialId);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="evaluate-run-compare"
    >
      <div className="border-b border-border/30 px-5 py-4">
        <p className="text-sm text-foreground">
          Compare{" "}
          <span className="font-mono font-semibold">
            Run {formatRunId(thisRun._id)}
          </span>{" "}
          against another run.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          This run stays on one side. Pick the baseline.
        </p>
      </div>

      {otherRuns.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          Need at least two runs to compare.
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {otherRuns.map((run) => {
            const selected = run._id === selectedId;
            const passRate = run.summary?.passRate;
            const when = formatRelativeTime(
              run.completedAt ?? run.createdAt,
            );
            return (
              <li key={run._id}>
                <button
                  type="button"
                  data-testid={`evaluate-run-compare-option-${run._id}`}
                  aria-pressed={selected}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 border-b border-border/25 px-5 py-3 text-left",
                    evalSurfaceRowHoverClass,
                    selected && "bg-muted/70 dark:bg-muted/45",
                  )}
                  onClick={() => setSelectedId(run._id)}
                >
                  <div className="min-w-0">
                    <div className="font-mono text-sm font-semibold text-foreground">
                      Run {formatRunId(run._id)}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{when}</span>
                      <RunContextChip
                        run={run}
                        hostNamesById={hostNamesById}
                        className="gap-1 px-1.5 py-0 text-[11px] shadow-none"
                      />
                    </div>
                  </div>
                  <span className="shrink-0 text-sm tabular-nums text-foreground">
                    {passRate != null ? `${toPercent(passRate)}%` : "—"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border/30 px-5 py-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!selectedId}
          data-testid="evaluate-run-compare-confirm"
          onClick={() => {
            if (selectedId) onSelect(selectedId);
          }}
        >
          Compare
        </Button>
      </div>
    </div>
  );
}
