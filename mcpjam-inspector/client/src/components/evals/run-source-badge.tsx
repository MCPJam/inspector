import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import {
  RUN_ORIGIN_META,
  resolveRunProvenance,
  type RunOriginInput,
  type RunProvenanceTier,
} from "@/lib/evals/run-origin";

/**
 * How we know, in the reader's terms. The stamped tier says nothing: the
 * server-stamped source is the ordinary case, and "recorded by the server" on
 * every UI run is noise rather than information.
 */
const PROVENANCE_QUALIFIER: Record<RunProvenanceTier, string> = {
  verified: "Verified by the credential this run authenticated with.",
  declared: "Declared by the launching client.",
  stamped: "",
};

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
 * The tooltip names the LAYER that answered, not the origin's identity. `MCP`
 * arrives both ways — proven by the credential, and declared by whoever called
 * — and calling the proven one "declared" would understate the only row we can
 * actually vouch for.
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
  const { origin, tier } = resolveRunProvenance({
    source,
    launcher,
    attribution,
  });
  const meta = RUN_ORIGIN_META[origin];
  const qualifier = PROVENANCE_QUALIFIER[tier];
  return (
    <Badge
      variant="outline"
      title={qualifier ? `${meta.title}. ${qualifier}` : meta.title}
      // Role tokens only. Per-origin hues would be a package-local accent
      // palette that never follows `tokens.css` — see the note on
      // `RUN_ORIGIN_META`. The label is what distinguishes an origin.
      className={cn(
        "shrink-0 border-border/60 bg-muted/50 px-1.5 py-0 text-[10px] font-normal uppercase tracking-wide text-muted-foreground",
        className,
      )}
    >
      {meta.label}
    </Badge>
  );
}
