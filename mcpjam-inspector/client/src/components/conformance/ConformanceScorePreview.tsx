/**
 * Decorative "overall score" card for the pre-run state: what a clean run
 * reads like. Nothing here is a real result.
 */

const SUITES = ["Protocol", "Apps", "Tasks", "OAuth"] as const;
const TOTAL_CHECKS = 8;

export function ConformanceScorePreview() {
  return (
    <div
      aria-hidden="true"
      className="flex w-75 shrink-0 select-none flex-col gap-3 rounded-lg border border-border bg-popover px-4 pt-3.5 pb-3"
    >
      <div className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
        OVERALL SCORE
      </div>
      <div className="flex items-end gap-2">
        <div className="flex items-start">
          <span className="text-[32px] leading-8 font-semibold tracking-[-0.03em] tabular-nums">
            100
          </span>
          <span className="pt-0.5 text-sm font-semibold text-muted-foreground">
            %
          </span>
        </div>
        <span className="pb-0.75 text-xs font-medium text-muted-foreground tabular-nums">
          {TOTAL_CHECKS}/{TOTAL_CHECKS}
        </span>
      </div>
      <div className="flex flex-col border-t border-border/60 pt-1.5">
        {SUITES.map((suite) => (
          <div key={suite} className="flex h-6.5 items-center gap-3">
            <span className="grow text-[13px] font-medium">{suite}</span>
            <span className="flex h-4.5 shrink-0 items-center rounded-sm bg-emerald-500/15 px-1.5 text-[11px] font-semibold tracking-[0.04em] text-emerald-700 dark:text-emerald-400">
              PASSED
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
