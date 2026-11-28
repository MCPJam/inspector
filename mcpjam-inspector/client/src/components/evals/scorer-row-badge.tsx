import { Badge } from "@mcpjam/design-system/badge";
import { BUILT_IN_BADGE } from "./runner-checks";
import type { ScorerTableRow } from "./suite-scorer-table-model";

/** The fixed badge on a suite check's title line, for the kinds that have one. */
export function ScorerRowBadge({ kind }: { kind: ScorerTableRow["kind"] }) {
  // A runner check decides nothing, so it wears no role: it is on for every
  // iteration and reports the stage analysis.
  const fixed =
    kind === "observed" ? BUILT_IN_BADGE : kind === "match" ? "Required" : null;
  return fixed ? <Badge variant="outline">{fixed}</Badge> : null;
}
