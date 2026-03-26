import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatSuitePassRateTrendForDisplay } from "./helpers";

export function PassRateTrendMini({
  rawTrend,
  rowKey,
  compactSummary = false,
}: {
  rawTrend: number[];
  rowKey: string;
  compactSummary?: boolean;
}) {
  const display = formatSuitePassRateTrendForDisplay(rawTrend);
  if (!display || display.percents.length < 3) return null;

  return (
    <div className="flex min-w-0 flex-col items-end gap-0.5">
      {!compactSummary && display.summaryLabel ? (
        <span
          className="max-w-[148px] truncate text-[9px] tabular-nums text-muted-foreground"
          title={display.summaryLabel}
        >
          {display.summaryLabel}
        </span>
      ) : null}
      <div className="flex items-end gap-0.5">
        <div className="flex h-5 shrink-0 items-end gap-px">
          {display.percents.map((value, idx) => (
            <div
              key={`${rowKey}-t-${idx}`}
              className={cn(
                "w-1 rounded-sm",
                value >= 80
                  ? "bg-success/50"
                  : value >= 50
                    ? "bg-warning/50"
                    : "bg-red-500/50",
              )}
              style={{ height: `${Math.max(3, (value / 100) * 20)}px` }}
            />
          ))}
        </div>
        {display.showOlderRunsBadge && display.olderHiddenCount > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="mb-0.5 cursor-default text-[9px] font-medium tabular-nums text-muted-foreground">
                +{display.olderHiddenCount}
              </span>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              <p className="text-xs">
                {display.olderPercentsTooltip ?? "Earlier run history"}
              </p>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
