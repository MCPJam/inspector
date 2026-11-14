/**
 * How far one result still holds, apart from the directory's severity and
 * from how MCPJam knows: established, inconclusive, stale with the answers
 * that changed, not tested or blocked with the reason. Small on purpose, so
 * every view of a finding (the results under a field, a finding's own
 * detail) says it the same way.
 */
import { createContext, useContext } from "react";
import type {
  DirectoryEvidenceStatus,
  PlacedFinding,
} from "@mcpjam/sdk/browser";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@mcpjam/design-system/cn";

export const EVIDENCE_LABELS: Record<DirectoryEvidenceStatus, string> = {
  established: "Established",
  inconclusive: "Inconclusive",
  stale: "Stale",
  "not-tested": "Not tested",
  blocked: "Blocked",
};

/** The open flow's field labels, for a result that names the answers it read. */
export const FieldLabels = createContext<(key: string) => string>((key) => key);

/** Dashed unless the run reached a result that still holds. */
export function EvidenceStatusBadge({
  status,
}: {
  status: DirectoryEvidenceStatus;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(status !== "established" && "border-dashed")}
    >
      {EVIDENCE_LABELS[status]}
    </Badge>
  );
}

/** "A", "A and B", "A, B and C". */
function listOf(items: readonly string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * Why a result is not established, as one sentence, or nothing when it is.
 * The engine words a reason as a clause ("the server could not be reached:
 * fetch failed"); a failed dependency prefixes it with "blocked: ".
 */
export function evidenceNote(
  entry: PlacedFinding,
  labelOf: (key: string) => string,
): string | undefined {
  const reason = (entry.finding.notEvaluatedReason ?? "")
    .replace(/^blocked:\s*/i, "")
    .replace(/[\s.]+$/, "");
  switch (entry.evidenceStatus) {
    case "stale": {
      const changed = listOf((entry.staleBecause ?? []).map(labelOf));
      return `${changed || "An answer it read"} changed after this run. Run checks again to update it.`;
    }
    case "blocked":
      return reason
        ? `Blocked because ${reason}. Run checks again once that is fixed.`
        : "Blocked because a check it depends on did not finish in this run. Run checks again to retry both.";
    case "not-tested":
      return reason
        ? `Not tested because ${reason}.`
        : "This run did not test it.";
    case "inconclusive":
      return "The model that flagged this was unsure. Check the text yourself before you change it.";
    default:
      return undefined;
  }
}

export function EvidenceNote({ entry }: { entry: PlacedFinding }) {
  const note = evidenceNote(entry, useContext(FieldLabels));
  return note ? (
    <p className="mt-1 text-xs text-muted-foreground">{note}</p>
  ) : null;
}
