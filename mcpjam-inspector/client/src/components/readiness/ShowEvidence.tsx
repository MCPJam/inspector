/**
 * The way from one result to its evidence: the frame provides the opener
 * and each result offers it. Kept apart from the results themselves, which
 * say how a result reads.
 */
import { createContext, useContext } from "react";
import type { PlacedFinding } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";

/** Opens one result's evidence; absent where no submission is open. */
export const OpenEvidence = createContext<
  ((entry: PlacedFinding) => void) | null
>(null);

export function ShowEvidence({ entry }: { entry: PlacedFinding }) {
  const open = useContext(OpenEvidence);
  if (!open) return null;
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      aria-label={`Show evidence for ${entry.finding.title}`}
      className="ml-2 h-auto p-0 text-xs text-ring underline underline-offset-2"
      onClick={() => open(entry)}
    >
      Show evidence
    </Button>
  );
}
