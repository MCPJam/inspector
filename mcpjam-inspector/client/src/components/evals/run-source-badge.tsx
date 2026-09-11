import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import {
  RUN_ORIGIN_META,
  resolveRunOriginDetail,
  runOriginTitle,
  type RunOriginInput,
} from "@/lib/evals/run-origin";

/**
 * What LAUNCHED a run, as metadata rather than as a separate surface.
 *
 * The unified runs table mixes origins in one list, so origin has to be
 * readable per row — and `source` alone stopped being able to say: it is
 * stamped server-side, so a CLI run, a GitHub Actions job and an MCP agent all
 * arrive as `api`. The resolution and the label table moved to
 * `lib/evals/run-origin.ts`, which the filter chips and the suite-detail label
 * read from too; three hand-copied lists is how the chips came to offer values
 * this badge could not render.
 */
export function RunSourceBadge({
  run,
  className,
}: {
  /**
   * The run row. A backend that predates run provenance sends only `source`,
   * and `resolveRunOrigin` still answers for those rows — hence a whole row
   * rather than one field, and every field read defensively.
   */
  run: RunOriginInput;
  className?: string;
}) {
  // The BASIS, not just the value: an `mcp` run resolved from verified
  // attribution and one resolved from a client's own claim are the same badge
  // and must not carry the same tooltip.
  const resolved = resolveRunOriginDetail(run);
  const meta = RUN_ORIGIN_META[resolved?.origin ?? "ui"] ?? RUN_ORIGIN_META.ui;
  return (
    <Badge
      variant="outline"
      title={runOriginTitle(resolved?.origin, resolved?.basis)}
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
