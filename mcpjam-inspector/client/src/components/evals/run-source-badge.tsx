import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import {
  RUN_ORIGIN_META,
  resolveRunOrigin,
  type RunOriginInput,
} from "@/lib/evals/run-origin";

/**
 * What LAUNCHED a run, as metadata rather than as a separate surface.
 *
 * The unified runs table mixes origins in one list, so origin has to be
 * readable per row — and `source` alone cannot say it: everything reaching the
 * platform through `/api/v1` is stamped `api`, so a CLI run, a GitHub Action
 * and an MCP agent all badged identically. `resolveRunOrigin` folds the three
 * provenance columns into one answer (verified → declared → stamped), and the
 * chip row resolves the SAME way, so a row can never be labelled one thing and
 * filtered as another.
 *
 * Takes the run's provenance fields rather than a bare `source`: the `source`
 * prop is kept as a convenience for the callers that only have that (a legacy
 * row, a projection that predates the columns), and reads exactly as it did
 * before.
 */
export function RunSourceBadge({
  source,
  launcher,
  attribution,
  className,
}: RunOriginInput & { className?: string }) {
  const origin = resolveRunOrigin({ source, launcher, attribution });
  const meta = RUN_ORIGIN_META[origin];
  return (
    <Badge
      variant="outline"
      title={
        meta.declared
          ? `${meta.title}. Declared by the launching client.`
          : meta.title
      }
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
