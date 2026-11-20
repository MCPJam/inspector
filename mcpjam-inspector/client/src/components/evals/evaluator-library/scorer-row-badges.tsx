import { Badge } from "@mcpjam/design-system/badge";
import { BUILT_IN_BADGE } from "../runner-checks";

/**
 * The badges on a suite check's title line. With the evaluator library on, a
 * check that did not come from the library sits in its own card and says
 * Default, so it reads as one more evaluator next to the library ones.
 */
export function ScorerRowBadges({
  kind,
  isDefault,
}: {
  kind: string;
  isDefault: boolean;
}) {
  // A runner check decides nothing, so it wears no role: it is on for every
  // iteration and reports the stage analysis.
  const fixed =
    kind === "observed" ? BUILT_IN_BADGE : kind === "match" ? "Required" : null;
  if (!isDefault && !fixed) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {isDefault ? (
        <Badge variant="outline" className="font-medium text-muted-foreground">
          Default
        </Badge>
      ) : null}
      {fixed ? <Badge variant="outline">{fixed}</Badge> : null}
    </span>
  );
}
