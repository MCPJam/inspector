import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import type { EvalSuiteRun } from "./types";

/**
 * What LAUNCHED a run, as metadata rather than as a separate surface.
 *
 * The unified runs table mixes origins in one list, so origin has to be
 * readable per row. `testSuiteRun.source` is already the five-value union
 * this takes (`types.ts` — no prop widening needed); `undefined` is a legacy
 * row from before the field existed, and every reader treats those as `ui`
 * (see `getRunMetricSource`).
 *
 * Muted-outline styling mirrors `SuiteSourceBadge`: this is a label on a
 * dense row, not a status. Tints stay on backgrounds and borders at /50 so
 * the foreground keeps its contrast ratio in both themes.
 */
const SOURCE_META: Record<
  NonNullable<EvalSuiteRun["source"]>,
  { label: string; title: string; className: string }
> = {
  ui: {
    label: "UI",
    title: "Launched from the MCPJam app",
    className: "border-border/60 bg-muted/50 text-muted-foreground",
  },
  sdk: {
    label: "SDK",
    title: "Reported by the MCPJam SDK (CI or local test run)",
    className:
      "border-primary/50 bg-primary/10 text-foreground dark:bg-primary/15",
  },
  api: {
    label: "API",
    title: "Launched via the public /v1 API",
    className:
      "border-sky-500/50 bg-sky-500/10 text-foreground dark:bg-sky-500/15",
  },
  schedule: {
    label: "Scheduled",
    title: "Launched by a schedule",
    className:
      "border-amber-500/50 bg-amber-500/10 text-foreground dark:bg-amber-500/15",
  },
  github_check: {
    label: "GitHub",
    title: "Launched by a GitHub pull-request check",
    className:
      "border-violet-500/50 bg-violet-500/10 text-foreground dark:bg-violet-500/15",
  },
};

export function RunSourceBadge({
  source,
  className,
}: {
  source?: EvalSuiteRun["source"];
  className?: string;
}) {
  const meta = SOURCE_META[source ?? "ui"] ?? SOURCE_META.ui;
  return (
    <Badge
      variant="outline"
      title={meta.title}
      className={cn(
        "shrink-0 px-1.5 py-0 text-[10px] font-normal uppercase tracking-wide",
        meta.className,
        className,
      )}
    >
      {meta.label}
    </Badge>
  );
}
